import { describe, expect, it } from 'vitest';
import { emit, type OpenApiLike } from '../scripts/emit';

const json = (schema: Record<string, unknown>) => ({ content: { 'application/json': { schema } } });

const doc = (over: Partial<OpenApiLike['paths']> = {}): OpenApiLike => ({
  components: {
    schemas: {
      Thing: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  paths: {
    '/api/v1/things/{id}': {
      get: {
        operationId: 'get_thing',
        summary: 'Get a thing',
        parameters: [
          { name: 'id', in: 'path', required: true },
          { name: 'expand', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { '200': json({ $ref: '#/components/schemas/Thing' }) },
      },
    },
    '/api/v1/things': {
      post: {
        operationId: 'make_thing',
        requestBody: json({
          type: 'object',
          properties: {
            name: { type: 'string', description: 'A */ tricky name' },
            tags: { type: 'array', items: { type: 'string' } },
            kind: { enum: ['a', 'b'] },
            size: { type: ['number', 'null'] },
            pos: {
              type: 'array',
              prefixItems: [{ type: 'number' }, { type: 'number' }],
              items: false,
            },
            meta: {
              type: 'object',
              propertyNames: { type: 'string' },
              additionalProperties: { type: 'string' },
            },
          },
          required: ['name'],
        }),
        responses: {
          '201': json({
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          }),
        },
      },
    },
    ...over,
  },
});

describe('emit', () => {
  it('hoists request and result types by operation name and tables how to call each', () => {
    const out = emit(doc());
    expect(out).toContain(
      "get_thing: { method: 'GET', path: '/api/v1/things/{id}', pathParams: [\"id\"], input: 'query' }",
    );
    expect(out).toContain(
      "make_thing: { method: 'POST', path: '/api/v1/things', pathParams: [], input: 'body' }",
    );
    expect(out).toMatch(
      /export type GetThingInput = \{\n\s+id: string;\n\s+expand\?: boolean;\n\};/,
    );
    // A result that is a component is named for the operation and points at the component.
    expect(out).toContain('export type GetThingResult = Thing;');
    expect(out).toMatch(/export type Thing = \{\n\s+id: string;\n\};/);
    expect(out).toMatch(/export type MakeThingResult = \{\n\s+ok: boolean;\n\};/);
  });

  it('maps unions, enums, tuples, records, arrays and escapes doc comments', () => {
    const out = emit(doc());
    expect(out).toContain('tags?: string[];');
    expect(out).toContain('kind?: "a" | "b";');
    expect(out).toContain('size?: number | null;');
    expect(out).toContain('pos?: [number, number];');
    expect(out).toContain('meta?: { [key: string]: string };');
    expect(out).toContain('/** A *\\/ tricky name */');
  });

  it('types an untyped result unknown, and skips a signed receiver', () => {
    const out = emit(
      doc({
        '/api/v1/hook': {
          post: {
            operationId: 'receive_hook',
            security: [],
            requestBody: json({ type: 'object' }),
            responses: {},
          },
        },
        '/api/v1/plain': {
          get: { operationId: 'get_plain', responses: { '200': { description: 'x' } } },
        },
      }),
    );
    expect(out).toContain('export type GetPlainResult = unknown;');
    expect(out).not.toContain('receive_hook');
  });

  it('detects a cursor-paged list from its input and result, and refuses an ambiguous one', () => {
    const list = (result: Record<string, unknown>) =>
      doc({
        '/api/v1/rows': {
          get: {
            operationId: 'list_rows',
            parameters: [{ name: 'cursor', in: 'query', schema: { type: 'string' } }],
            responses: { '200': json(result) },
          },
        },
      });
    const rows = { type: 'array', items: { type: 'string' } };
    expect(
      emit(list({ type: 'object', properties: { rows, cursor: { type: ['string', 'null'] } } })),
    ).toContain("list_rows: { param: 'cursor', items: 'rows', next: 'cursor' }");
    expect(
      emit(
        list({ type: 'object', properties: { rows, nextCursor: { type: ['string', 'null'] } } }),
      ),
    ).toContain("list_rows: { param: 'cursor', items: 'rows', next: 'nextCursor' }");
    expect(() =>
      emit(list({ type: 'object', properties: { rows, more: rows, cursor: { type: 'string' } } })),
    ).toThrow('list_rows pages, but its result has 2 arrays');
  });

  it('flattens path params into a body input and sends a file as raw text', () => {
    const out = emit(
      doc({
        '/api/v1/files': {
          post: {
            operationId: 'upload_file',
            parameters: [
              { name: 'format', in: 'query', required: true, schema: { type: 'string' } },
            ],
            requestBody: { content: { 'text/csv': { schema: { type: 'string' } } } },
            responses: { '202': { description: 'x' } },
          },
        },
      }),
    );
    expect(out).toContain('input: \'raw\', contentTypes: ["text/csv"]');
    expect(out).toMatch(
      /export type UploadFileInput = \{\n\s+body: string;\n\s+contentType\?: "text\/csv";\n\s+format: string;\n\};/,
    );
  });

  it('throws on a keyword it does not know, and on a duplicate operationId', () => {
    const odd = doc({
      '/api/v1/odd': {
        get: { operationId: 'get_odd', responses: { '200': json({ not: { type: 'string' } }) } },
      },
    });
    expect(() => emit(odd)).toThrow('unsupported JSON Schema keyword "not"');
    const twice = doc({
      '/api/v1/again': { get: { operationId: 'get_thing', responses: {} } },
    });
    expect(() => emit(twice)).toThrow('operationId get_thing is used twice');
  });
});
