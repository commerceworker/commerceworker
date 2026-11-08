import {
  type AppContext,
  createContentType,
  createEntry,
  createPreviewLink,
  createSpace,
  getContentType,
  listContentTypes,
  publishContentType,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import type { FieldDefinition } from '@commerceworker/domain';
import { FixedClock } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * A content type's preview URL template on D1 (0035_content_type_preview): its own column, read
 * back with the type, cleared, never delivered, and read as unset on a replica behind the
 * migration. Each test makes its own space: the file shares one database.
 */
const store = createD1Store(testDb);
const uid = () => crypto.randomUUID();

async function harness() {
  const ctx: AppContext = { store, clock: new FixedClock(), ids: { newId: uid } };
  const spaceId = `ctp-${uid()}`;
  await createSpace(ctx, { spaceId, name: 'Preview', defaultLocale: 'en-US' });
  return { ctx, scope: { spaceId, environmentId: 'main' } };
}

const field = (
  apiId: string,
  type: FieldDefinition['type'],
  position: number,
): FieldDefinition => ({
  apiId,
  name: apiId,
  type,
  localized: false,
  required: false,
  position,
});

const TEMPLATE = 'https://site.example/blog/{field:slug}?entry={id}&token={token}';
const DRAFT = {
  apiId: 'article',
  name: 'Article',
  displayField: 'title',
  fields: [field('title', 'Symbol', 0), field('slug', 'Slug', 1)],
  preview: { urlTemplate: TEMPLATE },
};

describe('content type preview template on D1', () => {
  it('stores the template and reads it back with the type', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, SYSTEM_CALLER, scope, DRAFT);
    expect((await getContentType(ctx, scope, 'article')).preview).toEqual({
      urlTemplate: TEMPLATE,
    });
    expect((await listContentTypes(ctx, scope))[0]?.preview).toEqual({ urlTemplate: TEMPLATE });
    // A revision that leaves it out keeps it.
    await createContentType(ctx, SYSTEM_CALLER, scope, {
      ...DRAFT,
      preview: undefined,
      name: 'Post',
    });
    expect((await getContentType(ctx, scope, 'article')).preview?.urlTemplate).toBe(TEMPLATE);
  });

  it('clears it with null', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, SYSTEM_CALLER, scope, DRAFT);
    await createContentType(ctx, SYSTEM_CALLER, scope, { ...DRAFT, preview: null });
    expect(await getContentType(ctx, scope, 'article')).not.toHaveProperty('preview');
  });

  it('never serves it through Delivery', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, SYSTEM_CALLER, scope, DRAFT);
    await publishContentType(ctx, scope, 'article');
    const { contentTypes = [] } = await ctx.store.delivery.read(scope, { contentTypes: true });
    const delivered = contentTypes.find((t) => t.apiId === 'article');
    expect(delivered).toBeDefined();
    expect(delivered).not.toHaveProperty('preview');
  });

  it('reads the column’s own name, as a replica behind 0035 returns it, as no template', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, SYSTEM_CALLER, scope, DRAFT);
    await testDb
      .prepare(
        'UPDATE content_types SET preview_url_template = ? WHERE space_id = ? AND environment_id = ? AND api_id = ?',
      )
      .bind('preview_url_template', scope.spaceId, scope.environmentId, 'article')
      .run();
    expect(await getContentType(ctx, scope, 'article')).not.toHaveProperty('preview');
  });

  it('fills a preview link’s frontend URL from the stored template and the entry', async () => {
    const { ctx, scope } = await harness();
    await createContentType(ctx, SYSTEM_CALLER, scope, DRAFT);
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hello' }, slug: { 'en-US': 'hello-world' } },
    });
    const hasher = { hash: (s: string) => `h:${s}` };
    const link = await createPreviewLink(ctx, hasher, scope, entry.id, {
      previewBaseUrl: 'https://api.example',
    });
    expect(link.frontendUrl).toBe(
      `https://site.example/blog/hello-world?entry=${entry.id}&token=${link.token}`,
    );
  });
});
