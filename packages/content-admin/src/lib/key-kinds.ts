import type { ApiKeyKind } from './management';

/**
 * What each kind of API key is for, in the product's words. The acronym stays in a tooltip, for
 * people who know the APIs by it, and never stands in for the label.
 */
export const KEY_KINDS: readonly {
  readonly value: ApiKeyKind;
  readonly label: string;
  readonly api: string;
  readonly reads: string;
}[] = [
  {
    value: 'cda',
    label: 'Delivery',
    api: 'Content Delivery API (CDA)',
    reads: 'reads published content',
  },
  { value: 'cpa', label: 'Preview', api: 'Content Preview API (CPA)', reads: 'reads drafts' },
  {
    value: 'cma',
    label: 'Management',
    api: 'Content Management API (CMA)',
    reads: 'writes and publishes',
  },
];

/** A key kind's word ("Delivery"), or the raw kind when it isn't one we know. */
export const keyKindLabel = (kind: string) =>
  KEY_KINDS.find((k) => k.value === kind)?.label ?? kind;

/** A key kind's API name with its acronym ("Content Delivery API (CDA)"), for a tooltip. */
export const keyKindApi = (kind: string) => KEY_KINDS.find((k) => k.value === kind)?.api;
