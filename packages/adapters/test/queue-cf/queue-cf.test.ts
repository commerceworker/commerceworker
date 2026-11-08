import { describe, expect, it } from 'vitest';
import {
  type CfQueueBinding,
  createAssetIngestQueue,
  createCfQueueProducer,
} from '../../src/queue-cf/index';

type Sent = { body: unknown; delaySeconds?: number };

function makeBinding() {
  const sends: Sent[] = [];
  const batches: Sent[][] = [];
  const binding: CfQueueBinding = {
    async send(message, options) {
      sends.push({ body: message, ...(options?.delaySeconds ? options : {}) });
    },
    async sendBatch(messages) {
      batches.push([...messages]);
    },
  };
  return { binding, sends, batches };
}

describe('cloudflare queue producer', () => {
  it('enqueueMany splits by the 100-message count cap preserving order', async () => {
    const { binding, batches } = makeBinding();
    const queue = createCfQueueProducer({ topic: binding });
    const messages = Array.from({ length: 250 }, (_, i) => ({ payload: { n: i } }));
    await queue.enqueueMany('topic', messages);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    const bodies = batches.flat().map((m) => (m.body as { n: number }).n);
    expect(bodies).toEqual(messages.map((_, i) => i));
  });

  it('enqueueMany splits by approximate byte budget', async () => {
    const { binding, batches } = makeBinding();
    const queue = createCfQueueProducer({ topic: binding });
    // ~120 KB each: two per batch would blow the ~200 KB working budget.
    const big = 'x'.repeat(120 * 1024);
    await queue.enqueueMany('topic', [{ payload: big }, { payload: big }, { payload: big }]);
    expect(batches.map((b) => b.length)).toEqual([1, 1, 1]);
    for (const batch of batches) {
      const bytes = batch.reduce((sum, m) => sum + JSON.stringify(m.body).length, 0);
      expect(bytes).toBeLessThanOrEqual(200 * 1024);
    }
  });

  it('enqueueMany converts delayMs to ceiled delaySeconds and omits it when absent', async () => {
    const { binding, batches } = makeBinding();
    const queue = createCfQueueProducer({ topic: binding });
    await queue.enqueueMany('topic', [{ payload: 'a', delayMs: 1500 }, { payload: 'b' }]);
    expect(batches[0]?.[0]?.delaySeconds).toBe(2);
    expect(batches[0]?.[1]).not.toHaveProperty('delaySeconds');
  });

  it('throws for a topic with no binding', async () => {
    const queue = createCfQueueProducer({});
    await expect(queue.enqueue('missing', {})).rejects.toThrow(/No Cloudflare queue binding/);
    await expect(queue.enqueueMany('missing', [{ payload: 1 }])).rejects.toThrow(
      /No Cloudflare queue binding/,
    );
  });
});

describe('asset ingest queue', () => {
  it('sends an upload as R2’s notification shape, its etag included', async () => {
    const { binding, sends } = makeBinding();
    const queue = createAssetIngestQueue(binding, () => new Date('2026-01-01T00:00:00Z'));
    await queue.objectCreated('s/main/a1/p.png', '"abc"');
    await queue.objectCreated('s/main/a2/q.png');
    expect(sends.map((s) => s.body)).toEqual([
      {
        action: 'PutObject',
        object: { key: 's/main/a1/p.png', eTag: '"abc"' },
        eventTime: '2026-01-01T00:00:00.000Z',
      },
      {
        action: 'PutObject',
        object: { key: 's/main/a2/q.png' },
        eventTime: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('sends requests in batches of at most 100', async () => {
    const { binding, batches } = makeBinding();
    const queue = createAssetIngestQueue(binding);
    const scope = { spaceId: 's', environmentId: 'main' };
    await queue.request(
      Array.from({ length: 150 }, (_, i) => ({ scope, assetId: `a${i}`, version: 1 })),
    );
    expect(batches.map((b) => b.length)).toEqual([100, 50]);
    expect(batches[0]?.[0]?.body).toEqual({
      kind: 'asset.ingest',
      scope,
      assetId: 'a0',
      version: 1,
    });
  });
});
