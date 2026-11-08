import { describe, expect, it, vi } from 'vitest';
import { createManagementClient } from '../src/index.js';

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'cma' };

const recording = () => {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input)}${init?.body ? ` ${init.body}` : ''}`);
    return Response.json({});
  }) as unknown as typeof fetch;
  return { calls, client: createManagementClient({ ...base, fetch: fetchImpl }) };
};

describe('@commerceworker/sdk-management entry blocks', () => {
  it('patches blocks by key at the version read', async () => {
    const { calls, client } = recording();
    await client.entries.patchBlocks('e1', {
      expectedVersion: 3,
      ops: [
        {
          op: 'insert',
          field: 'body',
          after: 'k1',
          block: { _type: 'cta', label: 'Go' },
          ref: 'a',
        },
        { op: 'remove', field: 'body', key: 'k2' },
      ],
    });
    expect(calls).toEqual([
      'PATCH https://cms.test/spaces/s1/environments/main/entries/e1/blocks ' +
        '{"expectedVersion":3,"ops":[{"op":"insert","field":"body","after":"k1","block":' +
        '{"_type":"cta","label":"Go"},"ref":"a"},{"op":"remove","field":"body","key":"k2"}]}',
    ]);
  });

  it('checks a patch without saving it, naming the entry in the body', async () => {
    const { calls, client } = recording();
    await client.entries.checkBlocks('e1', {
      expectedVersion: 3,
      ops: [{ op: 'remove', field: 'body', key: 'k2' }],
    });
    expect(calls).toEqual([
      'POST https://cms.test/spaces/s1/environments/main/entries/blocks/validate ' +
        '{"entryId":"e1","expectedVersion":3,"ops":[{"op":"remove","field":"body","key":"k2"}]}',
    ]);
  });

  it('outlines blocks, narrowed to a field', async () => {
    const { calls, client } = recording();
    await client.entries.outlineBlocks('e1', { field: 'body' });
    expect(calls).toEqual([
      'GET https://cms.test/spaces/s1/environments/main/entries/e1/blocks?field=body',
    ]);
  });
});
