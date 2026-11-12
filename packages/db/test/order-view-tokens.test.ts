import { env } from 'cloudflare:workers';
import { describeOrderViewTokensContract } from '@commerceworker/test-kit/commerce';
import { like } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/index';
import { d1OrderViewTokens } from '../src/order-view-tokens';
import { orderViewTokens } from '../src/schema';
import { d1SubjectStore } from '../src/subject-store';

const { DB } = env as unknown as { DB: D1Database };

describeOrderViewTokensContract('D1', async () => {
  await createDb(DB).delete(orderViewTokens).where(like(orderViewTokens.orderId, 'ov_%'));
  return d1OrderViewTokens(DB);
});

describe('erasing an order’s rows', () => {
  it('takes its receipt links with it, and leaves other orders’', async () => {
    const tokens = d1OrderViewTokens(DB);
    await tokens.issue('ov_e1', 'e'.repeat(64), 0, Date.now() + 60_000);
    await tokens.issue('ov_e2', 'f'.repeat(64), 0, Date.now() + 60_000);
    await d1SubjectStore(DB).eraseOrderRows(['ov_e1']);
    expect(await tokens.live('ov_e1', 1)).toEqual([]);
    expect(await tokens.live('ov_e2', 1)).toEqual(['f'.repeat(64)]);
  });
});
