import type { Resource } from 'i18next';

/** Deep-merge i18next Resource objects by language and namespace. */
export function mergeResources(base: Resource, extra: Resource): Resource {
  const langs = new Set([...Object.keys(base), ...Object.keys(extra)]);
  const out: Resource = {};
  for (const lng of langs) {
    const b = base[lng];
    const e = extra[lng];
    if (!b && !e) continue;
    const nsNames = new Set([...Object.keys(b ?? {}), ...Object.keys(e ?? {})]);
    const lngBucket = {} as NonNullable<Resource[string]>;
    out[lng] = lngBucket;
    for (const ns of nsNames) {
      const bNs = b?.[ns];
      const eNs = e?.[ns];
      if (bNs && eNs && typeof bNs === 'object' && typeof eNs === 'object') {
        lngBucket[ns] = { ...bNs, ...eNs } as Record<string, unknown>;
      } else {
        lngBucket[ns] = (eNs ?? bNs) as Record<string, unknown>;
      }
    }
  }
  return out;
}
