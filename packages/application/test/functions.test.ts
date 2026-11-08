import type { DomainEvent } from '@commerceworker/domain';
import { ValidationError } from '@commerceworker/domain';
import type { FunctionInvokeResult, FunctionInvoker } from '@commerceworker/ports';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@commerceworker/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createFunction,
  createSpace,
  deleteFunction,
  eventMatches,
  invokeFunctionsForEvent,
  listFunctions,
} from '../src/index';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('f') };
  return { ctx };
}

function event(type: string): DomainEvent {
  return {
    id: `evt-${type}`,
    scope,
    occurredAt: '2026-01-01T00:00:00.000Z',
    type,
    entryId: 'e1',
    contentTypeApiId: 'post',
    version: 1,
    fields: {},
  } as DomainEvent;
}

/** Records every invocation; returns a configurable result. */
class RecordingInvoker implements FunctionInvoker {
  readonly calls: { url: string; type: string }[] = [];
  constructor(private readonly result: FunctionInvokeResult = { ok: true, statusCode: 200 }) {}
  async invoke(url: string, e: DomainEvent): Promise<FunctionInvokeResult> {
    this.calls.push({ url, type: e.type });
    return this.result;
  }
}

describe('eventMatches', () => {
  it('matches all, prefix, and exact patterns', () => {
    expect(eventMatches('*', 'entry.published')).toBe(true);
    expect(eventMatches('entry.*', 'entry.published')).toBe(true);
    expect(eventMatches('entry.*', 'content_type.published')).toBe(false);
    expect(eventMatches('entry.published', 'entry.published')).toBe(true);
    expect(eventMatches('entry.published', 'entry.unpublished')).toBe(false);
  });
});

describe('functions CRUD', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('creates, lists, and deletes a function', async () => {
    const fn = await createFunction(ctx, scope, {
      name: 'reindex',
      eventPattern: 'entry.*',
      url: 'https://example.com/hook',
    });
    expect(fn.active).toBe(true);
    expect(await listFunctions(ctx, scope)).toHaveLength(1);
    await deleteFunction(ctx, scope, fn.id);
    expect(await listFunctions(ctx, scope)).toHaveLength(0);
  });

  it('rejects a non-http url', async () => {
    await expect(
      createFunction(ctx, scope, { name: 'x', eventPattern: '*', url: 'ftp://bad' }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('invokeFunctionsForEvent', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  it('invokes only active functions whose pattern matches', async () => {
    await createFunction(ctx, scope, {
      name: 'a',
      eventPattern: 'entry.published',
      url: 'https://a/',
    });
    await createFunction(ctx, scope, {
      name: 'b',
      eventPattern: 'content_type.*',
      url: 'https://b/',
    });
    const inactive = await createFunction(ctx, scope, {
      name: 'c',
      eventPattern: '*',
      url: 'https://c/',
    });
    await deleteFunction(ctx, scope, inactive.id); // simulate "not active" by removing

    const invoker = new RecordingInvoker();
    const results = await invokeFunctionsForEvent(ctx, invoker, event('entry.published'));
    expect(invoker.calls.map((c) => c.url)).toEqual(['https://a/']);
    expect(results).toHaveLength(1);
    expect(results[0]?.result.ok).toBe(true);
  });

  it('captures an invoker failure without throwing', async () => {
    await createFunction(ctx, scope, { name: 'a', eventPattern: '*', url: 'https://a/' });
    const invoker: FunctionInvoker = {
      invoke: async () => {
        throw new Error('boom');
      },
    };
    const results = await invokeFunctionsForEvent(ctx, invoker, event('entry.published'));
    expect(results[0]?.result.ok).toBe(false);
    expect(results[0]?.result.error).toBe('boom');
  });
});
