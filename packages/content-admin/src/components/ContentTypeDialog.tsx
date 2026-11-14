import {
  DiscardAsk,
  GuardCancel,
  useDiscardGuard,
} from '@commerceworker/content-admin/components/discard-guard';
import {
  type ArrayItemType,
  blockVariants,
  CONTENT_TYPE_LIMITS,
  type ContentType,
  type ContentTypeDraft,
  type ContentTypeLayout,
  checkPreviewTemplate,
  DATE_FORMAT_EXAMPLES,
  type DateFormat,
  FIELD_GUIDANCE_LIMITS,
  FIELD_TYPES,
  type FieldDefinition,
  type FieldRule,
  type FieldType,
  type FieldValidations,
  isPatternPreset,
  isValidApiId,
  LAYOUT_LIMITS,
  MAX_FIELD_RULES,
  MAX_PREVIEW_TEMPLATE_LENGTH,
  PATTERN_PRESETS,
  type PatternPreset,
  type RuleAction,
  type RuleOperator,
  SCALAR_ITEM_TYPES,
  UNIQUE_FIELD_TYPES,
  ValidationError,
} from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { Checkbox } from '@commerceworker/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@commerceworker/ui/dialog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { Textarea } from '@commerceworker/ui/textarea';
import { Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toApiId } from '../lib/api-id';
import { CONTENT_TYPE_ICONS, contentTypeIcon } from '../lib/content-type-icons';
import {
  BlockVariantsEditor,
  newVariant,
  type VariantRow,
  variantRowsFrom,
  variantRowsProblem,
  variantsFromRows,
} from './BlockVariantsEditor';

interface FieldRow {
  name: string;
  apiId: string;
  apiIdTouched: boolean;
  type: FieldType;
  required: boolean;
  localized: boolean;
  unique?: boolean;
  /** Guidance for whoever fills the field: `help`, `placeholder` and `description`. */
  help: string;
  placeholder: string;
  description: string;
  /** Whether the guidance inputs are shown; open from the start when there is guidance. */
  guidanceOpen: boolean;
  /** The rules this dialog can draw, one row each (see {@link RuleRow}). */
  rules: RuleRow[];
  /** Rules it can't draw (a dot path into a component), kept as they are on every save. */
  keptRules: FieldRule[];
  /** Whether the rules editor is shown; open from the start when the field has rules. */
  rulesOpen: boolean;
  /**
   * Whether a rule row was edited. Untouched, the field's stored rules are saved as they were,
   * so opening and closing the editor never rewrites them.
   */
  rulesTouched: boolean;
  /** The type-specific settings (see {@link SettingsRow}) and whether they are shown. */
  settings: SettingsRow;
  settingsOpen: boolean;
  /** Whether a setting was edited. Untouched, the field's validations ride along as stored. */
  settingsTouched: boolean;
  /** The layout tab (its apiId) the field is placed on, '' for none, and its group there. */
  tab: string;
  group: string;
  /**
   * Set when the field is a blocks field: an `Array` of `Component` whose
   * elements take one of these shapes. Offered in the type menu as "Blocks".
   */
  blocks?: VariantRow[];
  /**
   * What a list of scalars holds, as chosen under Items (see {@link choosesItems}). Unset for a
   * stored list with no item type, which keeps editing as JSON until one is chosen.
   */
  itemType?: ArrayItemType;
  /**
   * The definition this row was loaded from, if any.
   *
   * This dialog edits six attributes; a definition has more than a dozen —
   * `linkType`, `items`, `validations`, `defaultValue`, a component's nested
   * `fields`. Rebuilding the field from the row alone silently discarded all of
   * them, so editing a field's name through the admin quietly destroyed
   * configuration made through the API. Everything not edited here is carried
   * through untouched.
   */
  source?: FieldDefinition;
}

/**
 * Types this dialog cannot fully define, so it does not offer to create them.
 *
 * A `Component` needs nested field definitions, and a component with none is
 * refused by the domain. Offering the type without a way to give it a shape
 * would only produce a save that fails. Existing component fields still load,
 * edit and round-trip — they just get their shape from wherever it was
 * authored (the API or MCP).
 */
const UNBUILDABLE_TYPES: readonly FieldType[] = ['Component'];

/**
 * The type menu's entry for a blocks field. Not a field type of its own: it is
 * an `Array` of `Component` with variants, which is what gets saved.
 */
const BLOCKS = 'Blocks';

/**
 * The settings a field's type gives meaning to, as the dialog edits them: a Date's format and
 * range, a text field's pattern, an asset link's allowed file types (comma-separated).
 */
interface SettingsRow {
  /** '' is no format: any ISO date, as before formats existed. */
  format: DateFormat | '';
  rangeMin: string;
  rangeMax: string;
  /** '' none, a preset's name, or 'custom' for a stored pattern this dialog can't name. */
  pattern: PatternPreset | '' | 'custom';
  mimeTypes: string;
}

const NO_SETTINGS: SettingsRow = {
  format: '',
  rangeMin: '',
  rangeMax: '',
  pattern: '',
  mimeTypes: '',
};

function settingsFrom(f: FieldDefinition): SettingsRow {
  const v = f.validations;
  const rx = v?.regexp;
  return {
    format: f.format ?? '',
    rangeMin: v?.dateRange?.min ?? '',
    rangeMax: v?.dateRange?.max ?? '',
    pattern: isPatternPreset(rx?.preset) ? rx.preset : rx?.pattern ? 'custom' : '',
    mimeTypes: (v?.assetMimeTypes ?? []).join(', '),
  };
}

/** What a row's Settings panel offers: a Date, a text field, or an asset link (one or a list). */
function settingsKind(row: Pick<FieldRow, 'type' | 'source'>): 'date' | 'text' | 'asset' | null {
  if (row.type === 'Date') return 'date';
  if (row.type === 'Symbol' || row.type === 'Text') return 'text';
  const src = row.source;
  if (row.type === 'Link' && src?.type === 'Link' && src.linkType === 'Asset') return 'asset';
  if (row.type === 'Array' && src?.items?.type === 'Link' && src.items.linkType === 'Asset') {
    return 'asset';
  }
  return null;
}

/**
 * Whether the row is a list whose element type this dialog chooses: a list of scalars, or one with
 * no item type yet. A list of links or components keeps the items it was given elsewhere.
 */
function choosesItems(row: Pick<FieldRow, 'type' | 'blocks' | 'source'>): boolean {
  if (row.type !== 'Array' || row.blocks) return false;
  const src = row.source;
  if (!src || src.type !== 'Array' || blockVariants(src)) return true;
  return !src.items || SCALAR_ITEM_TYPES.includes(src.items.type);
}

/** Whether a row's settings say anything (what the collapsed Settings button marks). */
const hasSettings = (row: Pick<FieldRow, 'type' | 'source' | 'settings'>): boolean => {
  const kind = settingsKind(row);
  const s = row.settings;
  if (kind === 'date') return Boolean(s.format || s.rangeMin || s.rangeMax);
  if (kind === 'text') return s.pattern !== '';
  if (kind === 'asset') return s.mimeTypes.trim() !== '';
  return false;
};

/**
 * The validations with the keys the Settings panel edits rewritten from the row, every other key
 * as it was. A message for a rule the row clears goes with it: the server refuses a message that
 * explains nothing.
 */
function withSettings(
  base: FieldValidations | undefined,
  row: Pick<FieldRow, 'type' | 'source' | 'settings'>,
): FieldValidations | undefined {
  const kind = settingsKind(row);
  const s = row.settings;
  const out: Record<string, unknown> = { ...(base ?? {}) };
  const messages: Record<string, unknown> = { ...(base?.messages ?? {}) };
  const clear = (rule: string) => {
    delete out[rule];
    delete messages[rule];
  };
  if (kind === 'date') {
    const min = s.rangeMin.trim();
    const max = s.rangeMax.trim();
    if (min || max) out.dateRange = { ...(min ? { min } : {}), ...(max ? { max } : {}) };
    else clear('dateRange');
  } else if (kind === 'text') {
    if (s.pattern === '') clear('regexp');
    // A preset is sent by name; the server fills in its pattern. A custom one rides along.
    else if (s.pattern !== 'custom') out.regexp = { preset: s.pattern };
  } else if (kind === 'asset') {
    const list = s.mimeTypes
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    if (list.length > 0) out.assetMimeTypes = list;
    else clear('assetMimeTypes');
  }
  if (Object.keys(messages).length > 0) out.messages = messages;
  else delete out.messages;
  return Object.keys(out).length > 0 ? (out as FieldValidations) : undefined;
}

const NO_GUIDANCE = {
  help: '',
  placeholder: '',
  description: '',
  guidanceOpen: false,
  rules: [] as RuleRow[],
  keptRules: [] as FieldRule[],
  rulesOpen: false,
  rulesTouched: false,
  settings: NO_SETTINGS,
  settingsOpen: false,
  settingsTouched: false,
  tab: '',
  group: '',
};

/**
 * One rule as the dialog edits it: the sibling it reads by apiId, and its value as typed (a list
 * for `in` is comma-separated), parsed by the sibling's type on save.
 */
interface RuleRow {
  action: RuleAction;
  field: string;
  operator: RuleOperator;
  value: string;
}

/** The operators in an editor's words. `gt` and `lt` are offered for number siblings only. */
const OPERATOR_LABELS: Record<RuleOperator, string> = {
  eq: 'is',
  ne: 'is not',
  in: 'is one of',
  empty: 'is empty',
  notEmpty: 'is not empty',
  gt: 'is more than',
  lt: 'is less than',
};
const NUMERIC: readonly FieldType[] = ['Integer', 'Number'];
const takesValue = (op: RuleOperator) => op !== 'empty' && op !== 'notEmpty';

/** A stored rule as a row, or null when the dialog can't draw it (a path into a component). */
function ruleRowFrom(rule: FieldRule): RuleRow | null {
  const when = rule?.when;
  if (typeof when?.field !== 'string' || when.field.includes('.')) return null;
  const v = when.value;
  return {
    action: rule.action,
    field: when.field,
    operator: when.operator,
    value: Array.isArray(v) ? v.join(', ') : v === undefined ? '' : String(v),
  };
}

/** A typed value as the sibling holds it: a number for a number field, true/false for a Boolean. */
function parseRuleValue(text: string, type: FieldType | undefined): string | number | boolean {
  const t = text.trim();
  if (type && NUMERIC.includes(type) && t !== '' && Number.isFinite(Number(t))) return Number(t);
  if (type === 'Boolean' && (t === 'true' || t === 'false')) return t === 'true';
  return t;
}

/** A row as the rule the API takes, reading the sibling's type from the rows being edited. */
function ruleFromRow(row: RuleRow, siblings: readonly FieldRow[]): FieldRule {
  const type = siblings.find((f) => f.apiId === row.field)?.type;
  const when = !takesValue(row.operator)
    ? { field: row.field, operator: row.operator }
    : row.operator === 'in'
      ? {
          field: row.field,
          operator: row.operator,
          value: row.value
            .split(',')
            .filter((part) => part.trim() !== '')
            .map((part) => parseRuleValue(part, type) as string | number),
        }
      : { field: row.field, operator: row.operator, value: parseRuleValue(row.value, type) };
  return { action: row.action, when };
}

const newField = (): FieldRow => ({
  name: '',
  apiId: '',
  apiIdTouched: false,
  type: 'Symbol',
  required: false,
  localized: false,
  ...NO_GUIDANCE,
});

/** Whether a row carries any guidance (what the collapsed Guidance button marks). */
const hasGuidance = (row: Pick<FieldRow, 'help' | 'placeholder' | 'description'>): boolean =>
  Boolean(row.help.trim() || row.placeholder.trim() || row.description.trim());

/** Whether a row carries rules (what the collapsed Rules button marks). */
const hasRules = (row: Pick<FieldRow, 'rules' | 'keptRules'>): boolean =>
  row.rules.length + row.keptRules.length > 0;

/** A guidance text as saved: trimmed, and left out when empty so clearing it removes it. */
const guidance = (text: string): string | undefined => text.trim() || undefined;

/**
 * Builds the definition to save from an edited row.
 *
 * Configuration this dialog does not edit — `linkType`, `items`, `validations`,
 * `defaultValue`, a component's nested `fields` — rides along from the original
 * definition, except when the type changed: that configuration described the
 * old type, and carrying `items` onto a Symbol (or nested `fields` onto
 * anything but a component) is refused by the domain anyway.
 */
function toDefinition(
  row: FieldRow,
  position: number,
  siblings: readonly FieldRow[],
): FieldDefinition {
  // Turning a list into blocks (or back) is a change of type too: the old
  // `items` described elements of the other kind.
  const wasBlocks = row.source ? blockVariants(row.source) !== undefined : false;
  const retyped =
    row.source && (row.source.type !== row.type || wasBlocks !== (row.blocks !== undefined));
  const {
    linkType,
    items,
    fields,
    validations,
    defaultValue,
    rules,
    format: storedFormat,
    ...rest
  } = row.source ?? {};
  // A Date keeps its format (or takes the panel's); any other type has none.
  const format =
    row.type !== 'Date'
      ? undefined
      : row.settingsTouched
        ? row.settings.format || undefined
        : retyped
          ? undefined
          : storedFormat;
  const keptValidations = retyped ? undefined : validations;
  const savedValidations = row.settingsTouched
    ? withSettings(keptValidations, row)
    : keptValidations;
  // Rows rebuild the rules only once one was edited; the rules this dialog can't draw ride along.
  const edited = [...row.rules.map((r) => ruleFromRow(r, siblings)), ...row.keptRules];
  const savedRules = row.rulesTouched ? edited : rules;
  // A chosen element type keeps the stored items while it is unchanged (their format and rules),
  // and starts them afresh when it changes.
  const listItems =
    choosesItems(row) && row.itemType
      ? !retyped && items?.type === row.itemType
        ? items
        : { type: row.itemType }
      : undefined;
  const blocksItems = row.blocks
    ? {
        ...(retyped ? {} : { validations: items?.validations }),
        type: 'Component' as const,
        variants: variantsFromRows(row.blocks),
      }
    : undefined;
  return {
    ...rest,
    ...(retyped ? {} : { linkType, items, fields, defaultValue }),
    validations: savedValidations,
    format,
    ...(listItems ? { items: listItems } : {}),
    ...(blocksItems ? { items: blocksItems } : {}),
    apiId: row.apiId,
    name: row.name.trim(),
    type: row.type,
    required: row.required,
    localized: row.localized,
    // Omitted rather than sent as false, so the payload stays the shape the API
    // documents for types that cannot be unique.
    unique: row.unique ? true : undefined,
    help: guidance(row.help),
    placeholder: guidance(row.placeholder),
    description: guidance(row.description),
    // Left out when there are none, so clearing the last rule removes them.
    rules: savedRules?.length ? savedRules : undefined,
    position,
  } as FieldDefinition;
}

function fromContentType(ct: ContentType): { name: string; apiId: string; fields: FieldRow[] } {
  const placed = new Map<string, { tab: string; group: string }>();
  for (const t of ct.layout?.tabs ?? []) {
    for (const g of t.groups ?? []) {
      for (const apiId of g.fields ?? []) placed.set(apiId, { tab: t.apiId, group: g.name ?? '' });
    }
  }
  return {
    name: ct.name,
    apiId: ct.apiId,
    fields: ct.fields.map((f) => ({
      settings: settingsFrom(f),
      settingsOpen: false,
      settingsTouched: false,
      tab: placed.get(f.apiId)?.tab ?? '',
      group: placed.get(f.apiId)?.group ?? '',
      name: f.name,
      apiId: f.apiId,
      apiIdTouched: true,
      type: f.type,
      required: f.required,
      localized: f.localized,
      unique: f.unique,
      help: f.help ?? '',
      placeholder: f.placeholder ?? '',
      description: f.description ?? '',
      guidanceOpen: Boolean(f.help || f.placeholder || f.description),
      rules: (f.rules ?? []).map(ruleRowFrom).filter((r): r is RuleRow => r !== null),
      keptRules: (f.rules ?? []).filter((r) => ruleRowFrom(r) === null),
      rulesOpen: Boolean(f.rules?.length),
      rulesTouched: false,
      ...(blockVariants(f) ? { blocks: variantRowsFrom(blockVariants(f) ?? []) } : {}),
      ...(f.items && SCALAR_ITEM_TYPES.includes(f.items.type) ? { itemType: f.items.type } : {}),
      source: f,
    })),
  };
}

/** A layout tab as the dialog edits it: a stable apiId (kept for a stored tab) and its name. */
interface TabRow {
  apiId: string;
  name: string;
}

/**
 * The layout from the rows: tabs in order; on each, the groups in the order their first field
 * comes, fields without a group name forming unnamed groups. A field on no tab is left unplaced
 * (it follows on the first tab). `collapsed` rides along for a group whose name is kept. Null when
 * there are no tabs, which clears it.
 */
function layoutFromRows(
  tabs: readonly TabRow[],
  fields: readonly FieldRow[],
  stored: ContentTypeLayout | undefined,
): ContentTypeLayout | null {
  const named = tabs.filter((t) => t.name.trim());
  if (named.length === 0) return null;
  const out = named.map((t) => {
    const collapsed = new Set(
      (stored?.tabs.find((s) => s.apiId === t.apiId)?.groups ?? [])
        .filter((g) => g.collapsed && g.name)
        .map((g) => g.name as string),
    );
    const groups: { name?: string; fields: string[]; collapsed?: boolean }[] = [];
    for (const f of fields) {
      if (f.tab !== t.apiId) continue;
      const name = f.group.trim();
      // Consecutive unnamed fields share a group; a named group gathers every field naming it.
      const last = groups[groups.length - 1];
      const into = name
        ? groups.find((g) => g.name === name)
        : last && last.name === undefined
          ? last
          : undefined;
      if (into) into.fields.push(f.apiId);
      else {
        groups.push({
          ...(name ? { name } : {}),
          fields: [f.apiId],
          ...(name && collapsed.has(name) ? { collapsed: true } : {}),
        });
      }
    }
    return { apiId: t.apiId, name: t.name.trim(), groups };
  });
  // A tab no field sits on has nothing to draw; the server would drop it too.
  const used = out.filter((t) => t.groups.length > 0);
  return used.length > 0 ? { tabs: used } : null;
}

/** A tab's apiId from its name, made unique among the others. */
function tabApiId(name: string, taken: readonly string[]): string {
  const base = toApiId(name) || 'tab';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}${n}`;
  return id;
}

/**
 * Create or edit a content type and its fields. The save route is idempotent on
 * apiId, so the same dialog serves both (pass `initial` to edit). On save the
 * type is published so entries can be authored immediately.
 */
export function ContentTypeDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ContentType;
  onSave: (draft: ContentTypeDraft) => Promise<void>;
}) {
  const editing = Boolean(props.initial);
  const seed = props.initial
    ? fromContentType(props.initial)
    : {
        name: '',
        apiId: '',
        fields: [
          {
            name: 'Title',
            apiId: 'title',
            apiIdTouched: true,
            type: 'Symbol' as FieldType,
            required: true,
            localized: true,
            ...NO_GUIDANCE,
          },
        ],
      };

  const [name, setName] = useState(seed.name);
  const [apiId, setApiId] = useState(seed.apiId);
  const [apiIdTouched, setApiIdTouched] = useState(editing);
  const [fields, setFields] = useState<FieldRow[]>(seed.fields);
  const [displayField, setDisplayField] = useState(props.initial?.displayField ?? 'title');
  const [urlPattern, setUrlPattern] = useState(props.initial?.urlPattern ?? '');
  const [previewTemplate, setPreviewTemplate] = useState(props.initial?.preview?.urlTemplate ?? '');
  const [previewError, setPreviewError] = useState<string>();
  const previewRef = useRef<HTMLInputElement>(null);
  const [singleton, setSingleton] = useState(props.initial?.singleton === true);
  const [group, setGroup] = useState(props.initial?.group ?? '');
  const [description, setDescription] = useState(props.initial?.description ?? '');
  const [agentInstructions, setAgentInstructions] = useState(
    props.initial?.agentInstructions ?? '',
  );
  const [icon, setIcon] = useState(props.initial?.icon ?? '');
  const [tabs, setTabs] = useState<TabRow[]>(
    () => props.initial?.layout?.tabs.map((t) => ({ apiId: t.apiId, name: t.name })) ?? [],
  );
  // Untouched, the stored layout is left to the server, which keeps it and drops removed fields.
  const [layoutTouched, setLayoutTouched] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Everything a person can have changed, against how the form opened: a schema is long work, and
  // a press outside the dialog must not throw it away.
  const form = JSON.stringify({
    name,
    apiId,
    fields,
    displayField,
    urlPattern,
    previewTemplate,
    singleton,
    group,
    description,
    icon,
    agentInstructions,
    tabs,
  });
  const [opened] = useState(form);
  const guard = useDiscardGuard({
    saving: busy,
    open: props.open,
    dirty: form !== opened,
    onOpenChange: props.onOpenChange,
  });

  const setField = (i: number, patch: Partial<FieldRow>) =>
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));

  const namedFields = fields.filter((f) => f.apiId && f.name);
  const placeField = (i: number, patch: Partial<Pick<FieldRow, 'tab' | 'group'>>) => {
    setField(i, patch);
    setLayoutTouched(true);
  };
  const namedTabs = tabs.filter((t) => t.name.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setPreviewError(undefined);
    const finalApiId = apiId || toApiId(name);
    if (!name.trim() || !isValidApiId(finalApiId)) {
      setError('A name and a valid API ID (letter, then letters/numbers/_) are required.');
      return;
    }
    if (namedFields.length === 0) {
      setError('Add at least one field.');
      return;
    }
    const apiIds = namedFields.map((f) => f.apiId);
    if (new Set(apiIds).size !== apiIds.length) {
      setError('Field API IDs must be unique.');
      return;
    }
    if (!apiIds.includes(displayField)) {
      setError('The display field must be one of the fields.');
      return;
    }
    for (const f of namedFields) {
      const problem = f.blocks ? variantRowsProblem(f.name, f.blocks) : null;
      if (problem) {
        setError(problem);
        return;
      }
    }
    // The domain's own check, so the field says what is wrong before the save is refused for it.
    const definitions = namedFields.map((f, i) => toDefinition(f, i, namedFields));
    if (previewTemplate.trim()) {
      try {
        // Loopback is the deployment's call (https only, unless it is a local stack): the server
        // decides, and says so if it refuses one.
        checkPreviewTemplate(previewTemplate.trim(), definitions, { allowLoopback: true });
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        setPreviewError(err.issues[0]?.message ?? 'This preview URL can’t be used.');
        // The field is usually off screen under a long field list: focus brings it, and its
        // error, into view (and is read with the label through aria-describedby).
        previewRef.current?.focus();
        return;
      }
    }
    setBusy(true);
    try {
      await props.onSave({
        apiId: finalApiId,
        name: name.trim(),
        displayField,
        fields: definitions,
        // Cleared with null: left out, a saved pattern would stay.
        urlPattern: urlPattern.trim() || null,
        preview: previewTemplate.trim() ? { urlTemplate: previewTemplate.trim() } : null,
        singleton,
        group: group.trim() || null,
        description: description.trim() || null,
        agentInstructions: agentInstructions.trim() || null,
        icon: icon || null,
        ...(layoutTouched
          ? { layout: layoutFromRows(tabs, namedFields, props.initial?.layout) }
          : {}),
      });
      props.onOpenChange(false);
    } catch (err) {
      setError(guard.saveFailed(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={guard.onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit content type' : 'New content type'}</DialogTitle>
          <DialogDescription>
            Define the schema for a class of entries. Saving publishes it so you can author entries.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ct-name">Name</Label>
              <Input
                id="ct-name"
                value={name}
                placeholder="Blog Post"
                onChange={(e) => {
                  setName(e.target.value);
                  if (!apiIdTouched) setApiId(toApiId(e.target.value));
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct-apiid">API ID</Label>
              <Input
                id="ct-apiid"
                value={apiId}
                placeholder="blogPost"
                disabled={editing}
                className="font-mono"
                onChange={(e) => {
                  setApiIdTouched(true);
                  setApiId(e.target.value);
                }}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ct-group">Group</Label>
              <Input
                id="ct-group"
                value={group}
                placeholder="Editorial"
                maxLength={CONTENT_TYPE_LIMITS.group}
                aria-describedby="ct-group-hint"
                onChange={(e) => setGroup(e.target.value)}
              />
              <p id="ct-group-hint" className="max-w-measure text-muted-foreground text-xs">
                The content nav lists types under their group. Optional.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ct-icon">Icon</Label>
              <NativeSelect
                id="ct-icon"
                wrapperClassName="w-full"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
              >
                <NativeSelectOption value="">None</NativeSelectOption>
                {Object.keys(CONTENT_TYPE_ICONS).map((n) => (
                  <NativeSelectOption key={n} value={n}>
                    {iconLabel(n)}
                  </NativeSelectOption>
                ))}
                {icon && !contentTypeIcon(icon) && (
                  <NativeSelectOption value={icon}>{`${icon} (not drawn here)`}</NativeSelectOption>
                )}
              </NativeSelect>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ct-description">Description</Label>
            <Textarea
              id="ct-description"
              rows={2}
              value={description}
              maxLength={CONTENT_TYPE_LIMITS.description}
              placeholder="What this type is for"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ct-agent-instructions">Agent instructions</Label>
            <Textarea
              id="ct-agent-instructions"
              rows={3}
              value={agentInstructions}
              maxLength={CONTENT_TYPE_LIMITS.agentInstructions}
              placeholder="Keep titles under eight words. Never invent quotes."
              aria-describedby="ct-agent-instructions-hint"
              onChange={(e) => setAgentInstructions(e.target.value)}
            />
            <p
              id="ct-agent-instructions-hint"
              className="max-w-measure text-muted-foreground text-xs"
            >
              How agents should write these entries. Agents, the assistant included, read this with
              the content type; it is never delivered. Optional.
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Fields</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setFields((f) => [...f, newField()])}
              >
                <Plus className="size-4" /> Add field
              </Button>
            </div>
            <div className="space-y-2">
              {fields.map((f, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: field rows have no stable id pre-save
                <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border p-2">
                  <div className="flex-1 space-y-1">
                    {/* The <span> is a visual heading only — it labels nothing
                        programmatically, and these rows repeat, so each input
                        names itself and says which field it belongs to. */}
                    <span className="text-xs text-muted-foreground">Name</span>
                    <Input
                      aria-label={`Name for field ${i + 1}`}
                      value={f.name}
                      placeholder="Title"
                      onChange={(e) =>
                        setField(i, {
                          name: e.target.value,
                          ...(f.apiIdTouched ? {} : { apiId: toApiId(e.target.value) }),
                        })
                      }
                    />
                  </div>
                  <div className="w-32 space-y-1">
                    <span className="text-xs text-muted-foreground">API ID</span>
                    <Input
                      aria-label={`API ID for ${f.name || `field ${i + 1}`}`}
                      value={f.apiId}
                      className="font-mono text-xs"
                      onChange={(e) => setField(i, { apiId: e.target.value, apiIdTouched: true })}
                    />
                  </div>
                  <div className="w-28 space-y-1">
                    <span className="text-xs text-muted-foreground">Type</span>
                    <Select
                      value={f.blocks ? BLOCKS : f.type}
                      onValueChange={(v) =>
                        setField(
                          i,
                          v === BLOCKS
                            ? { type: 'Array', blocks: f.blocks ?? [newVariant()] }
                            : {
                                type: v as FieldType,
                                blocks: undefined,
                                // A new list holds short text until told otherwise.
                                ...(v === 'Array' ? { itemType: f.itemType ?? 'Symbol' } : {}),
                              },
                        )
                      }
                    >
                      <SelectTrigger
                        aria-label={`Type for ${f.name || f.apiId || 'field'}`}
                        size="sm"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FIELD_TYPES.filter(
                          (t) =>
                            (!UNBUILDABLE_TYPES.includes(t) || f.type === t) &&
                            // A type has one Seo field: offered until another row is one.
                            (t !== 'Seo' ||
                              f.type === 'Seo' ||
                              !fields.some((g) => g.type === 'Seo')),
                        ).map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                        <SelectItem value={BLOCKS}>{BLOCKS}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {choosesItems(f) && (
                    <div className="w-28 space-y-1">
                      <span className="text-xs text-muted-foreground">Items</span>
                      <NativeSelect
                        size="sm"
                        aria-label={`Items for ${f.name || f.apiId || 'field'}`}
                        wrapperClassName="w-full"
                        value={f.itemType ?? ''}
                        onChange={(e) => setField(i, { itemType: e.target.value as ArrayItemType })}
                      >
                        {!f.itemType && (
                          <NativeSelectOption value="">Any (JSON)</NativeSelectOption>
                        )}
                        {SCALAR_ITEM_TYPES.map((t) => (
                          <NativeSelectOption key={t} value={t}>
                            {t}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                  )}
                  {/* A wrapping label does not name a <button role="checkbox">
                      (see Settings.tsx). The names spell the abbreviations out:
                      "Req" and "Loc" are fine to read in a dense row but poor to
                      hear, and they repeat per field, so each says which one. */}
                  <Label className="h-9 gap-1.5 font-normal">
                    <Checkbox
                      aria-label={`${f.name || f.apiId || 'Field'}: required`}
                      checked={f.required}
                      onCheckedChange={(c) => setField(i, { required: c === true })}
                    />
                    Req
                  </Label>
                  <Label className="h-9 gap-1.5 font-normal">
                    <Checkbox
                      aria-label={`${f.name || f.apiId || 'Field'}: localized`}
                      checked={f.localized}
                      onCheckedChange={(c) => setField(i, { localized: c === true })}
                    />
                    Loc
                  </Label>
                  {/* Only offered where it can be enforced — the server refuses
                      `unique` on types with no single comparable value. */}
                  {UNIQUE_FIELD_TYPES.includes(f.type) && (
                    <Label className="h-9 gap-1.5 font-normal">
                      <Checkbox
                        aria-label={`${f.name || f.apiId || 'Field'}: unique`}
                        checked={f.unique === true}
                        onCheckedChange={(c) => setField(i, { unique: c === true })}
                      />
                      Uniq
                    </Label>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={f.guidanceOpen}
                    aria-controls={`ct-field-${i}-guidance`}
                    // Collapsed, the button still says the field has guidance, so it is
                    // not mistaken for one without.
                    aria-label={`Guidance for ${f.name || f.apiId || `field ${i + 1}`}${
                      !f.guidanceOpen && hasGuidance(f) ? ', set' : ''
                    }`}
                    onClick={() => setField(i, { guidanceOpen: !f.guidanceOpen })}
                  >
                    Guidance
                    {!f.guidanceOpen && hasGuidance(f) && (
                      <span aria-hidden="true" className="text-muted-foreground">
                        · set
                      </span>
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={f.rulesOpen}
                    aria-controls={`ct-field-${i}-rules`}
                    aria-label={`Rules for ${f.name || f.apiId || `field ${i + 1}`}${
                      !f.rulesOpen && hasRules(f) ? ', set' : ''
                    }`}
                    onClick={() => setField(i, { rulesOpen: !f.rulesOpen })}
                  >
                    Rules
                    {!f.rulesOpen && hasRules(f) && (
                      <span aria-hidden="true" className="text-muted-foreground">
                        · set
                      </span>
                    )}
                  </Button>
                  {settingsKind(f) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-expanded={f.settingsOpen}
                      aria-controls={`ct-field-${i}-settings`}
                      aria-label={`Settings for ${f.name || f.apiId || `field ${i + 1}`}${
                        !f.settingsOpen && hasSettings(f) ? ', set' : ''
                      }`}
                      onClick={() => setField(i, { settingsOpen: !f.settingsOpen })}
                    >
                      Settings
                      {!f.settingsOpen && hasSettings(f) && (
                        <span aria-hidden="true" className="text-muted-foreground">
                          · set
                        </span>
                      )}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove field"
                    onClick={() => setFields((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                  {f.guidanceOpen && (
                    <FieldGuidance
                      id={`ct-field-${i}-guidance`}
                      fieldLabel={f.name || f.apiId || `field ${i + 1}`}
                      row={f}
                      onChange={(patch) => setField(i, patch)}
                    />
                  )}
                  {f.rulesOpen && (
                    <FieldRules
                      id={`ct-field-${i}-rules`}
                      fieldLabel={f.name || f.apiId || `field ${i + 1}`}
                      row={f}
                      siblings={namedFields.filter((g) => g !== f)}
                      onChange={(rules) => setField(i, { rules, rulesTouched: true })}
                    />
                  )}
                  {f.settingsOpen && settingsKind(f) && (
                    <FieldSettings
                      id={`ct-field-${i}-settings`}
                      fieldLabel={f.name || f.apiId || `field ${i + 1}`}
                      kind={settingsKind(f) as 'date' | 'text' | 'asset'}
                      value={f.settings}
                      onChange={(patch) =>
                        setField(i, {
                          settings: { ...f.settings, ...patch },
                          settingsTouched: true,
                        })
                      }
                    />
                  )}
                  {namedTabs.length > 0 && (
                    <div className="flex basis-full flex-wrap items-center gap-2">
                      <NativeSelect
                        size="sm"
                        aria-label={`Tab for ${f.name || f.apiId || `field ${i + 1}`}`}
                        value={f.tab}
                        onChange={(e) => placeField(i, { tab: e.target.value })}
                      >
                        <NativeSelectOption value="">
                          First tab, after placed fields
                        </NativeSelectOption>
                        {namedTabs.map((t) => (
                          <NativeSelectOption key={t.apiId} value={t.apiId}>
                            {t.name}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                      {f.tab && (
                        <Input
                          className="h-8 w-44"
                          aria-label={`Group for ${f.name || f.apiId || `field ${i + 1}`}`}
                          placeholder="Group (optional)"
                          maxLength={LAYOUT_LIMITS.name}
                          value={f.group}
                          onChange={(e) => placeField(i, { group: e.target.value })}
                        />
                      )}
                    </div>
                  )}
                  {f.blocks && (
                    <BlockVariantsEditor
                      fieldLabel={f.name || f.apiId || `field ${i + 1}`}
                      value={f.blocks}
                      onChange={(blocks) => setField(i, { blocks })}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ct-display">Display field</Label>
            <Select value={displayField} onValueChange={setDisplayField}>
              <SelectTrigger id="ct-display" className="w-64">
                <SelectValue placeholder="Pick a field" />
              </SelectTrigger>
              <SelectContent>
                {namedFields.map((f) => (
                  <SelectItem key={f.apiId} value={f.apiId}>
                    {f.name} ({f.apiId})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ct-url">URL pattern</Label>
            <Input
              id="ct-url"
              className="max-w-lg font-mono"
              placeholder="/blog/{slug}"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby="ct-url-hint"
              value={urlPattern}
              onChange={(e) => setUrlPattern(e.target.value)}
            />
            <p id="ct-url-hint" className="max-w-measure text-muted-foreground text-ui">
              Where entries live on your site: {'{id}'}, {'{locale}'} or a Slug field’s API ID.
              Publishing a changed slug then redirects the old path. Optional.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ct-preview">Preview URL</Label>
            <Input
              ref={previewRef}
              id="ct-preview"
              inputMode="url"
              className="max-w-lg font-mono"
              placeholder="https://example.com/__preview?entry={id}#token={token}"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              maxLength={MAX_PREVIEW_TEMPLATE_LENGTH}
              aria-invalid={previewError ? true : undefined}
              aria-describedby={
                previewError ? 'ct-preview-error ct-preview-hint' : 'ct-preview-hint'
              }
              value={previewTemplate}
              onChange={(e) => {
                setPreviewTemplate(e.target.value);
                setPreviewError(undefined);
              }}
            />
            {previewError && (
              <p id="ct-preview-error" className="max-w-measure text-destructive text-ui">
                {previewError}
              </p>
            )}
            <p id="ct-preview-hint" className="max-w-measure text-muted-foreground text-ui">
              Your site’s draft view, which Copy preview link fills in. Needs {'{token}'}; can use{' '}
              {'{id}'}, {'{locale}'} or {'{field:slug}'}. Optional.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="gap-2 font-normal">
              <Checkbox
                aria-labelledby="ct-singleton-label"
                aria-describedby="ct-singleton-hint"
                checked={singleton}
                onCheckedChange={(c) => setSingleton(c === true)}
              />
              <span id="ct-singleton-label">One entry only (singleton)</span>
            </Label>
            <p id="ct-singleton-hint" className="max-w-measure text-muted-foreground text-ui">
              For site settings or a home page: the content type holds a single entry, opened
              straight from the sidebar, and the delivery API serves it by the type’s API ID. A type
              that already has more than one entry can’t become one.
            </p>
          </div>

          {/* Drawn as Fields is: its title beside its Add button. */}
          <fieldset className="space-y-2" aria-labelledby="ct-layout-title">
            <div className="flex items-center justify-between">
              <span id="ct-layout-title" className="font-medium text-sm leading-none">
                Layout
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={tabs.length >= LAYOUT_LIMITS.tabs}
                onClick={() => {
                  const name = tabs.length === 0 ? 'Content' : `Tab ${tabs.length + 1}`;
                  setTabs((prev) => [
                    ...prev,
                    {
                      apiId: tabApiId(
                        name,
                        prev.map((x) => x.apiId),
                      ),
                      name,
                    },
                  ]);
                  setLayoutTouched(true);
                }}
              >
                <Plus className="size-4" /> Add tab
              </Button>
            </div>
            <p className="max-w-measure text-muted-foreground text-ui">
              Arrange the entry form into tabs, then pick each field’s tab and group above. Only
              editors see it. Fields on no tab follow on the first.
            </p>
            {tabs.map((t, ti) => (
              <div key={t.apiId} className="flex items-center gap-2">
                <Input
                  className="max-w-xs"
                  aria-label={`Name of tab ${ti + 1}`}
                  value={t.name}
                  maxLength={LAYOUT_LIMITS.name}
                  onChange={(e) => {
                    setTabs((prev) =>
                      prev.map((x, k) => (k === ti ? { ...x, name: e.target.value } : x)),
                    );
                    setLayoutTouched(true);
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove tab ${t.name || ti + 1}`}
                  onClick={() => {
                    setTabs((prev) => prev.filter((_, k) => k !== ti));
                    setFields((prev) =>
                      prev.map((f) => (f.tab === t.apiId ? { ...f, tab: '', group: '' } : f)),
                    );
                    setLayoutTouched(true);
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </fieldset>

          {error && <DialogError>{error}</DialogError>}

          <DialogFooter>
            <DiscardAsk
              guard={guard}
              message={
                editing ? `Discard your changes to ${seed.name}?` : 'Discard this content type?'
              }
            >
              <GuardCancel guard={guard} />
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Create content type'}
              </Button>
            </DiscardAsk>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The guidance a field carries for whoever fills it, under its row: the help line and placeholder
 * an editor sees on the entry form, and the description agents read from the model. Each input
 * names the field it belongs to, since the rows repeat.
 */
function FieldGuidance(props: {
  id: string;
  fieldLabel: string;
  row: Pick<FieldRow, 'help' | 'placeholder' | 'description'>;
  onChange: (patch: Partial<Pick<FieldRow, 'help' | 'placeholder' | 'description'>>) => void;
}) {
  const { id, fieldLabel, row, onChange } = props;
  return (
    // A fieldset named for its field: the rows repeat, so the group says whose guidance it is.
    <fieldset id={id} className="basis-full space-y-2 rounded-xl bg-secondary/40 p-3">
      <legend className="sr-only">Guidance for {fieldLabel}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-help`} className="font-normal text-muted-foreground text-xs">
            Help text
          </Label>
          <Input
            id={`${id}-help`}
            aria-label={`Help text for ${fieldLabel}`}
            value={row.help}
            maxLength={FIELD_GUIDANCE_LIMITS.help}
            placeholder="Shown under the input"
            onChange={(e) => onChange({ help: e.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label
            htmlFor={`${id}-placeholder`}
            className="font-normal text-muted-foreground text-xs"
          >
            Placeholder
          </Label>
          <Input
            id={`${id}-placeholder`}
            aria-label={`Placeholder for ${fieldLabel}`}
            value={row.placeholder}
            maxLength={FIELD_GUIDANCE_LIMITS.placeholder}
            placeholder="An example value"
            onChange={(e) => onChange({ placeholder: e.target.value })}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-description`} className="font-normal text-muted-foreground text-xs">
          Description
        </Label>
        <Textarea
          id={`${id}-description`}
          aria-label={`Description for ${fieldLabel}`}
          aria-describedby={`${id}-hint`}
          rows={2}
          value={row.description}
          maxLength={FIELD_GUIDANCE_LIMITS.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
        <p id={`${id}-hint`} className="max-w-measure text-muted-foreground text-xs">
          What the field means. Agents read it from the model with the help text.
        </p>
      </div>
    </fieldset>
  );
}

/**
 * The rules that hide or disable a field while a sibling matches, under its row: one line per
 * rule, read as a sentence ("Hide when Status is sold"). Every control names its field and rule
 * number, since rows and rules both repeat. Rules the dialog can't draw are counted, not dropped.
 */
function FieldRules(props: {
  id: string;
  fieldLabel: string;
  row: Pick<FieldRow, 'rules' | 'keptRules'>;
  /** The other fields of the type, by the rows being edited. */
  siblings: readonly FieldRow[];
  onChange: (rules: RuleRow[]) => void;
}) {
  const { id, fieldLabel, row, siblings, onChange } = props;
  const named = siblings.filter((f) => f.apiId && f.name);
  const set = (index: number, patch: Partial<RuleRow>) =>
    onChange(row.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const full = row.rules.length + row.keptRules.length >= MAX_FIELD_RULES;
  return (
    <fieldset id={id} className="basis-full space-y-2 rounded-xl bg-secondary/40 p-3">
      <legend className="sr-only">Rules for {fieldLabel}</legend>
      {row.rules.length === 0 && row.keptRules.length === 0 && (
        <p className="max-w-measure text-muted-foreground text-xs">
          Hide this field, or make it read-only, while another field has a given value.
        </p>
      )}
      {row.rules.map((rule, r) => {
        const name = `${fieldLabel} rule ${r + 1}`;
        const sibling = named.find((f) => f.apiId === rule.field);
        const numeric = sibling ? NUMERIC.includes(sibling.type) : false;
        const operators = (Object.keys(OPERATOR_LABELS) as RuleOperator[]).filter(
          (op) => numeric || (op !== 'gt' && op !== 'lt'),
        );
        return (
          <div key={r} className="flex flex-wrap items-center gap-2">
            <NativeSelect
              size="sm"
              aria-label={`Action for ${name}`}
              value={rule.action}
              onChange={(e) => set(r, { action: e.target.value as RuleAction })}
            >
              <NativeSelectOption value="hide">Hide</NativeSelectOption>
              <NativeSelectOption value="disable">Make read-only</NativeSelectOption>
            </NativeSelect>
            <span className="text-muted-foreground text-xs">when</span>
            <NativeSelect
              size="sm"
              aria-label={`Field read by ${name}`}
              value={rule.field}
              onChange={(e) => {
                const next = named.find((f) => f.apiId === e.target.value);
                const keepsOperator =
                  (rule.operator !== 'gt' && rule.operator !== 'lt') ||
                  (next !== undefined && NUMERIC.includes(next.type));
                set(r, { field: e.target.value, ...(keepsOperator ? {} : { operator: 'eq' }) });
              }}
            >
              {!sibling && (
                <NativeSelectOption value={rule.field}>
                  {rule.field ? `${rule.field} (not a field)` : 'Choose a field'}
                </NativeSelectOption>
              )}
              {named.map((f) => (
                <NativeSelectOption key={f.apiId} value={f.apiId}>
                  {f.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <NativeSelect
              size="sm"
              aria-label={`Comparison for ${name}`}
              value={rule.operator}
              onChange={(e) => set(r, { operator: e.target.value as RuleOperator })}
            >
              {operators.map((op) => (
                <NativeSelectOption key={op} value={op}>
                  {OPERATOR_LABELS[op]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            {takesValue(rule.operator) && (
              <Input
                aria-label={`Value for ${name}`}
                className="h-8 w-40"
                value={rule.value}
                placeholder={rule.operator === 'in' ? 'a, b, c' : 'Value'}
                onChange={(e) => set(r, { value: e.target.value })}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${name}`}
              onClick={() => onChange(row.rules.filter((_, i) => i !== r))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        );
      })}
      {row.keptRules.length > 0 && (
        <p className="max-w-measure text-muted-foreground text-xs">
          {row.keptRules.length === 1
            ? '1 rule reads a field inside a component; it is kept as it is.'
            : `${row.keptRules.length} rules read fields inside a component; they are kept as they are.`}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={full || named.length === 0}
        aria-label={`Add rule to ${fieldLabel}`}
        onClick={() =>
          onChange([
            ...row.rules,
            { action: 'hide', field: named[0]?.apiId ?? '', operator: 'eq', value: '' },
          ])
        }
      >
        <Plus className="size-4" /> Add rule
      </Button>
    </fieldset>
  );
}

/** An icon's name as a menu reads it: `shopping-bag` → "Shopping bag". */
function iconLabel(name: string): string {
  const words = name.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the Date format menu offers, in an editor's words. */
const FORMAT_LABELS: readonly [DateFormat | '', string][] = [
  ['datetime', 'Date and time'],
  ['date', 'Date'],
  ['time', 'Time of day'],
  ['', 'Any ISO date'],
];

/**
 * The settings a field's type gives meaning to, under its row: a Date's format and earliest and
 * latest value, a text field's pattern, an asset link's allowed file types. Each control names
 * its field, since the rows repeat.
 */
function FieldSettings(props: {
  id: string;
  fieldLabel: string;
  kind: 'date' | 'text' | 'asset';
  value: SettingsRow;
  onChange: (patch: Partial<SettingsRow>) => void;
}) {
  const { id, fieldLabel, kind, value, onChange } = props;
  const inputType = value.format === 'date' ? 'date' : value.format === 'time' ? 'time' : 'text';
  const example = value.format ? DATE_FORMAT_EXAMPLES[value.format] : 'an ISO date';
  return (
    <fieldset id={id} className="basis-full space-y-2 rounded-xl bg-secondary/40 p-3">
      <legend className="sr-only">Settings for {fieldLabel}</legend>
      {kind === 'date' && (
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor={`${id}-format`} className="font-normal text-muted-foreground text-xs">
              Format
            </Label>
            <NativeSelect
              id={`${id}-format`}
              aria-label={`Format for ${fieldLabel}`}
              wrapperClassName="w-full"
              value={value.format}
              onChange={(e) => onChange({ format: e.target.value as DateFormat | '' })}
            >
              {FORMAT_LABELS.map(([f, label]) => (
                <NativeSelectOption key={f || 'any'} value={f}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {(['rangeMin', 'rangeMax'] as const).map((key) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`${id}-${key}`} className="font-normal text-muted-foreground text-xs">
                {key === 'rangeMin' ? 'Earliest' : 'Latest'}
              </Label>
              <Input
                id={`${id}-${key}`}
                aria-label={`${key === 'rangeMin' ? 'Earliest' : 'Latest'} value for ${fieldLabel}`}
                type={inputType}
                placeholder={example}
                value={value[key]}
                onChange={(e) => onChange({ [key]: e.target.value })}
              />
            </div>
          ))}
        </div>
      )}
      {kind === 'text' && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-pattern`} className="font-normal text-muted-foreground text-xs">
            Pattern
          </Label>
          <NativeSelect
            id={`${id}-pattern`}
            aria-label={`Pattern for ${fieldLabel}`}
            wrapperClassName="w-full max-w-sm"
            value={value.pattern}
            onChange={(e) => onChange({ pattern: e.target.value as SettingsRow['pattern'] })}
          >
            <NativeSelectOption value="">None</NativeSelectOption>
            {(Object.entries(PATTERN_PRESETS) as [PatternPreset, { name: string }][]).map(
              ([key, p]) => (
                <NativeSelectOption key={key} value={key}>
                  {p.name}
                </NativeSelectOption>
              ),
            )}
            {value.pattern === 'custom' && (
              <NativeSelectOption value="custom">Custom pattern (kept)</NativeSelectOption>
            )}
          </NativeSelect>
        </div>
      )}
      {kind === 'asset' && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-mime`} className="font-normal text-muted-foreground text-xs">
            Allowed file types
          </Label>
          <Input
            id={`${id}-mime`}
            aria-label={`Allowed file types for ${fieldLabel}`}
            aria-describedby={`${id}-mime-hint`}
            className="max-w-sm font-mono"
            placeholder="image/*, application/pdf"
            value={value.mimeTypes}
            onChange={(e) => onChange({ mimeTypes: e.target.value })}
          />
          <p id={`${id}-mime-hint`} className="max-w-measure text-muted-foreground text-xs">
            MIME types, comma-separated; image/* takes any image. Empty takes any file.
          </p>
        </div>
      )}
    </fieldset>
  );
}
