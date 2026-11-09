import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getEntry,
  publishContentType,
  SYSTEM_CALLER,
  updateContentType,
} from '@commerceworker/application';
import { type FieldDefinition, type Principal, SCOPES } from '@commerceworker/domain';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import {
  FakeBlobStore,
  FakePasswordHasher,
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };

const admin: Principal = { spaceId: '*', kind: 'admin', scopes: Object.values(SCOPES) };
// Writes the page's body, reads but may not write its sidebar, and may not see its notes.
const writer: Principal = {
  spaceId: SPACE,
  kind: 'cma',
  scopes: [SCOPES.previewRead, SCOPES.contentWrite],
  contentGrants: [
    {
      contentTypeApiId: 'page',
      actions: ['read', 'write'],
      readOnlyFields: ['sidebar'],
      deniedFields: ['notes'],
    },
  ],
};
// Holds the coarse write scope, but its role only reads the type.
const reader: Principal = {
  ...writer,
  contentGrants: [{ contentTypeApiId: 'page', actions: ['read'] }],
};

const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'apiId' | 'type'>) =>
  ({
    name: over.apiId,
    localized: false,
    required: false,
    position: 0,
    ...over,
  }) as FieldDefinition;
const cta = {
  apiId: 'cta',
  name: 'Call to action',
  fields: [field({ apiId: 'label', type: 'Symbol' })],
};
const blocks = (apiId: string, position: number) =>
  field({ apiId, type: 'Array', position, items: { type: 'Component', variants: [cta] } });

async function setup(principal: Principal = admin) {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
    passwords: new FakePasswordHasher(),
  };
  const deps: McpDeps = {
    ...inMemoryEdge(),
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
    blob: new FakeBlobStore(),
  };
  await createSpace(ctx, { spaceId: SPACE, name: 'Site', defaultLocale: 'en-US' });
  await createContentType(ctx, SYSTEM_CALLER, scope, {
    apiId: 'page',
    name: 'Page',
    displayField: 'title',
    fields: [
      field({ apiId: 'title', type: 'Symbol' }),
      blocks('body', 1),
      blocks('sidebar', 2),
      blocks('notes', 3),
    ],
  });
  await publishContentType(ctx, scope, 'page');
  const { entry, fields } = await createEntry(ctx, scope, {
    contentTypeApiId: 'page',
    fields: {
      title: { 'en-US': 'Home' },
      body: { 'en-US': [{ _type: 'cta', label: 'Sign up' }] },
      sidebar: { 'en-US': [{ _type: 'cta', label: 'Follow' }] },
      notes: { 'en-US': [{ _type: 'cta', label: 'Internal' }] },
    },
  });
  const keyOf = (apiId: string) =>
    ((fields[apiId]?.['en-US'] ?? []) as { _key: string }[])[0]?._key;

  const server = buildServer(deps, principal);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: { space: SPACE, ...args } })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? 'null';
    return { isError: r.isError === true, text };
  };
  return {
    ctx,
    client,
    id: entry.id,
    body: keyOf('body') as string,
    sidebar: keyOf('sidebar'),
    call,
  };
}

describe('the blocks tools', () => {
  it('outlines the blocks, then patches them at the version the outline gave', async () => {
    const { ctx, id, body, call } = await setup();
    const outlined = await call('entry_blocks_outline', { id, field: 'body' });
    expect(outlined.isError, outlined.text).toBe(false);
    const outline = JSON.parse(outlined.text);
    expect(outline).toEqual({
      entryId: id,
      version: 1,
      fields: {
        body: {
          'en-US': [
            { key: body, type: 'cta', name: 'Call to action', label: 'Sign up', path: 'body[0]' },
          ],
        },
      },
    });

    const patched = await call('entry_blocks_patch', {
      id,
      expectedVersion: outline.version,
      ops: [
        { op: 'duplicate', field: 'body', key: body, ref: 'copy' },
        { op: 'update', field: 'body', key: 'copy', set: { label: 'Sign up today' } },
      ],
    });
    expect(patched.isError, patched.text).toBe(false);
    const saved = JSON.parse(patched.text);
    expect(saved.entry.currentVersion).toBe(2);
    expect(saved.fields.body['en-US']).toEqual([
      { _type: 'cta', _key: body, label: 'Sign up' },
      { _type: 'cta', _key: saved.keys.copy, label: 'Sign up today' },
    ]);
    // Undone last op first: the copy's label back, then the copy gone.
    expect(saved.inverse).toEqual([
      {
        op: 'update',
        field: 'body',
        locale: 'en-US',
        key: saved.keys.copy,
        set: { label: 'Sign up' },
      },
      { op: 'remove', field: 'body', locale: 'en-US', key: saved.keys.copy },
    ]);
    expect((await getEntry(ctx, scope, id)).entry.currentVersion).toBe(2);
  });

  it('answers a refused op with REST’s 422 body, naming the op', async () => {
    const { id, body, call } = await setup();
    const r = await call('entry_blocks_patch', {
      id,
      expectedVersion: 1,
      ops: [
        { op: 'remove', field: 'body', key: body },
        { op: 'insert', field: 'body', block: { _type: 'hero' } },
      ],
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text).error.issues).toEqual([
      {
        op: 1,
        field: 'ops[1]',
        locale: 'en-US',
        code: 'type_not_allowed',
        message: 'A "hero" block can’t go here (one of: cta)',
      },
    ]);
  });

  it('refuses a stale expectedVersion, saving nothing', async () => {
    const { ctx, id, body, call } = await setup();
    const r = await call('entry_blocks_patch', {
      id,
      expectedVersion: 3,
      ops: [{ op: 'remove', field: 'body', key: body }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('is at version 1, not 3');
    expect((await getEntry(ctx, scope, id)).entry.currentVersion).toBe(1);
  });

  it('marks the outline read-only and the patch audited', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const outline = tools.find((t) => t.name === 'entry_blocks_outline');
    const patch = tools.find((t) => t.name === 'entry_blocks_patch');
    expect(outline?.annotations?.readOnlyHint).toBe(true);
    expect(patch).toBeDefined();
    expect(patch?.annotations?.readOnlyHint).not.toBe(true);
    expect(tools.find((t) => t.name === 'entry_blocks_validate')?.annotations?.readOnlyHint).toBe(
      true,
    );
  });

  it('checks a patch without saving it, refusing as the patch would', async () => {
    const { ctx, id, body, call } = await setup();
    const ok = await call('entry_blocks_validate', {
      id,
      expectedVersion: 1,
      ops: [{ op: 'update', field: 'body', key: body, set: { label: 'Join' } }],
    });
    expect(ok.isError, ok.text).toBe(false);
    const checked = JSON.parse(ok.text);
    expect(checked.fields.body['en-US']).toEqual([{ _type: 'cta', _key: body, label: 'Join' }]);
    expect(checked.applied[0]).toMatchObject({ op: 'update', locale: 'en-US', key: body });
    const stale = await call('entry_blocks_validate', {
      id,
      expectedVersion: 2,
      ops: [{ op: 'remove', field: 'body', key: body }],
    });
    expect(stale.isError).toBe(true);
    expect((await getEntry(ctx, scope, id)).entry.currentVersion).toBe(1);
  });
});

describe('the blocks tools for a restricted role', () => {
  it('patches a field it may write, and hides the field it may not read', async () => {
    const { id, body, call } = await setup(writer);
    const outline = JSON.parse((await call('entry_blocks_outline', { id })).text);
    expect(Object.keys(outline.fields)).toEqual(['body', 'sidebar']);
    const r = await call('entry_blocks_patch', {
      id,
      expectedVersion: 1,
      ops: [{ op: 'update', field: 'body', key: body, set: { label: 'Join' } }],
    });
    expect(r.isError, r.text).toBe(false);
    expect(Object.keys(JSON.parse(r.text).fields).sort()).toEqual(['body', 'sidebar', 'title']);
  });

  it('refuses an op on a read-only field, and any patch for a role that only reads', async () => {
    const restricted = await setup(writer);
    const sidebar = await restricted.call('entry_blocks_patch', {
      id: restricted.id,
      expectedVersion: 1,
      ops: [{ op: 'remove', field: 'sidebar', key: restricted.sidebar }],
    });
    expect(sidebar.isError).toBe(true);
    expect(sidebar.text).toContain('content:write:page.sidebar');
    expect((await getEntry(restricted.ctx, scope, restricted.id)).entry.currentVersion).toBe(1);

    const readOnly = await setup(reader);
    const r = await readOnly.call('entry_blocks_patch', {
      id: readOnly.id,
      expectedVersion: 1,
      ops: [{ op: 'remove', field: 'body', key: readOnly.body }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('content:write:page');
    expect((await readOnly.call('entry_blocks_outline', { id: readOnly.id })).isError).toBe(false);
  });

  it('counts a stored value it can’t read that fails a rule, as REST does', async () => {
    const { ctx, id, body, call } = await setup(writer);
    // A rule added to the notes' blocks after they were saved: the stored one now fails it.
    const stricter = {
      ...cta,
      fields: [...cta.fields, field({ apiId: 'url', type: 'Symbol', position: 1, required: true })],
    };
    await updateContentType(ctx, SYSTEM_CALLER, scope, 'page', {
      fields: [
        field({ apiId: 'title', type: 'Symbol' }),
        blocks('body', 1),
        blocks('sidebar', 2),
        field({
          apiId: 'notes',
          type: 'Array',
          position: 3,
          items: { type: 'Component', variants: [stricter] },
        }),
      ],
    });
    await publishContentType(ctx, scope, 'page');
    for (const tool of ['entry_blocks_patch', 'entry_blocks_validate']) {
      const r = await call(tool, {
        id,
        expectedVersion: 1,
        ops: [{ op: 'update', field: 'body', key: body, set: { label: 'Join' } }],
      });
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.text).error.issues).toEqual([
        expect.objectContaining({ field: '', code: 'hidden', hidden: 1 }),
      ]);
      expect(r.text).not.toContain('notes');
    }
  });

  it('answers a refusal with REST’s 403 body: a read-only field named, a hidden one counted', async () => {
    const { id, sidebar, call } = await setup(writer);
    for (const tool of ['entry_blocks_patch', 'entry_blocks_validate']) {
      const locked = await call(tool, {
        id,
        expectedVersion: 1,
        ops: [{ op: 'remove', field: 'sidebar', key: sidebar }],
      });
      expect(locked.isError).toBe(true);
      expect(JSON.parse(locked.text).error).toMatchObject({
        code: 'forbidden',
        details: { reason: 'read_only', field: 'sidebar' },
      });
      const hidden = await call(tool, {
        id,
        expectedVersion: 1,
        ops: [{ op: 'insert', field: 'notes', block: { _type: 'cta' } }],
      });
      expect(JSON.parse(hidden.text).error).toMatchObject({
        code: 'forbidden',
        details: { reason: 'hidden', hidden: 1 },
      });
      expect(hidden.text).not.toContain('notes');
    }
  });
});
