import {
  type AppContext,
  createContentType,
  createSpace,
  getContentType,
  listContentTypes,
  publishContentType,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import { FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * A content type's group, description, icon and editor layout on D1
 * (0026_content_type_details): stored in their own columns, read back with the type, cleared, and
 * left alone by a save that only knows the older columns. Each test makes its own space: the file
 * shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();

async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
  const spaceId = `ctd-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Details', defaultLocale: 'en-US' });
  return { ctx, scope: { spaceId, environmentId: 'main' } };
}

const field = (apiId: string, position: number): FieldDefinition => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});

const DRAFT = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  fields: [field('title', 0), field('summary', 1)],
  group: 'Editorial',
  description: 'Long reads for the magazine.',
  icon: 'newspaper',
  agentInstructions: 'Keep titles short.',
  layout: {
    tabs: [
      { apiId: 'main', name: 'Main', groups: [{ fields: ['title'] }] },
      { apiId: 'more', name: 'More', groups: [{ name: 'Teaser', fields: ['summary'] }] },
    ],
  },
};

describe('content type details on D1', () => {
  it('stores group, description, icon and layout, and reads them back', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, SYSTEM_CALLER, scope, DRAFT);
    await publishContentType(ctx, scope, 'article');
    const got = await getContentType(ctx, scope, 'article');
    expect(got).toMatchObject({
      group: 'Editorial',
      description: 'Long reads for the magazine.',
      icon: 'newspaper',
      agentInstructions: 'Keep titles short.',
      layout: DRAFT.layout,
      status: 'published',
    });
    expect((await listContentTypes(ctx, scope))[0]?.layout).toEqual(DRAFT.layout);
  });

  it('never serves agent instructions through Delivery', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, SYSTEM_CALLER, scope, DRAFT);
    await publishContentType(ctx, scope, 'article');
    const { contentTypes = [] } = await ctx.store.delivery.read(scope, { contentTypes: true });
    const delivered = contentTypes.find((t) => t.apiId === 'article');
    expect(delivered).toBeDefined();
    expect(delivered).not.toHaveProperty('agentInstructions');
  });

  it('reads the column’s own name, as a replica behind 0032 returns it, as no instructions', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, SYSTEM_CALLER, scope, DRAFT);
    await testDb
      .prepare(
        'UPDATE content_types SET agent_instructions = ? WHERE space_id = ? AND environment_id = ? AND api_id = ?',
      )
      .bind('agent_instructions', scope.spaceId, scope.environmentId, 'article')
      .run();
    expect(await getContentType(ctx, scope, 'article')).not.toHaveProperty('agentInstructions');
  });

  it('clears them with null', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, SYSTEM_CALLER, scope, DRAFT);
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      ...DRAFT,
      group: null,
      description: null,
      icon: null,
      agentInstructions: null,
      layout: null,
    });
    const got = await getContentType(ctx, scope, 'article');
    for (const key of ['group', 'description', 'icon', 'agentInstructions', 'layout']) {
      expect(got).not.toHaveProperty(key);
    }
  });

  it('a save of a type without them (as an older release writes it) leaves them as they were', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, SYSTEM_CALLER, scope, DRAFT);
    const current = await getContentType(ctx, scope, 'article');
    // The older release's upsert names only the columns it knows, which this mirrors: the
    // store's own upsert writes them all, so an older row shape is simulated by raw SQL.
    await testDb
      .prepare(
        'UPDATE content_types SET name = ?, version = version + 1 WHERE space_id = ? AND environment_id = ? AND api_id = ?',
      )
      .bind('Articles', scope.spaceId, scope.environmentId, 'article')
      .run();
    const after: ContentType = await getContentType(ctx, scope, 'article');
    expect(after.name).toBe('Articles');
    expect(after.layout).toEqual(current.layout);
    expect(after.group).toBe('Editorial');
  });
});
