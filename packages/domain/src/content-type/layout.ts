import { ValidationError } from '../errors';
import { type FieldDefinition, isValidApiId } from './field';

/**
 * A content type's editor layout: how the admin's entry form arranges the type's top-level fields
 * into tabs, and fields within a tab into named groups. It is presentation for editors only. It
 * changes nothing about what is stored, validated or delivered, and Delivery never serves it.
 *
 * A field the layout does not place is drawn after the placed ones on the first tab, so a field
 * added later is never lost from the form.
 */
export interface ContentTypeLayout {
  readonly tabs: readonly LayoutTab[];
}

export interface LayoutTab {
  /** Stable identifier, unique within the layout (a legal apiId). */
  readonly apiId: string;
  readonly name: string;
  readonly groups: readonly LayoutGroup[];
}

/** Fields shown together. Unnamed, a group is just fields in order; named, a titled set. */
export interface LayoutGroup {
  readonly name?: string;
  /** Top-level field apiIds, in the order shown. Each field is placed at most once. */
  readonly fields: readonly string[];
  /** Drawn closed until opened. Only meaningful on a named group. */
  readonly collapsed?: boolean;
}

/** Most tabs, groups per tab, and longest tab or group name. */
export const LAYOUT_LIMITS = { tabs: 20, groupsPerTab: 50, name: 100 } as const;

/**
 * Checks a layout against the fields it arranges, or throws `ValidationError` on `layout`. A field
 * named in `removed` (the fields a revision drops) is taken out of the layout rather than refused,
 * since the form has nothing to draw for it; a group, tab or layout left empty goes with it.
 * Returns the layout to store, or undefined when nothing is left.
 */
export function checkLayout(
  layout: unknown,
  fields: readonly FieldDefinition[],
  removed: ReadonlySet<string> = new Set(),
): ContentTypeLayout | undefined {
  const fail = (message: string): never => {
    throw new ValidationError([{ field: 'layout', message }]);
  };
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  const name = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || v.trim() === '') fail(`${what} needs a name`);
    const text = (v as string).trim();
    if (text.length > LAYOUT_LIMITS.name) {
      fail(`${what} name is at most ${LAYOUT_LIMITS.name} characters`);
    }
    return text;
  };
  if (!isObject(layout) || !Array.isArray(layout.tabs)) fail('A layout is { tabs: [...] }');
  const tabs = (layout as { tabs: unknown[] }).tabs;
  if (tabs.length === 0) fail('A layout has at least one tab');
  if (tabs.length > LAYOUT_LIMITS.tabs) fail(`A layout has at most ${LAYOUT_LIMITS.tabs} tabs`);

  const known = new Set(fields.map((f) => f.apiId));
  const placed = new Set<string>();
  const tabIds = new Set<string>();
  const out: LayoutTab[] = [];
  for (const tab of tabs) {
    if (!isObject(tab)) fail('A tab is { apiId, name, groups }');
    const t = tab as Record<string, unknown>;
    const apiId = t.apiId;
    if (typeof apiId !== 'string' || !isValidApiId(apiId)) {
      fail(`Invalid tab apiId "${String(apiId)}"`);
    }
    if (tabIds.has(apiId as string)) fail(`Duplicate tab apiId "${apiId}"`);
    tabIds.add(apiId as string);
    const tabName = name(t.name, `Tab "${apiId}"`);
    if (!Array.isArray(t.groups)) fail(`Tab "${apiId}" lists its groups`);
    const groups = t.groups as unknown[];
    if (groups.length > LAYOUT_LIMITS.groupsPerTab) {
      fail(`Tab "${apiId}" has at most ${LAYOUT_LIMITS.groupsPerTab} groups`);
    }
    const kept: LayoutGroup[] = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.fields)) {
        fail(`A group in tab "${apiId}" is { name?, fields: [...] }`);
      }
      const g = group as Record<string, unknown>;
      const groupName =
        g.name === undefined || g.name === null ? undefined : name(g.name, 'A group');
      if (g.collapsed !== undefined && typeof g.collapsed !== 'boolean') {
        fail('A group’s collapsed is true or false');
      }
      const groupFields: string[] = [];
      for (const field of g.fields as unknown[]) {
        if (typeof field !== 'string') fail(`Tab "${apiId}" lists fields by apiId`);
        const f = field as string;
        if (removed.has(f)) continue;
        if (!known.has(f)) fail(`The layout places "${f}", which is not a field of this type`);
        if (placed.has(f)) fail(`The layout places "${f}" twice`);
        placed.add(f);
        groupFields.push(f);
      }
      if (groupFields.length === 0) continue;
      kept.push({
        ...(groupName ? { name: groupName } : {}),
        fields: groupFields,
        ...(groupName && g.collapsed === true ? { collapsed: true } : {}),
      });
    }
    if (kept.length > 0) out.push({ apiId: apiId as string, name: tabName, groups: kept });
  }
  return out.length > 0 ? { tabs: out } : undefined;
}

/** One tab of the entry form, its groups resolved to field definitions. */
export interface ResolvedTab {
  readonly apiId: string;
  readonly name: string;
  readonly groups: readonly {
    readonly name?: string;
    readonly collapsed?: boolean;
    readonly fields: readonly FieldDefinition[];
  }[];
}

/**
 * The entry form's tabs: the layout's, each group's fields resolved in the order given, and every
 * field the layout does not place in one unnamed group at the end of the first tab, in field order.
 * Without a layout, one tab holding every field. Names a stored layout no longer matches are
 * skipped, so a stale layout can never hide a field.
 */
export function layoutTabs(
  fields: readonly FieldDefinition[],
  layout: ContentTypeLayout | undefined,
): ResolvedTab[] {
  const byId = new Map(fields.map((f) => [f.apiId, f]));
  const placed = new Set<string>();
  const tabs: ResolvedTab[] = [];
  const storedTabs: readonly LayoutTab[] = Array.isArray(layout?.tabs) ? layout.tabs : [];
  for (const tab of storedTabs) {
    const storedGroups: readonly LayoutGroup[] = Array.isArray(tab.groups) ? tab.groups : [];
    const groups = storedGroups
      .map((g) => ({
        ...(g.name ? { name: g.name } : {}),
        ...(g.collapsed ? { collapsed: true } : {}),
        fields: (Array.isArray(g.fields) ? g.fields : []).flatMap((apiId: string) => {
          const f = byId.get(apiId);
          if (!f || placed.has(apiId)) return [];
          placed.add(apiId);
          return [f];
        }),
      }))
      .filter((g) => g.fields.length > 0);
    if (groups.length > 0) tabs.push({ apiId: tab.apiId, name: tab.name, groups });
  }
  const rest = fields.filter((f) => !placed.has(f.apiId));
  if (tabs.length === 0) return [{ apiId: 'fields', name: 'Fields', groups: [{ fields: rest }] }];
  if (rest.length > 0) {
    const [first, ...others] = tabs as [ResolvedTab, ...ResolvedTab[]];
    tabs.splice(
      0,
      tabs.length,
      { ...first, groups: [...first.groups, { fields: rest }] },
      ...others,
    );
  }
  return tabs;
}
