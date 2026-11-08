import {
  createConcept,
  createScheme,
  createTag,
  listConcepts,
  listSchemes,
  listTags,
} from '@commerceworker/application';
import type { SeedRun } from './types';

export interface TaxonomySeed {
  readonly tagIds: readonly string[];
  readonly conceptIds: readonly string[];
}

const TAG_NAMES = [
  'featured',
  'tutorial',
  'announcement',
  'deep-dive',
  'changelog',
  'case-study',
  'community',
  'benchmark',
  'evergreen',
  'needs-review',
  'sponsored',
  'archived',
] as const;

const SCHEMES = [
  {
    name: 'Topics',
    concepts: [
      {
        label: 'Content management',
        children: ['CMS basics', 'Modeling patterns', 'Migrations', 'Governance'],
      },
      {
        label: 'AI & automation',
        children: ['Agent workflows', 'Generation', 'Human-in-the-loop', 'Cost control'],
      },
      { label: 'Delivery', children: ['Edge caching', 'GraphQL', 'Image pipelines'] },
      { label: 'Collaboration', children: ['Review workflows', 'Tasks & comments'] },
    ],
  },
  {
    name: 'Regions',
    concepts: [
      { label: 'Americas', children: ['North America', 'LATAM'] },
      { label: 'EMEA', children: ['DACH', 'UK & Ireland'] },
      { label: 'APAC', children: ['Japan', 'ANZ'] },
    ],
  },
] as const;

/** Two concept schemes (with hierarchy) and twelve tags; idempotent by name. */
export async function seedTaxonomy(run: SeedRun): Promise<TaxonomySeed> {
  const { ctx, scope } = run;

  const tags = await listTags(ctx, scope);
  const tagIds: string[] = [];
  for (const name of TAG_NAMES) {
    let tag = tags.find((t) => t.name === name);
    if (!tag) {
      tag = await createTag(ctx, scope, { name });
      tags.push(tag);
    }
    tagIds.push(tag.id);
  }

  const schemes = await listSchemes(ctx, scope);
  const conceptIds: string[] = [];
  for (const def of SCHEMES) {
    let scheme = schemes.find((s) => s.name === def.name);
    if (!scheme) scheme = await createScheme(ctx, scope, { name: def.name });
    const existing = await listConcepts(ctx, scope, scheme.id);

    const ensure = async (prefLabel: string, broaderId?: string | null) => {
      const found = existing.find((c) => c.prefLabel === prefLabel);
      if (found) return found;
      const concept = await createConcept(ctx, scope, {
        schemeId: scheme.id,
        prefLabel,
        broaderId,
      });
      existing.push(concept);
      return concept;
    };

    for (const root of def.concepts) {
      const parent = await ensure(root.label);
      conceptIds.push(parent.id);
      for (const child of root.children) {
        const c = await ensure(child, parent.id);
        conceptIds.push(c.id);
      }
    }
  }

  return { tagIds, conceptIds };
}
