import { createHash } from 'node:crypto';
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import {
  type AppContext,
  createContentType,
  createSpace,
  publishContentType,
  SYSTEM_CALLER,
} from '@commerceworker/application';
import { type FieldDefinition, type Principal, SCOPES } from '@commerceworker/domain';
import { inMemoryEdge } from '@commerceworker/platform/in-memory';
import {
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
  StubAIProvider,
} from '@commerceworker/test-kit';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import type { McpDeps } from '../../src/mcp/deps';
import { buildServer } from '../../src/mcp/server';

const SPACE = 'space-1';
const scope = { spaceId: SPACE, environmentId: 'main' };

function makeDeps(): McpDeps {
  const ctx: AppContext = {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('m'),
  };
  return {
    ...inMemoryEdge(),
    ctx,
    ai: new StubAIProvider(() => ({})),
    rag: { embeddings: new LocalEmbeddingsProvider(8), vectors: new InMemoryVectorStore() },
    hasher: { hash: (v: string) => createHash('sha256').update(v).digest('hex') },
    adminToken: 'admin',
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai: new StubAIProvider(() => ({})) })),
  };
}

const admin: Principal = { spaceId: SPACE, kind: 'user', scopes: Object.values(SCOPES) };

interface ErrorBody {
  error: {
    code: string;
    message: string;
    issues: { field: string; locale?: string; message: string }[];
  };
}

const landingFields = [
  { apiId: 'title', name: 'Title', type: 'Symbol', localized: false, required: true, position: 0 },
  {
    apiId: 'body',
    name: 'Body',
    type: 'Array',
    localized: false,
    required: false,
    position: 1,
    items: {
      type: 'Component',
      variants: [
        {
          apiId: 'hero',
          name: 'Hero',
          fields: [
            {
              apiId: 'heading',
              name: 'Heading',
              type: 'Symbol',
              localized: false,
              required: true,
              position: 0,
            },
          ],
        },
      ],
    },
  },
] as FieldDefinition[];

describe('MCP validation errors carry their field issues', () => {
  let deps: McpDeps;
  let client: Client;
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const errorOf = (res: { content?: unknown }) => {
    const content = res.content as { type: string; text?: string }[];
    return JSON.parse(content.find((c) => c.type === 'text')?.text ?? 'null') as ErrorBody;
  };

  beforeEach(async () => {
    deps = makeDeps();
    await createSpace(deps.ctx, { spaceId: SPACE, name: 'Shop', defaultLocale: 'en-US' });
    await createContentType(deps.ctx, SYSTEM_CALLER, scope, {
      apiId: 'landing',
      name: 'Landing',
      displayField: 'title',
      fields: landingFields,
    });
    await publishContentType(deps.ctx, scope, 'landing');
    const server = buildServer(deps, admin);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  it('names the field, the locale and the reason, as the REST 422 body does', async () => {
    const res = await call('entries_create', { contentType: 'landing', fields: {} });
    expect(res.isError).toBe(true);
    expect(errorOf(res)).toEqual({
      error: {
        code: 'validation_failed',
        message: 'One or more fields are invalid',
        issues: [{ field: 'title', locale: 'en-US', message: 'Field is required' }],
      },
    });
  });

  it('keeps the path into a block, so an agent can find the nested field', async () => {
    const res = await call('entries_create', {
      contentType: 'landing',
      fields: { title: { 'en-US': 'Home' }, body: { 'en-US': [{ _type: 'hero' }] } },
    });
    expect(res.isError).toBe(true);
    const { issues } = errorOf(res).error;
    expect(issues).toContainEqual(
      expect.objectContaining({ field: 'body[0].heading', locale: 'en-US' }),
    );
  });

  it('does the same for an update, through the one shared mapping', async () => {
    const created = await call('entries_create', {
      contentType: 'landing',
      fields: { title: { 'en-US': 'Home' } },
    });
    const { id } = (
      JSON.parse((created.content as { text: string }[])[0]?.text ?? '{}') as {
        entry: { id: string };
      }
    ).entry;
    const res = await call('entries_update', { id, fields: { title: { 'en-US': 42 } } });
    expect(res.isError).toBe(true);
    expect(errorOf(res).error.issues[0]).toMatchObject({ field: 'title', locale: 'en-US' });
  });

  it('leaves other failures as their message', async () => {
    const res = await call('entries_get', { id: 'missing' });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain('was not found');
    expect(text).not.toContain('issues');
  });
});
