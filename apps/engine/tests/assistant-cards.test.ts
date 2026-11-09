import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  answerCard,
  answeredOnly,
  DIRECT,
  declinedCards,
  findDirectCall,
  heldBound,
  idsOf,
  kept,
  lapseCards,
  lookAgain,
  shownKey,
} from '../src/assistant/cards';

const card = (toolCallId: string, state: string, extra: Record<string, unknown> = {}) =>
  ({
    type: 'tool-submit_cart',
    toolCallId,
    state,
    input: { cartId: 'cart_1', note: 'Leave at the back door' },
    ...extra,
  }) as unknown as UIMessage['parts'][number];
const message = (id: string, ...parts: UIMessage['parts']): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'step-start' }, ...parts],
});

describe("a confirm card's hold", () => {
  it('holds its first look, keeps holding a matching one, and blocks once anything changed', () => {
    const first = lookAgain(undefined, 'd1', { version: 3 }, 10);
    expect(first).toEqual({
      store: { digest: 'd1', bound: { version: 3 }, at: 10 },
      blocked: false,
    });
    const held = first.store!;
    expect(lookAgain(held, 'd1', { version: 3 }, 20)).toEqual({ store: null, blocked: false });
    // Another input, or the cart moved on: stale and blocked, here and on every later look.
    const moved = lookAgain(held, 'd1', { version: 4 }, 20);
    expect(moved).toEqual({ store: { ...held, stale: true }, blocked: true });
    expect(lookAgain(held, 'd2', { version: 3 }, 20).blocked).toBe(true);
    expect(lookAgain(moved.store!, 'd1', { version: 3 }, 30).blocked).toBe(true);
  });

  it('holds a confirmed action to the card only when it was shown for that call, unchanged', () => {
    const held = { digest: 'd1', bound: { version: 3 }, at: 10 };
    expect(heldBound(held, 'd1')).toEqual({ version: 3 });
    expect(heldBound(held, 'd2')).toBeNull();
    expect(heldBound({ ...held, stale: true }, 'd1')).toBeNull();
    expect(heldBound(undefined, 'd1')).toBeNull();
  });
});

describe('page cards in the stored conversation', () => {
  const waiting = `${DIRECT}w1`;
  const convo = [
    message('m1', card(waiting, 'approval-requested')),
    message('m2', card('call_declined', 'output-denied')),
    message('m3', card('call_no', 'output-available', { approval: { approved: false } })),
  ];

  it('finds what the person declined, to let go of what it held', () => {
    expect(declinedCards(convo)).toEqual([shownKey('call_declined'), shownKey('call_no')]);
  });

  it('lets a lapsed card go as declined, keeping only its ids', () => {
    const out = lapseCards(convo, new Set([waiting]));
    expect(out[0]!.parts[1]).toMatchObject({
      state: 'output-denied',
      approval: { id: waiting, approved: false },
      input: { cartId: 'cart_1' },
    });
    expect(JSON.stringify(out[0])).not.toContain('back door');
    // Other cards are left as they were.
    expect(out[1]).toEqual(convo[1]);
  });

  it('answers a card in its own message, dropping what it held and its input but its ids', () => {
    const answered = answerCard(
      [message('m1', card(waiting, 'approval-requested', { output: 'old', errorText: 'old' }))],
      'm1',
      waiting,
      { cartId: 'cart_1', note: 'secret' },
      { state: 'output-available', output: { done: true } },
    );
    expect(answered[0]!.parts[1]).toEqual({
      type: 'tool-submit_cart',
      toolCallId: waiting,
      state: 'output-available',
      input: { cartId: 'cart_1' },
      output: { done: true },
    });
  });

  it("finds a page's call by its id, and leaves a waiting one out of what the model reads", () => {
    expect(findDirectCall(convo, waiting)).toMatchObject({
      message: { id: 'm1' },
      part: { name: 'submit_cart', state: 'approval-requested' },
    });
    expect(findDirectCall(convo, 'call_none')).toBeNull();
    const read = answeredOnly(convo);
    expect(read.map((m) => m.id)).toEqual(['m2', 'm3']);
  });

  it('keeps of a call only its ids, and of a result only what it did and where', () => {
    expect(idsOf({ cartId: 'c', orderId: 'o', note: 'x', count: 2 })).toEqual({
      cartId: 'c',
      orderId: 'o',
    });
    expect(
      kept({
        done: true,
        orderId: 'o',
        secret: 'x',
        results: [{ orderId: 'o', nodeId: 'n', ok: false, error: 'no', extra: 1 }],
      }),
    ).toEqual({
      done: true,
      orderId: 'o',
      results: [{ orderId: 'o', nodeId: 'n', ok: false, error: 'no' }],
    });
  });
});
