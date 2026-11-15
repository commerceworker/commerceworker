import type {
  ArrayItemType,
  ComponentVariant,
  ContentType,
  DateFormat,
  EntryFields,
  FieldDefinition,
  FieldOption,
  LocaleConfig,
  ResolvedTab,
} from '@commerceworker/domain';
import {
  BLOCK_KEY,
  BLOCK_TYPE_KEY,
  blockVariants,
  conditionMatches,
  describeCondition,
  type FieldState,
  fallbackChain,
  fieldState,
  fieldStates,
  isEmptyValue,
  layoutTabs,
  mimeTypeAllowed,
  nestedFieldsFor,
  normalizeOptions,
  optionLabel,
  optionValue,
  resolveLocalizedValue,
  ruleTarget,
  ruleValueAt,
  SEO_FIELDS,
  sameFieldValue,
  validateEntryFields,
  variantOf,
} from '@commerceworker/domain';
import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent } from '@commerceworker/ui/card';
import { Checkbox } from '@commerceworker/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@commerceworker/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@commerceworker/ui/dropdown-menu';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { cn } from '@commerceworker/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@commerceworker/ui/tabs';
import { Textarea } from '@commerceworker/ui/textarea';
import { ChevronRight, Plus } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AppExtension, TextDirection } from '../lib/management';
import { EntityPicker } from './EntityPicker';
import { ExtensionFrame } from './ExtensionFrame';
import { RichTextEditor } from './RichTextEditor';
import { RequiredMark } from './required-mark';

const SCALAR = new Set(['Symbol', 'Slug', 'Text', 'Integer', 'Number', 'Boolean', 'Date']);

/** A selectable reference target (entry or asset). */
export interface PickOption {
  readonly id: string;
  readonly label: string;
  readonly contentType?: string;
  /** An asset's file type, so a field limited to some types offers only those. */
  readonly mimeType?: string;
}

export interface Pickers {
  readonly entries: PickOption[];
  readonly assets: PickOption[];
}

/**
 * Each locale's text direction, for the inputs that hold its words (Symbol, Text, rich text),
 * nested ones in components and blocks included. Absent until the space config has said.
 */
const DirectionsContext = createContext<Readonly<Record<string, TextDirection>> | undefined>(
  undefined,
);

/**
 * `dir` and `lang` for an input holding `locale`'s words: a screen reader speaks it in its
 * language and the caret runs its way. Only on the value, never on the label or the field's chrome
 * (the admin reads in its own direction).
 */
function useWritingIn(locale: string): { readonly lang: string; readonly dir?: TextDirection } {
  const dir = useContext(DirectionsContext)?.[locale];
  return dir ? { lang: locale, dir } : { lang: locale };
}

/** Per-field, per-locale working state: `{ apiId: { locale: value } }`. */
type Values = Record<string, Record<string, unknown>>;

/** Per-field, per-locale validation messages from the domain validator. */
type FieldErrors = Record<string, string>;

/** The top-level field an issue path starts at: `cards` for `cards[2].title`. */
const topLevel = (path: string): string => path.split(/[.[]/)[0] ?? path;

/** A layout group's key: its tab and its place in the tab. */
const groupKey = (tab: string, index: number): string => `${tab}:${index}`;

function errorKey(apiId: string, locale: string): string {
  return `${apiId}:${locale}`;
}

function fieldsFromValues(
  contentType: ContentType,
  values: Values,
  locales: readonly string[],
  defaultLocale: string,
): EntryFields {
  const out: EntryFields = {};
  for (const f of contentType.fields) {
    const byLocale = values[f.apiId] ?? {};
    const fieldLocales = f.localized ? locales : [defaultLocale];
    const cleaned: Record<string, unknown> = {};
    for (const loc of fieldLocales) {
      const v = byLocale[loc];
      if (v !== undefined && v !== '') cleaned[loc] = v;
    }
    if (Object.keys(cleaned).length > 0) out[f.apiId] = cleaned;
  }
  return out;
}

/**
 * The values the form shows and sends: a field its rules disable shows, and saves, its stored
 * value, which is all the server accepts for it. The edit underneath is kept, so a field that opens
 * again shows what was typed. Applied twice, since restoring a value can open or close another
 * field's rule; two passes settle every rule set that is not a cycle.
 */
function withDisabledKept(
  contentType: ContentType,
  values: Values,
  stored: EntryFields,
  locales: readonly string[],
  defaultLocale: string,
): Values {
  if (!contentType.fields.some((f) => f.rules?.length)) return values;
  let out = values;
  for (let pass = 0; pass < 2; pass++) {
    let next: Values | undefined;
    for (const locale of locales) {
      const states = fieldStates(contentType.fields, out, locale, defaultLocale);
      for (const f of contentType.fields) {
        if (!f.localized && locale !== defaultLocale) continue;
        if (!states.get(f.apiId)?.disabled) continue;
        const kept = stored[f.apiId]?.[locale];
        if (sameFieldValue((next ?? out)[f.apiId]?.[locale], kept)) continue;
        next ??= { ...out };
        next[f.apiId] = { ...next[f.apiId], [locale]: kept };
      }
    }
    if (!next) break;
    out = next;
  }
  return out;
}

/**
 * The fields whose state an edit changed, in words: "Sold to shown. Price read-only." Empty when
 * nothing changed. A field that went from hidden to read-only says both.
 */
export function describeRuleChanges(
  fields: readonly FieldDefinition[],
  before: ReadonlyMap<string, FieldState>,
  after: ReadonlyMap<string, FieldState>,
): string {
  const said: string[] = [];
  for (const f of fields) {
    const was = before.get(f.apiId);
    const now = after.get(f.apiId);
    if (Boolean(was?.hidden) !== Boolean(now?.hidden)) {
      said.push(`${f.name} ${now?.hidden ? 'hidden' : 'shown'}.`);
    }
    if (Boolean(was?.disabled) !== Boolean(now?.disabled) && !now?.hidden) {
      said.push(`${f.name} ${now?.disabled ? 'read-only' : 'editable'}.`);
    }
  }
  return said.join(' ');
}

/** A rule's sibling path in field names: `Hero › Style` for `hero.style`. */
function siblingName(siblings: readonly FieldDefinition[], path: string): string {
  const names: string[] = [];
  let level: readonly FieldDefinition[] | undefined = siblings;
  for (const segment of path.split('.')) {
    const found: FieldDefinition | undefined = level?.find((f) => f.apiId === segment);
    names.push(found?.name ?? segment);
    level = found?.type === 'Component' ? found.fields : undefined;
  }
  return names.join(' › ');
}

/**
 * The conditions of a field's `action` rules that hold, in the names an editor sees
 * (`Status is "sold"`).
 */
function heldConditions(
  field: FieldDefinition,
  siblings: readonly FieldDefinition[],
  values: Readonly<Record<string, unknown>>,
  action: 'hide' | 'disable',
): string[] {
  return (field.rules ?? [])
    .filter(
      (r) => r.action === action && conditionMatches(r.when, ruleValueAt(values, r.when.field)),
    )
    .map((r) =>
      describeCondition({
        ...r.when,
        field: ruleTarget(siblings, r.when.field)
          ? siblingName(siblings, r.when.field)
          : r.when.field,
      }),
    );
}

/**
 * Why a field is read-only, for the helper line under it: the disabling conditions that hold, in
 * the names an editor sees ("Read-only while Status is "sold"").
 */
function disabledReason(
  field: FieldDefinition,
  siblings: readonly FieldDefinition[],
  values: Readonly<Record<string, unknown>>,
): string {
  const held = heldConditions(field, siblings, values, 'disable');
  return held.length ? `Read-only while ${held.join(' and ')}` : 'Read-only';
}

function issuesToErrors(
  issues: ReturnType<typeof validateEntryFields>,
  defaultLocale: string,
): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const locale = issue.locale ?? defaultLocale;
    out[errorKey(issue.field, locale)] = issue.message;
  }
  return out;
}

function formatFallbackPreview(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 80 ? `${value.slice(0, 77)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '…';
}

function fallbackHint(
  field: FieldDefinition,
  values: Values,
  locale: string,
  localeConfig: LocaleConfig,
): string | undefined {
  if (!field.localized || locale === localeConfig.defaultLocale) return undefined;
  const byLocale = values[field.apiId] ?? {};
  const current = byLocale[locale];
  if (current !== undefined && current !== '') return undefined;

  const resolved = resolveLocalizedValue(byLocale, localeConfig, locale);
  if (resolved === undefined) return undefined;

  for (const loc of fallbackChain(localeConfig, locale)) {
    if (loc === locale) continue;
    const v = byLocale[loc];
    if (v !== undefined && v !== null && v !== '') {
      return `Falls back to ${loc}: ${formatFallbackPreview(v)}`;
    }
  }
  return undefined;
}

/**
 * Turns a validation path into something an editor can act on.
 *
 * The domain reports `cards[2].title`; the summary says "Cards 3 › Title". A
 * path is a precise address and a poor instruction — and the summary exists to
 * send someone to the right place, so it has to read like directions. A block
 * is named by its type as well ("Body 2 (Hero) › Heading"), read from the
 * value being edited, since which shape sits at an index is up to the editor.
 * Falls back to the raw segment wherever the definition cannot be resolved.
 */
function labelForPath(
  fields: readonly FieldDefinition[],
  path: string,
  values: Record<string, unknown> = {},
): string {
  const parts: string[] = [];
  let defs: readonly FieldDefinition[] | undefined = fields;
  let value: unknown = values;

  for (const segment of path.split('.')) {
    const match = /^([^[]+)(?:\[(\d+)\])?$/.exec(segment);
    const apiId = match?.[1] ?? segment;
    const found: FieldDefinition | undefined = defs?.find((f) => f.apiId === apiId);
    const index = match?.[2];
    value = asObject(value)[apiId];
    if (index !== undefined) value = Array.isArray(value) ? value[+index] : undefined;
    const name = found?.name ?? apiId;
    const variants = found ? blockVariants(found) : undefined;
    const variant = variants && index !== undefined ? variantOf(variants, value) : undefined;
    // 1-based: the third card is "3" to everyone except a programmer.
    parts.push(
      index === undefined ? name : `${name} ${+index + 1}${variant ? ` (${variant.name})` : ''}`,
    );
    defs = found ? nestedFieldsFor(found, value) : undefined;
  }
  return parts.join(' › ');
}

const cloneInitial = (initial: EntryFields): Values => {
  const out: Values = {};
  for (const [apiId, byLocale] of Object.entries(initial)) {
    out[apiId] = { ...(byLocale as Record<string, unknown>) };
  }
  return out;
};

/**
 * A form generated from a content type's field definitions. Localized fields are
 * edited per-locale via tabs; non-localized fields are edited once (on the default
 * locale tab). Emits the localized `EntryFields` shape, dropping empty values.
 */
/** The entry being edited, posted to field-editor extensions for context. */
export interface EntryContext {
  readonly spaceId: string;
  readonly environmentId: string;
  readonly entryId?: string;
  readonly contentType?: string;
}

export function EntryForm(props: {
  contentType: ContentType;
  initial: EntryFields;
  locales: readonly string[];
  defaultLocale: string;
  fallbacks?: Readonly<Record<string, string | null>>;
  /**
   * Each locale's text direction: the inputs holding its words take it as `dir`, with the locale
   * as `lang` (Arabic and Hebrew run `rtl`).
   */
  directions?: Readonly<Record<string, TextDirection>>;
  /**
   * Whether Delivery serves each locale: one it doesn't is still written and previewed, and its
   * tab says "Not delivered". Absent until the space config has said.
   */
  delivered?: Readonly<Record<string, boolean>>;
  pickers: Pickers;
  /** Installed custom field editors; the first matching a field's type replaces its input. */
  fieldEditors?: readonly AppExtension[];
  /**
   * Resolves entry matches server-side for reference fields.
   *
   * Without it the picker filters the seeded options, which cannot reach an
   * entry beyond the list endpoint's page.
   */
  onSearchEntries?: (query: string, contentTypes?: readonly string[]) => Promise<PickOption[]>;
  entryContext?: EntryContext;
  busy?: boolean;
  /** DOM id for the form element, so external buttons can submit via `form=`. */
  formId?: string;
  /** Hides the built-in Save/Cancel row when the parent renders its own actions. */
  hideActions?: boolean;
  /** Reports edits so the parent can guard navigation against unsaved changes. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Called when a submit is rejected by validation, so actions living outside
   * the form (header Save/Publish) can give feedback at the point of action. */
  onValidationFailed?: (errorCount: number) => void;
  /** External field values (AI generation/canvas/assist) merged into the live
   * form state per locale — never remounts, so other unsaved edits survive. */
  mergePatch?: { seq: number; fields: EntryFields } | null;
  /**
   * A field to open on, from an inline-edit deep link. Applied once, on mount:
   * afterwards it is the editor's own state, and re-applying it would yank
   * focus back from wherever the editor has since moved.
   */
  focusField?: { apiId: string; locale?: string };
  /**
   * The form's live values (as a save would send them) and the locale tab it is on, after every
   * change: the side pane's preview draws the draft from these.
   */
  onValuesChange?: (fields: EntryFields, locale: string) => void;
  onSave: (fields: EntryFields) => void;
  onCancel: () => void;
}) {
  const { contentType, locales, defaultLocale, fallbacks, fieldEditors } = props;
  const [values, setValues] = useState<Values>(() => cloneInitial(props.initial));
  const focusField = props.focusField;
  const [activeLocale, setActiveLocale] = useState(() =>
    focusField?.locale && locales.includes(focusField.locale) ? focusField.locale : defaultLocale,
  );
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only — see the prop's note. Re-running would yank focus back from wherever the editor has since moved.
  useEffect(() => {
    if (!focusField) return;
    const el = document.getElementById(`field-${focusField.apiId}`);
    el?.scrollIntoView({ block: 'center' });
    el?.focus();
  }, []);

  const hasLocalized = useMemo(() => contentType.fields.some((f) => f.localized), [contentType]);

  // What the form shows and sends, with every field its rules disable at its stored value.
  const shown = useMemo(
    () => withDisabledKept(contentType, values, props.initial, locales, defaultLocale),
    [contentType, values, props.initial, locales, defaultLocale],
  );
  // Each top-level field's state in the locale on screen (a non-localized field is only shown
  // on the default locale's tab, where its siblings are read in that locale too).
  const states = useMemo(
    () => fieldStates(contentType.fields, shown, activeLocale, defaultLocale),
    [contentType, shown, activeLocale, defaultLocale],
  );

  // What an edit did to other fields, said once for a screen reader: a field appearing,
  // disappearing or turning read-only moves the form under a reader who can't see it move.
  const [ruleNews, setRuleNews] = useState('');
  const lastStates = useRef({ locale: activeLocale, states });
  useEffect(() => {
    const before = lastStates.current;
    lastStates.current = { locale: activeLocale, states };
    // A locale switch redraws the form; it is not an edit's consequence.
    if (before.locale !== activeLocale || before.states === states) return;
    const news = describeRuleChanges(contentType.fields, before.states, states);
    if (news) setRuleNews(news);
  }, [states, activeLocale, contentType.fields]);

  // The layout's tabs and groups; without one, a single tab of every field (drawn without a bar).
  const tabs = useMemo(
    () => layoutTabs(contentType.fields, contentType.layout),
    [contentType.fields, contentType.layout],
  );
  /** Each top-level field's tab, and the collapsed group holding it, if any. */
  const { tabOf, groupOf } = useMemo(() => {
    const tabOf = new Map<string, string>();
    const groupOf = new Map<string, string>();
    for (const t of tabs) {
      t.groups.forEach((g, gi) => {
        for (const f of g.fields) {
          tabOf.set(f.apiId, t.apiId);
          if (g.collapsed) groupOf.set(f.apiId, groupKey(t.apiId, gi));
        }
      });
    }
    return { tabOf, groupOf };
  }, [tabs]);
  const [activeTab, setActiveTab] = useState(
    () => (focusField && tabOf.get(focusField.apiId)) || tabs[0]?.apiId || '',
  );
  // Collapsed groups the editor opened, or that a deep link or an error opened for them.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => {
    const opened = focusField && groupOf.get(focusField.apiId);
    return new Set(opened ? [opened] : []);
  });
  const toggleGroup = (key: string, open: boolean) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  /** Brings a top-level field into view: its tab, and its group when collapsed. */
  const showField = (apiId: string) => {
    const tab = tabOf.get(apiId);
    if (tab) setActiveTab(tab);
    const group = groupOf.get(apiId);
    if (group) toggleGroup(group, true);
  };

  const localeConfig = useMemo<LocaleConfig>(
    () => ({ defaultLocale, locales, fallbacks }),
    [defaultLocale, locales, fallbacks],
  );

  const markDirty = () => props.onDirtyChange?.(true);

  const clearError = (path: string, locale: string) => {
    setFieldErrors((prev) => {
      const key = errorKey(path, locale);
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const set = (apiId: string, locale: string, v: unknown) => {
    clearError(apiId, locale);
    setValues((p) => ({ ...p, [apiId]: { ...p[apiId], [locale]: v } }));
    markDirty();
  };

  // Merge externally produced values (generate/canvas/AI assist) into live state.
  const appliedPatchSeq = useRef(0);
  useEffect(() => {
    const patch = props.mergePatch;
    if (!patch || patch.seq === appliedPatchSeq.current) return;
    appliedPatchSeq.current = patch.seq;
    setValues((p) => {
      const next = { ...p };
      for (const [apiId, byLocale] of Object.entries(patch.fields)) {
        next[apiId] = { ...next[apiId], ...(byLocale as Record<string, unknown>) };
      }
      return next;
    });
    setFieldErrors({});
    props.onDirtyChange?.(true);
  }, [props.mergePatch, props.onDirtyChange]);

  // The preview follows the form: values and the locale tab, as a save would send them.
  const onValuesChange = props.onValuesChange;
  useEffect(() => {
    onValuesChange?.(fieldsFromValues(contentType, shown, locales, defaultLocale), activeLocale);
  }, [onValuesChange, contentType, shown, locales, defaultLocale, activeLocale]);

  // Bumped per rejected submit; scrolls the error summary into view once the
  // errors have rendered (not on every fieldErrors change — typing edits those).
  const [failedSubmits, setFailedSubmits] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failedSubmits === 0) return;
    summaryRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [failedSubmits]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Guard double-submits (rapid ⌘S / Enter): a second createEntry in flight
    // would duplicate the entry.
    if (props.busy) return;
    const out = fieldsFromValues(contentType, shown, locales, defaultLocale);
    // Judged as the server will: against the stored values, which a disabled field keeps.
    const issues = validateEntryFields(contentType, out, {
      defaultLocale,
      locales,
      previous: props.initial,
    });
    if (issues.length > 0) {
      const errors = issuesToErrors(issues, defaultLocale);
      setFieldErrors(errors);
      // If the active locale is clean, jump to the first locale that isn't, so
      // the failure is never invisible (errors on unmounted tabs).
      const errorLocales = new Set(Object.keys(errors).map((k) => k.split(':')[1] ?? ''));
      const errorLocale = errorLocales.has(activeLocale)
        ? activeLocale
        : locales.find((l) => errorLocales.has(l));
      if (errorLocale && errorLocale !== activeLocale) setActiveLocale(errorLocale);
      // The same for tabs: unless the tab on screen holds an error, go to the first that does,
      // and open every collapsed group that holds one.
      const failing = Object.keys(errors)
        .filter((k) => k.split(':')[1] === errorLocale)
        .map((k) => topLevel(k.split(':')[0] ?? ''));
      if (!failing.some((apiId) => tabOf.get(apiId) === activeTab)) {
        const first = tabs.find((t) => failing.some((apiId) => tabOf.get(apiId) === t.apiId));
        if (first) setActiveTab(first.apiId);
      }
      for (const apiId of failing) {
        const group = groupOf.get(apiId);
        if (group) toggleGroup(group, true);
      }
      setFailedSubmits((n) => n + 1);
      props.onValidationFailed?.(issues.length);
      return;
    }
    setFieldErrors({});
    props.onSave(out);
  };

  // Per-locale error counts back the locale-tab badges and the summary list.
  const errorsByLocale = useMemo(() => {
    const out = new Map<string, number>();
    for (const key of Object.keys(fieldErrors)) {
      const loc = key.split(':')[1] ?? defaultLocale;
      out.set(loc, (out.get(loc) ?? 0) + 1);
    }
    return out;
  }, [fieldErrors, defaultLocale]);

  // Per-tab error counts, for the badges on the tab bar.
  const errorsByTab = useMemo(() => {
    const out = new Map<string, number>();
    for (const key of Object.keys(fieldErrors)) {
      const tab = tabOf.get(topLevel(key.split(':')[0] ?? ''));
      if (tab) out.set(tab, (out.get(tab) ?? 0) + 1);
    }
    return out;
  }, [fieldErrors, tabOf]);

  const fieldName = (path: string, locale: string) =>
    labelForPath(
      contentType.fields,
      path,
      Object.fromEntries(
        Object.entries(shown).map(([apiId, byLocale]) => [apiId, byLocale[locale]]),
      ),
    );

  /** The custom editor extension a top-level field of this type is edited with, if any. */
  const editorFor = (f: FieldDefinition) =>
    fieldEditors?.find(
      (e) => !e.fieldTypes || e.fieldTypes.length === 0 || e.fieldTypes.includes(f.type),
    );

  /** The values the top-level rules read in one locale (a shared field's in the default one). */
  const rulesValues = (locale: string) =>
    Object.fromEntries(
      contentType.fields.map((g) => [
        g.apiId,
        shown[g.apiId]?.[g.localized ? locale : defaultLocale],
      ]),
    );

  /** One top-level field, or null when it is not drawn here (hidden, or another locale's). */
  const renderField = (f: FieldDefinition) => {
    // Non-localized fields are only editable on the default-locale tab.
    const locale = f.localized ? activeLocale : defaultLocale;
    if (!f.localized && activeLocale !== defaultLocale) return null;
    const state = states.get(f.apiId);
    const id = `field-${f.apiId}`;
    // A field its rules hide is not drawn; its value stays and is still sent. One that still
    // holds a value is named, so it can be cleared: otherwise a value nobody can see would be
    // stored and delivered, and two fields hiding each other would hide both for good. One its
    // rules also disable keeps that value whatever the form sends, so it is named read-only and
    // offers no Clear that the save would refuse.
    if (state?.hidden) {
      const held = shown[f.apiId]?.[locale];
      if (isEmptyValue(held)) return null;
      const values = rulesValues(locale);
      const reason = heldConditions(f, contentType.fields, values, 'hide');
      const hiddenWhile = reason.length ? ` while ${reason.join(' and ')}` : '';
      if (state.disabled) {
        const locked = heldConditions(f, contentType.fields, values, 'disable');
        return (
          <p
            key={f.apiId}
            id={`${id}-hidden`}
            className="rounded-lg bg-secondary/40 px-3 py-2 text-sm text-muted-foreground"
          >
            <span className="font-medium text-foreground">{f.name}</span> is hidden{hiddenWhile},
            and keeps the value it holds: it is read-only
            {locked.length ? ` while ${locked.join(' and ')}` : ''}.
          </p>
        );
      }
      return (
        <div
          key={f.apiId}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-secondary/40 px-3 py-2 text-sm"
        >
          <p id={`${id}-hidden`} className="text-muted-foreground">
            <span className="font-medium text-foreground">{f.name}</span> is hidden{hiddenWhile},
            but still holds a value.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-describedby={`${id}-hidden`}
            onClick={() => set(f.apiId, locale, undefined)}
          >
            Clear {f.name}
          </Button>
        </div>
      );
    }
    const err = fieldErrors[errorKey(f.apiId, locale)];
    const hint =
      f.localized && locales.length > 1 ? fallbackHint(f, shown, locale, localeConfig) : undefined;
    const helpId = f.help ? `${id}-help` : undefined;
    const ruleId = state?.disabled ? `${id}-rule` : undefined;
    return (
      <div className="space-y-1.5" key={f.apiId}>
        <Label id={`${id}-label`} htmlFor={id} className="gap-1">
          {f.name}
          {f.required && <RequiredMark />}
          {locales.length > 1 && (
            <span className="ml-1 font-normal text-muted-foreground">
              {f.localized ? activeLocale : 'all locales'}
            </span>
          )}
        </Label>
        <DisabledBy state={state} field={f} hasEditor={Boolean(editorFor(f))}>
          <FieldInput
            id={id}
            field={f}
            value={shown[f.apiId]?.[locale]}
            disabled={state?.disabled}
            invalid={Boolean(err)}
            errorId={err ? `${id}-error` : undefined}
            hintId={[helpId, ruleId].filter(Boolean).join(' ') || undefined}
            pickers={props.pickers}
            editor={editorFor(f)}
            editorContext={props.entryContext}
            locale={locale}
            path={f.apiId}
            onSearchEntries={props.onSearchEntries}
            errorFor={(p) => fieldErrors[errorKey(p, locale)]}
            // A nested edit clears its own error, not the whole
            // component's: fixing card 1 must not make card 2 look fine.
            onEdited={(p) => clearError(p, locale)}
            onChange={(v) => set(f.apiId, locale, v)}
          />
        </DisabledBy>
        {f.help && (
          <p id={helpId} className="max-w-measure text-muted-foreground text-xs">
            {f.help}
          </p>
        )}
        {ruleId && (
          <p id={ruleId} className="max-w-measure text-muted-foreground text-xs">
            {disabledReason(f, contentType.fields, rulesValues(locale))}
          </p>
        )}
        {hint && !err && <p className="text-xs text-muted-foreground">{hint}</p>}
        {err && (
          <p id={`${id}-error`} className="text-xs text-destructive">
            {err}
          </p>
        )}
      </div>
    );
  };

  const shared = contentType.fields.filter((f) => !f.localized).length;
  /** One tab of the form: its groups, a named group under its heading (closed ones collapsed). */
  const renderTab = (tab: ResolvedTab) => (
    <Card>
      <CardContent className="space-y-5">
        {activeLocale !== defaultLocale && shared > 0 && (
          <p className="text-muted-foreground text-xs">
            {shared} {shared === 1 ? 'field' : 'fields'} shared across all locales{' '}
            {shared === 1 ? 'is' : 'are'} edited on the {defaultLocale} (default) tab.
          </p>
        )}
        {tab.groups.map((g, gi) => {
          const drawn = g.fields.map(renderField).filter(Boolean);
          // A group with nothing to draw here (hidden, or another locale's) leaves no heading.
          if (drawn.length === 0) return null;
          const key = groupKey(tab.apiId, gi);
          if (!g.name) {
            return (
              <div key={key} className="space-y-5">
                {drawn}
              </div>
            );
          }
          const headingId = `group-${tab.apiId}-${gi}`;
          if (g.collapsed) {
            const open = openGroups.has(key);
            return (
              <Collapsible
                key={key}
                open={open}
                onOpenChange={(next) => toggleGroup(key, next)}
                className="space-y-4 border-t pt-4"
              >
                {/* A heading like an open group's, so a reader moving by headings finds it. */}
                <h3 className="m-0">
                  <CollapsibleTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1.5">
                      <ChevronRight
                        aria-hidden="true"
                        className={cn('size-4 transition-transform', open && 'rotate-90')}
                      />
                      <span className="section-title">{g.name}</span>
                    </Button>
                  </CollapsibleTrigger>
                </h3>
                <CollapsibleContent className="space-y-5">{drawn}</CollapsibleContent>
              </Collapsible>
            );
          }
          return (
            <section key={key} aria-labelledby={headingId} className="space-y-5 border-t pt-4">
              <h3 id={headingId} className="section-title">
                {g.name}
              </h3>
              {drawn}
            </section>
          );
        })}
      </CardContent>
    </Card>
  );

  return (
    <form id={props.formId} onSubmit={submit} className="max-w-2xl space-y-4">
      <DirectionsContext.Provider value={props.directions}>
        <p role="status" aria-live="polite" className="sr-only">
          {ruleNews}
        </p>
        {hasLocalized && locales.length > 1 && (
          // Locale switcher: a segmented row of <button>s (role=button) — component
          // tests select a locale via getByRole('button', { name: 'de-DE' }).
          <div className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
            {locales.map((loc) => {
              const errCount = errorsByLocale.get(loc) ?? 0;
              return (
                <Button
                  type="button"
                  key={loc}
                  size="sm"
                  variant={loc === activeLocale ? 'default' : 'ghost'}
                  onClick={() => setActiveLocale(loc)}
                >
                  {loc}
                  {loc === defaultLocale ? ' (default)' : ''}
                  {props.delivered?.[loc] === false && (
                    <>
                      {' '}
                      {/* In words and ruled in the button's own colour, so it reads on the ink of
                        the chosen tab and the muted row alike. */}
                      <span className="rounded-full border border-current px-1.5 font-normal text-2xs leading-4">
                        Not delivered
                      </span>
                    </>
                  )}
                  <ErrorCount count={errCount} />
                </Button>
              );
            })}
          </div>
        )}

        {tabs.length > 1 ? (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            {/* Start-aligned: centred tabs that overflow push the first out of reach of the scroll. */}
            <TabsList
              aria-label="Sections of the entry"
              className="w-full justify-start overflow-x-auto"
            >
              {tabs.map((t) => {
                const count = errorsByTab.get(t.apiId) ?? 0;
                return (
                  // As wide as its label at least: the touch minimum would otherwise let the tabs
                  // shrink to fit, overlapping their labels instead of scrolling the bar.
                  <TabsTrigger key={t.apiId} value={t.apiId} className="shrink-0 basis-auto px-3">
                    {t.name}
                    <ErrorCount count={count} />
                  </TabsTrigger>
                );
              })}
            </TabsList>
            {tabs.map((t) => (
              <TabsContent key={t.apiId} value={t.apiId}>
                {renderTab(t)}
              </TabsContent>
            ))}
          </Tabs>
        ) : (
          tabs[0] && renderTab(tabs[0])
        )}

        {Object.keys(fieldErrors).length > 0 && (
          <div
            ref={summaryRef}
            role="alert"
            className="space-y-1 rounded-2xl border border-destructive/30 bg-destructive/10 p-3 text-sm"
          >
            <p className="font-medium text-destructive">
              Can’t save yet: {Object.keys(fieldErrors).length}{' '}
              {Object.keys(fieldErrors).length === 1 ? 'field needs' : 'fields need'} attention.
            </p>
            <ul className="space-y-0.5">
              {Object.entries(fieldErrors).map(([key, message]) => {
                const [apiId = '', loc = defaultLocale] = key.split(':');
                const tab = tabOf.get(topLevel(apiId));
                // In view: this locale and tab, and not inside a group that is closed.
                const group = groupOf.get(topLevel(apiId));
                const here =
                  loc === activeLocale &&
                  (tab === undefined || tab === activeTab) &&
                  (group === undefined || openGroups.has(group));
                return (
                  <li key={key} className="text-destructive">
                    {here ? (
                      <span>
                        {fieldName(apiId, loc)} ({loc}): {message}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="underline underline-offset-2"
                        onClick={() => {
                          setActiveLocale(loc);
                          if (tab !== undefined || group !== undefined) showField(topLevel(apiId));
                        }}
                      >
                        {fieldName(apiId, loc)} ({loc}): {message}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {!props.hideActions && (
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={props.busy}>
              Save draft
            </Button>
            <Button type="button" variant="outline" onClick={props.onCancel} disabled={props.busy}>
              Cancel
            </Button>
          </div>
        )}
      </DirectionsContext.Provider>
    </form>
  );
}

/**
 * How many validation errors a locale or tab holds, as a pill beside its name; nothing for none.
 * A bare <span> has no role, and `aria-label` on a roleless element is ignored (the count was
 * announced as a naked number), so visually hidden text is read instead.
 */
function ErrorCount(props: { count: number }) {
  if (props.count <= 0) return null;
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-2xl bg-destructive/15 px-1 text-xs text-destructive">
      {props.count}
      <span className="sr-only">{` validation ${props.count === 1 ? 'error' : 'errors'}`}</span>
    </span>
  );
}

function FieldInput(props: {
  id: string;
  field: FieldDefinition;
  value: unknown;
  /** Read-only by the field's rules. A text, number, date or select control is made read-only
   *  here (focusable, its reason read on focus); a button-like widget is disabled by its
   *  `DisabledBy` fieldset; rich text and an extension are told here. */
  disabled?: boolean;
  invalid?: boolean;
  /** id of the error message element, wired to aria-describedby when invalid. */
  errorId?: string;
  /** id of a helper line under the input, wired to aria-describedby too. */
  hintId?: string;
  pickers: Pickers;
  editor?: AppExtension;
  editorContext?: EntryContext;
  locale: string;
  /** Dotted/indexed path to this value; absent at the top level (= apiId). */
  path?: string;
  /** Looks up the validation message for a nested path, if any. */
  errorFor?: (path: string) => string | undefined;
  /** Reports the exact nested path just edited, so its error can be cleared. */
  onEdited?: (path: string) => void;
  /** Resolves entry matches server-side for Link fields. */
  onSearchEntries?: (query: string, contentTypes?: readonly string[]) => Promise<PickOption[]>;
  onChange: (v: unknown) => void;
}) {
  const { id, field, value, invalid, errorId, onChange, pickers, editor, editorContext, locale } =
    props;
  const writing = useWritingIn(locale);
  const inputClass = invalid ? 'border-destructive focus-visible:ring-destructive/30' : undefined;
  const describedBy = [errorId, props.hintId].filter(Boolean).join(' ') || undefined;
  const readOnly = props.disabled === true;
  const aria = {
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    'aria-readonly': readOnly || undefined,
  };
  // A read-only control keeps focus and its value; what it would change is dropped.
  const change = readOnly ? () => {} : onChange;

  // A custom field editor extension takes over the input entirely (sandboxed iframe).
  if (editor) {
    return (
      <ExtensionFrame
        extension={editor}
        context={{
          target: 'field-editor',
          spaceId: editorContext?.spaceId ?? '',
          environmentId: editorContext?.environmentId ?? '',
          entryId: editorContext?.entryId,
          contentType: editorContext?.contentType,
          field: { apiId: field.apiId, type: field.type, locale },
          value,
          readOnly,
        }}
        onChange={change}
      />
    );
  }

  // A group of nested fields, edited in place. Rendered as a raised fill
  // rather than a nested card — the design system prohibits boxes-in-boxes,
  // and a component is part of the entry, not a separate object.
  if (field.type === 'Component') {
    return (
      <ComponentInput
        id={id}
        fields={field.fields ?? []}
        value={value}
        path={props.path ?? field.apiId}
        errorFor={props.errorFor}
        onEdited={props.onEdited}
        pickers={pickers}
        locale={locale}
        onChange={onChange}
      />
    );
  }

  // Search engine metadata: a component of fixed shape, with what each part is for beside it.
  if (field.type === 'Seo') {
    return (
      <ComponentInput
        id={id}
        fields={SEO_FIELDS}
        hint={seoHint}
        value={value}
        path={props.path ?? field.apiId}
        errorFor={props.errorFor}
        onEdited={props.onEdited}
        pickers={pickers}
        locale={locale}
        onChange={onChange}
      />
    );
  }

  const variants = blockVariants(field);
  if (variants) {
    return (
      <BlocksInput
        id={id}
        label={field.name}
        variants={variants}
        max={field.validations?.size?.max}
        value={value}
        path={props.path ?? field.apiId}
        errorFor={props.errorFor}
        onEdited={props.onEdited}
        pickers={pickers}
        locale={locale}
        onChange={onChange}
      />
    );
  }

  if (field.type === 'Array' && field.items?.type === 'Component') {
    return (
      <RepeaterInput
        id={id}
        label={field.name}
        fields={field.items.fields ?? []}
        value={value}
        path={props.path ?? field.apiId}
        errorFor={props.errorFor}
        onEdited={props.onEdited}
        pickers={pickers}
        locale={locale}
        onChange={onChange}
      />
    );
  }

  // Reference fields: a searchable combobox over entries/assets, stored as
  // { id, linkType }.
  if (field.type === 'Link') {
    const linkType = field.linkType ?? 'Entry';
    const allowed = field.validations?.linkContentTypes as string[] | undefined;
    let options = linkType === 'Asset' ? pickers.assets : pickers.entries;
    if (linkType === 'Entry' && allowed?.length) {
      options = options.filter((o) => !o.contentType || allowed.includes(o.contentType));
    }
    // Only the files the field takes: the server refuses any other on save.
    const mimes = field.validations?.assetMimeTypes;
    if (linkType === 'Asset' && Array.isArray(mimes) && mimes.length > 0) {
      options = options.filter((o) => !o.mimeType || mimeTypeAllowed(o.mimeType, mimes));
    }
    const currentId = (value as { id?: string } | undefined)?.id ?? '';
    return (
      <EntityPicker
        id={id}
        options={options}
        value={currentId}
        placeholder={linkType === 'Asset' ? 'Search assets…' : 'Search entries…'}
        invalid={invalid}
        errorId={describedBy}
        // Entries are matched server-side; the seeded options only fill the
        // list before anyone types. Assets stay client-side: the media library
        // is fetched whole for the picker already, and narrowing to one link
        // type is the change worth making rather than all of them at once.
        {...(linkType === 'Entry' && props.onSearchEntries
          ? {
              onSearch: (q: string) =>
                (props.onSearchEntries as NonNullable<typeof props.onSearchEntries>)(q, allowed),
            }
          : {})}
        onChange={(picked) => onChange(picked ? { id: picked, linkType } : undefined)}
      />
    );
  }

  // Rich text: a Tiptap-backed document editor. Keyed per locale so each
  // locale gets its own editor instance (isolated content and undo history).
  if (field.type === 'RichText') {
    return (
      <RichTextEditor
        key={locale}
        id={id}
        ariaLabelledBy={`${id}-label`}
        ariaDescribedBy={describedBy}
        lang={writing.lang}
        dir={writing.dir}
        readOnly={props.disabled}
        value={value}
        pickers={pickers}
        onChange={onChange}
      />
    );
  }

  // An `in` rule on a scalar: pick from its options by label; the value is what is stored.
  // Normalised for display: a legacy list may repeat a value or hold one a select can't offer.
  const options = SELECTABLE.has(field.type)
    ? normalizeOptions(field.validations?.in, field.type)
    : [];
  if (options.length) {
    return (
      <OptionsInput
        id={id}
        options={options}
        value={value}
        required={field.required}
        aria={aria}
        onChange={change}
      />
    );
  }

  if (field.type === 'Boolean') {
    return (
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          aria-describedby={props.hintId}
          checked={!!value}
          onCheckedChange={(c) => onChange(c === true)}
        />
        <span className="text-muted-foreground text-sm">{value ? 'Yes' : 'No'}</span>
      </div>
    );
  }
  if (field.type === 'Integer' || field.type === 'Number') {
    return (
      <Input
        id={id}
        className={inputClass}
        {...aria}
        type="number"
        readOnly={readOnly}
        placeholder={field.placeholder}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => change(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    );
  }
  if (field.type === 'Date') {
    return (
      <DateInput
        id={id}
        className={inputClass}
        aria={aria}
        readOnly={readOnly}
        format={field.format}
        value={value}
        onChange={change}
      />
    );
  }
  if (field.type === 'Text') {
    return (
      <Textarea
        id={id}
        className={inputClass}
        {...aria}
        {...writing}
        rows={4}
        readOnly={readOnly}
        placeholder={field.placeholder}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => change(e.target.value)}
      />
    );
  }
  if (field.type === 'Slug') {
    return (
      <Input
        id={id}
        className={`${inputClass} font-mono`}
        {...aria}
        // Not normalized as you type: rewriting the value mid-keystroke fights
        // the cursor. The server normalizes on save and returns what it stored.
        readOnly={readOnly}
        placeholder={field.placeholder ?? 'my-post-title'}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => change(e.target.value)}
      />
    );
  }
  if (SCALAR.has(field.type)) {
    return (
      <Input
        id={id}
        className={inputClass}
        {...aria}
        {...writing}
        readOnly={readOnly}
        placeholder={field.placeholder}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => change(e.target.value)}
      />
    );
  }
  if (field.type === 'Array' && field.items?.type === 'Symbol') {
    return (
      <SymbolListInput id={id} label={field.name} aria={aria} value={value} onChange={onChange} />
    );
  }
  if (field.type === 'Array' && field.items && LIST_ITEM_TYPES.has(field.items.type)) {
    return (
      <ScalarListInput
        id={id}
        label={field.name}
        itemType={field.items.type}
        format={field.items.format}
        aria={aria}
        path={props.path ?? field.apiId}
        errorFor={props.errorFor}
        value={value}
        onChange={onChange}
      />
    );
  }
  // Complex types (Array of Links, JSON, Location): raw JSON editor for the MVP.
  return (
    <JsonFieldInput
      id={id}
      inputClass={inputClass}
      aria={aria}
      readOnly={readOnly}
      value={value}
      onChange={change}
    />
  );
}

/** The types an `in` rule is enforced on, so the ones an options picker stands in for. */
const SELECTABLE = new Set(['Symbol', 'Text', 'Integer', 'Number']);

/**
 * A field limited to listed values, picked by label. A `<select>` holds strings, so the choice is
 * mapped back to the option's own value (a number stays a number). A stored value the list no
 * longer offers is kept as a choice of its own, so opening an old entry never blanks it silently.
 */
function OptionsInput(props: {
  id: string;
  options: readonly FieldOption[];
  value: unknown;
  required: boolean;
  aria: { 'aria-invalid'?: boolean; 'aria-describedby'?: string; 'aria-readonly'?: boolean };
  onChange: (v: unknown) => void;
}) {
  const { id, options, value, required, aria, onChange } = props;
  const empty = value === undefined || value === null || value === '';
  const listed = options.some((o) => optionValue(o) === value);
  return (
    <NativeSelect
      id={id}
      wrapperClassName="w-full max-w-sm"
      {...aria}
      value={empty ? '' : String(value)}
      onChange={(e) => {
        if (e.target.value === '') return onChange(undefined);
        const picked = options.find((o) => String(optionValue(o)) === e.target.value);
        onChange(picked === undefined ? value : optionValue(picked));
      }}
    >
      {/* Offered even on a required field: it is how the form starts, and the save says why. */}
      <NativeSelectOption value="">{required ? 'Choose…' : 'None'}</NativeSelectOption>
      {options.map((o) => (
        <NativeSelectOption key={String(optionValue(o))} value={String(optionValue(o))}>
          {optionLabel(o)}
        </NativeSelectOption>
      ))}
      {!empty && !listed && (
        <NativeSelectOption
          value={String(value)}
        >{`${String(value)} (not listed)`}</NativeSelectOption>
      )}
    </NativeSelect>
  );
}

interface NestedProps {
  id: string;
  fields: readonly FieldDefinition[];
  value: unknown;
  path: string;
  errorFor?: (path: string) => string | undefined;
  /** Reports the exact path just edited, so its error can be cleared. */
  onEdited?: (path: string) => void;
  pickers: Pickers;
  locale: string;
  onChange: (v: unknown) => void;
}

/** Search results cut a title and a description short at about these many characters. */
const SEO_SHOWN = { title: 60, description: 160 } as const;

/** The helper line under each part of a Seo field: what it is for, and a length to aim at. */
function seoHint(apiId: string, value: unknown): string | undefined {
  if (apiId === 'title' || apiId === 'description') {
    const shown = SEO_SHOWN[apiId];
    const n = typeof value === 'string' ? value.length : 0;
    return n > 0
      ? `${n} characters; search results show about ${shown}`
      : `Search results show about ${shown} characters`;
  }
  if (apiId === 'canonicalUrl') {
    return 'Only when this page copies another: its path (/guides/setup) or full URL';
  }
  if (apiId === 'noindex') return 'Leaves the page out of search results and the sitemap';
  if (apiId === 'ogImage') return 'Shown when the page is shared';
  return undefined;
}

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Disables every control of a field its rules make read-only, whatever the widget: a disabled
 * fieldset reaches inputs, selects and buttons alike (a picker, a checkbox, a list's Add), and
 * says so to assistive technology. Rich text, which no fieldset reaches, is told through
 * `FieldInput`'s `disabled`. Open fields render without a wrapper.
 */
function DisabledBy(props: {
  state: FieldState | undefined;
  field: FieldDefinition;
  hasEditor?: boolean;
  children: React.ReactNode;
}) {
  if (!props.state?.disabled || locksInPlace(props.field, props.hasEditor)) {
    return <>{props.children}</>;
  }
  return (
    <fieldset disabled className="m-0 min-w-0 border-0 p-0">
      {props.children}
    </fieldset>
  );
}

/**
 * Whether `FieldInput` draws this field as one text, number, date or select control, which it
 * makes read-only itself: it stays in the tab order and reads its reason on focus, where a
 * disabled control is skipped. Button-like widgets (a checkbox, a picker, a list with Add and
 * Remove, nested fields) are disabled by the fieldset instead; an extension is told in its context.
 */
function locksInPlace(field: FieldDefinition, hasEditor = false): boolean {
  if (hasEditor) return true;
  switch (field.type) {
    case 'Component':
    case 'Seo':
    case 'Link':
    case 'Boolean':
    case 'RichText':
      return false;
    case 'Array':
      // A list drawn as raw JSON locks in place; every list editor has buttons.
      return !(
        blockVariants(field) ||
        field.items?.type === 'Component' ||
        field.items?.type === 'Symbol' ||
        (field.items && LIST_ITEM_TYPES.has(field.items.type))
      );
    default:
      return true;
  }
}

/**
 * The nested fields of one component, edited in place.
 *
 * Nested fields carry no locale of their own — the component field decides
 * that once — so every input here inherits the locale its container is being
 * edited under, and the labels do not repeat it.
 */
function ComponentInput(
  props: NestedProps & {
    /** A helper line under a nested field, given its apiId and value. */
    hint?: (apiId: string, value: unknown) => string | undefined;
  },
) {
  const { fields, path, errorFor, onEdited, pickers, locale, onChange, hint } = props;
  const current = asObject(props.value);

  return (
    <div className="space-y-4 rounded-xl bg-secondary/40 p-4">
      {fields.map((f) => {
        // Rules read the siblings inside this component value. Inside a list's element only
        // `hide` can apply: the domain refuses `disable` there.
        const state = fieldState(f, current);
        if (state.hidden) return null;
        const at = `${path}.${f.apiId}`;
        const nestedId = `${props.id}-${f.apiId}`;
        const err = errorFor?.(at);
        const help = hint?.(f.apiId, current[f.apiId]) ?? f.help;
        const ruleId = state.disabled ? `${nestedId}-rule` : undefined;
        return (
          <div key={f.apiId} className="space-y-1.5">
            <Label id={`${nestedId}-label`} htmlFor={nestedId} className="gap-1">
              {f.name}
              {f.required && <RequiredMark />}
            </Label>
            <DisabledBy state={state} field={f}>
              <FieldInput
                id={nestedId}
                field={f}
                value={current[f.apiId]}
                disabled={state.disabled}
                invalid={Boolean(err)}
                errorId={err ? `${nestedId}-error` : undefined}
                hintId={
                  [help ? `${nestedId}-hint` : undefined, ruleId].filter(Boolean).join(' ') ||
                  undefined
                }
                pickers={pickers}
                locale={locale}
                path={at}
                errorFor={errorFor}
                onEdited={onEdited}
                onChange={(v) => {
                  onEdited?.(at);
                  onChange({ ...current, [f.apiId]: v });
                }}
              />
            </DisabledBy>
            {ruleId && (
              <p id={ruleId} className="max-w-measure text-muted-foreground text-xs">
                {disabledReason(f, fields, current)}
              </p>
            )}
            {help && (
              <p
                id={`${nestedId}-hint`}
                className="max-w-measure text-muted-foreground text-xs tabular-nums"
              >
                {help}
              </p>
            )}
            {err && (
              <p id={`${nestedId}-error`} className="text-xs text-destructive">
                {err}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A repeating list of components: the feature-card, timeline, spec-row shape.
 *
 * Every control names the item it acts on ("Remove card 2"), because a column
 * of identical buttons is unusable by keyboard or screen reader otherwise —
 * and removing the wrong card is not a recoverable mistake mid-edit.
 */
function RepeaterInput(props: NestedProps & { label: string }) {
  const { fields, path, errorFor, onEdited, pickers, locale, onChange, label } = props;
  const items = Array.isArray(props.value) ? (props.value as unknown[]) : [];
  const noun = label.replace(/s$/i, '') || 'item';

  const replace = (index: number, item: unknown) =>
    onChange(items.map((existing, i) => (i === index ? item : existing)));

  const move = (index: number, by: number) => {
    const to = index + by;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {items.length === 0 && <p className="text-muted-foreground text-sm">Nothing here yet.</p>}
      {items.map((item, index) => {
        const at = `${path}[${index}]`;
        // Index-based keys: these items have no id of their own, and the list
        // is reordered by explicit action rather than re-sorted underneath.
        const key = `${path}-${index}`;
        return (
          <div key={key} className="space-y-2 rounded-xl bg-secondary/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm">
                {noun} {index + 1}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Move ${noun} ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Move ${noun} ${index + 1} down`}
                  disabled={index === items.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  aria-label={`Remove ${noun} ${index + 1}`}
                  onClick={() => onChange(items.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </div>
            </div>
            <ComponentInput
              id={`${props.id}-${index}`}
              fields={fields}
              value={item}
              path={at}
              errorFor={errorFor}
              onEdited={onEdited}
              pickers={pickers}
              locale={locale}
              onChange={(v) => replace(index, v)}
            />
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, {}])}>
        Add {noun.toLowerCase()}
      </Button>
    </div>
  );
}

/** A new block of a variant, starting from its fields' defaults. */
function newBlock(variant: ComponentVariant): Record<string, unknown> {
  const block: Record<string, unknown> = { [BLOCK_TYPE_KEY]: variant.apiId };
  for (const f of variant.fields) {
    if (f.defaultValue !== undefined) block[f.apiId] = f.defaultValue;
  }
  return block;
}

/**
 * A blocks field: an ordered list of mixed shapes (a hero, then copy, then a
 * call to action), each edited with its own variant's fields.
 *
 * Like the repeater, every control names the block it acts on ("Remove Hero
 * block 1"). A block keeps its `_type` and `_key` through edits because the
 * nested editor spreads the value it was given; a new block has no key until
 * the server assigns one on save. Blocks are keyed by `_key` where they have
 * one, so a reorder moves an editor's state (a rich-text editor's undo history)
 * with its block.
 */
function BlocksInput(
  props: Omit<NestedProps, 'fields'> & {
    label: string;
    variants: readonly ComponentVariant[];
    /** `validations.size.max`: at the cap, adding is turned off rather than refused on save. */
    max?: number;
  },
) {
  const { variants, path, errorFor, onEdited, pickers, locale, onChange, label, max } = props;
  const items = Array.isArray(props.value) ? (props.value as unknown[]) : [];
  const full = max !== undefined && items.length >= max;

  const replace = (index: number, item: unknown) =>
    onChange(items.map((existing, i) => (i === index ? item : existing)));

  const move = (index: number, by: number) => {
    const to = index + by;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {items.length === 0 && <p className="text-muted-foreground text-sm">No blocks yet.</p>}
      {items.map((item, index) => {
        const at = `${path}[${index}]`;
        const variant = variantOf(variants, item);
        const type = asObject(item)[BLOCK_TYPE_KEY];
        const key = asObject(item)[BLOCK_KEY];
        const noun = `${variant?.name ?? 'Unknown'} block ${index + 1}`;
        const err = errorFor?.(at);
        return (
          <div
            key={typeof key === 'string' ? key : `${path}-${index}`}
            className="space-y-2 rounded-xl bg-secondary/40 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm">
                {variant?.name ?? 'Unknown block'}
                <span className="ml-1.5 font-normal text-muted-foreground">{index + 1}</span>
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Move ${noun} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Move ${noun} down`}
                  disabled={index === items.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  aria-label={`Remove ${noun}`}
                  onClick={() => {
                    onEdited?.(at);
                    onChange(items.filter((_, i) => i !== index));
                  }}
                >
                  Remove
                </Button>
              </div>
            </div>
            {variant ? (
              <ComponentInput
                id={`${props.id}-${index}`}
                fields={variant.fields}
                value={item}
                path={at}
                errorFor={errorFor}
                onEdited={onEdited}
                pickers={pickers}
                locale={locale}
                onChange={(v) => replace(index, v)}
              />
            ) : (
              // A block whose type the model no longer declares: there is no
              // shape to edit it by, so it is said plainly and can be removed.
              <p className="text-muted-foreground text-sm">
                {typeof type === 'string'
                  ? `This block’s type “${type}” is not in the content model, so it can’t be edited here.`
                  : 'This block has no type, so it can’t be edited here.'}
              </p>
            )}
            {err && <p className="text-xs text-destructive">{err}</p>}
          </div>
        );
      })}
      {variants.length === 1 && variants[0] ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={full}
          onClick={() => onChange([...items, newBlock(variants[0] as ComponentVariant)])}
        >
          <Plus className="size-4" aria-hidden="true" /> Add {variants[0].name.toLowerCase()}
        </Button>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={full}>
            <Button type="button" variant="outline" size="sm" aria-label={`Add block to ${label}`}>
              <Plus className="size-4" aria-hidden="true" /> Add block
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel className="caption">Add to {label}</DropdownMenuLabel>
            {variants.map((v) => (
              <DropdownMenuItem key={v.apiId} onSelect={() => onChange([...items, newBlock(v)])}>
                {v.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {full && (
        <p className="text-muted-foreground text-xs">
          {max === 1 ? 'Holds one block.' : `Holds up to ${max} blocks.`}
        </p>
      )}
    </div>
  );
}

/**
 * A list of short text values (an Array of Symbols, e.g. keywords) edited as
 * removable chips: Enter or a comma adds what's typed, Backspace in the empty
 * field removes the last one. Editors never see the JSON underneath.
 */
function SymbolListInput(props: {
  id: string;
  label: string;
  aria: Record<string, string | boolean | undefined>;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const items = Array.isArray(props.value)
    ? props.value.filter((v): v is string => typeof v === 'string')
    : [];
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const next = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !items.includes(s));
    if (next.length > 0) props.onChange([...items, ...next]);
    setDraft('');
  };
  const remove = (index: number) => props.onChange(items.filter((_, i) => i !== index));
  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={props.label}>
          {items.map((item, i) => (
            <li key={item}>
              <Badge variant="secondary" className="gap-1 pr-1">
                {item}
                <button
                  type="button"
                  className="rounded-full px-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={`Remove “${item}”`}
                  onClick={() => remove(i)}
                >
                  ×
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={props.id}
        {...props.aria}
        placeholder="Type and press Enter"
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(',')) add(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && draft === '' && items.length > 0) {
            remove(items.length - 1);
          }
        }}
        onBlur={() => draft.trim() && add(draft)}
      />
    </div>
  );
}

/** The input type and the value it edits, per Date format. */
const DATE_INPUT: Readonly<Record<DateFormat, 'date' | 'datetime-local' | 'time'>> = {
  date: 'date',
  datetime: 'datetime-local',
  time: 'time',
};

/**
 * What a date input can show of a stored value. A `datetime-local` input takes no seconds' fraction
 * or offset, so a stored `2026-11-03T14:30:00Z` shows as `2026-11-03T14:30`; the stored value is
 * only replaced when the editor changes the input.
 */
function dateInputValue(value: unknown, format: DateFormat | undefined): string {
  if (typeof value !== 'string') return '';
  if (format === 'datetime') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(value)?.[0] ?? '';
  return value;
}

/** A Date value, picked by its format: a date, a date and time, or a time of day. */
function DateInput(props: {
  id: string;
  className?: string;
  aria: Record<string, string | boolean | undefined>;
  'aria-label'?: string;
  readOnly?: boolean;
  format: DateFormat | undefined;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  // Without a format, as before formats existed: a date picker.
  const type = props.format ? DATE_INPUT[props.format] : 'date';
  return (
    <Input
      id={props.id}
      className={props.className}
      {...props.aria}
      aria-label={props['aria-label']}
      readOnly={props.readOnly}
      type={type}
      // Seconds are kept when typed or stored; the picker offers minutes.
      step={props.format === 'time' || props.format === 'datetime' ? 60 : undefined}
      value={dateInputValue(props.value, props.format)}
      onChange={(e) => props.onChange(e.target.value === '' ? undefined : e.target.value)}
    />
  );
}

/** The element types a list editor handles value by value; Symbol lists keep their chips. */
const LIST_ITEM_TYPES: ReadonlySet<ArrayItemType> = new Set(['Text', 'Integer', 'Number', 'Date']);

/** A row the list's value keeps: an empty one (being typed into, or just added) is left out. */
const isListValue = (r: unknown) => r !== undefined && r !== '' && !Number.isNaN(r);

/**
 * A list of scalars (Text, Integer, Number or Date) edited one value per row: each with the input
 * its type takes, named "<Field> item N" since the rows repeat, and Remove; Add item appends an
 * empty one. Numbers are kept as numbers; an emptied row is dropped from the value.
 */
function ScalarListInput(props: {
  id: string;
  label: string;
  itemType: ArrayItemType;
  format: DateFormat | undefined;
  aria: Record<string, string | boolean | undefined>;
  /** The list's path, so each row finds its own error (`sizes[1]`). */
  path: string;
  errorFor?: (path: string) => string | undefined;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const { id, label, itemType, format } = props;
  const stored = Array.isArray(props.value) ? (props.value as unknown[]) : [];
  // Rows being typed into, including an added empty one, which the value itself can't hold.
  const [rows, setRows] = useState<unknown[]>(stored);
  useEffect(() => {
    setRows((current) => {
      const kept = current.filter(isListValue);
      return JSON.stringify(kept) === JSON.stringify(stored) ? current : stored;
    });
  }, [stored]);
  const emit = (next: unknown[]) => {
    setRows(next);
    const value = next.filter(isListValue);
    props.onChange(value.length > 0 ? value : undefined);
  };
  const numeric = itemType === 'Integer' || itemType === 'Number';
  const rowId = (i: number) => (i === 0 ? id : `${id}-${i}`);
  // Where focus goes once the rows have redrawn: the added row, the row that took a removed one's
  // place, or Add when there is none after it.
  const addRef = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<number | 'add' | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    if (target === 'add') addRef.current?.focus();
    else document.getElementById(rowId(target))?.focus();
  });
  const fieldDescribedBy = props.aria['aria-describedby'] as string | undefined;
  // An error names its item by its place in the value, which leaves out empty rows: row i is item
  // valueIndex[i] of the value, or none when it is empty.
  let counted = 0;
  const valueIndex = rows.map((r) => (isListValue(r) ? counted++ : -1));
  return (
    <div className="space-y-2">
      {rows.map((item, i) => {
        const name = `${label} item ${i + 1}`;
        const change = (v: unknown) => emit(rows.map((r, j) => (j === i ? v : r)));
        // Each row carries its own error, and the list's error and help beside it.
        const at = valueIndex[i] ?? -1;
        const err = at < 0 ? undefined : props.errorFor?.(`${props.path}[${at}]`);
        const errId = err ? `${rowId(i)}-error` : undefined;
        const rowAria = {
          'aria-invalid': Boolean(err) || Boolean(props.aria['aria-invalid']) || undefined,
          'aria-describedby': [errId, fieldDescribedBy].filter(Boolean).join(' ') || undefined,
        };
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: a row is its place in the list; values repeat and may be empty
          <div key={i} className="space-y-1">
            <div className="flex items-start gap-2">
              {itemType === 'Date' ? (
                <DateInput
                  id={rowId(i)}
                  aria={rowAria}
                  aria-label={name}
                  format={format}
                  value={item}
                  onChange={change}
                />
              ) : itemType === 'Text' ? (
                <Textarea
                  id={rowId(i)}
                  {...rowAria}
                  aria-label={name}
                  rows={2}
                  value={typeof item === 'string' ? item : ''}
                  onChange={(e) => change(e.target.value)}
                />
              ) : (
                <Input
                  id={rowId(i)}
                  {...rowAria}
                  aria-label={name}
                  type="number"
                  step={itemType === 'Integer' ? 1 : 'any'}
                  value={typeof item === 'number' ? String(item) : ''}
                  onChange={(e) =>
                    change(e.target.value === '' ? undefined : Number(e.target.value))
                  }
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${name}`}
                onClick={() => {
                  focusNext.current = i < rows.length - 1 ? i : 'add';
                  emit(rows.filter((_, j) => j !== i));
                }}
              >
                Remove
              </Button>
            </div>
            {err && (
              <p id={errId} className="text-xs text-destructive">
                {err}
              </p>
            )}
          </div>
        );
      })}
      <Button
        ref={addRef}
        type="button"
        variant="outline"
        size="sm"
        aria-describedby={fieldDescribedBy}
        onClick={() => {
          focusNext.current = rows.length;
          setRows([...rows, numeric ? undefined : '']);
        }}
      >
        <Plus className="size-4" /> Add item
      </Button>
    </div>
  );
}

/**
 * Raw JSON editor for complex field types. Typing through invalid syntax is
 * expected; the field says so instead of silently keeping the last valid value.
 */
function JsonFieldInput(props: {
  id: string;
  inputClass?: string;
  aria: Record<string, string | boolean | undefined>;
  readOnly?: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const [invalid, setInvalid] = useState(false);
  // Controlled text mirrored from the value, so external updates (AI merge
  // patches) show up; `lastEmitted` tells our own onChange echo apart from a
  // real external change (same pattern as RichTextEditor).
  const [text, setText] = useState(() =>
    props.value === undefined ? '' : JSON.stringify(props.value),
  );
  const lastEmitted = useRef(props.value);
  useEffect(() => {
    if (props.value === lastEmitted.current) return;
    if (JSON.stringify(props.value) === JSON.stringify(lastEmitted.current)) return;
    lastEmitted.current = props.value;
    setText(props.value === undefined ? '' : JSON.stringify(props.value));
    setInvalid(false);
  }, [props.value]);
  return (
    <div className="space-y-1">
      <Textarea
        id={props.id}
        className={props.inputClass}
        {...props.aria}
        readOnly={props.readOnly}
        rows={3}
        placeholder='JSON, e.g. {"lat": 52.52, "lon": 13.4}'
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value === '') {
            setInvalid(false);
            lastEmitted.current = undefined;
            props.onChange(undefined);
            return;
          }
          try {
            const parsed = JSON.parse(e.target.value);
            lastEmitted.current = parsed;
            props.onChange(parsed);
            setInvalid(false);
          } catch {
            // Keep the last valid value until the text parses again.
            setInvalid(true);
          }
        }}
      />
      {invalid && (
        <p className="text-wait text-xs">
          Not valid JSON yet. Until the syntax is fixed, the last valid value is what saves.
        </p>
      )}
    </div>
  );
}
