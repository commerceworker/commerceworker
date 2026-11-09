/**
 * Confirm cards in the assistant's conversation, as pure steps the AssistantAgent runs. A card
 * shows an action resolved against live data; what it showed that can change before the person
 * confirms (a cart's version, its `bound`) is held from its first look, and the confirmed action
 * is held to it. A page's own buttons make cards too (`act`, a direct call); what the stored
 * conversation keeps of those is only their ids. The agent keeps the storage and the runs.
 */
import { type AssistantTool, DIRECT_CALL, isAssistantTool } from '@commerceworker/core';
import type { UIMessage } from 'ai';

/** What a confirm card's first look showed, kept per tool call. */
export type Shown = {
  /** The tool and input it was shown for (`fingerprintOf`). */
  digest: string;
  bound: Record<string, unknown> | null;
  at: number;
  /** A later look saw something else: the card no longer holds. */
  stale?: true;
};

/** A confirm card `act` made, kept until it is answered. */
export type Direct = { name: AssistantTool; digest: string; at: number };

export const shownKey = (callId: string) => `shown:${callId}`;
export const directKey = (callId: string) => `direct:${callId}`;

/** How long an unanswered card is kept: a day. */
export const CARD_TTL_MS = 86_400_000;

export const DIRECT = DIRECT_CALL;
export const SHOWN_CHANGED =
  'This changed since the card was first shown. Ask again for a new card.';
export const ALREADY_ANSWERED = 'This was already answered.';

/**
 * A look at a card: its first look is held (`store`); a later one that sees another input or
 * another `bound` marks it stale (`store`) and blocks it, as does any look once it is stale.
 */
export function lookAgain(
  held: Shown | undefined,
  digest: string,
  bound: Record<string, unknown> | null,
  now: number,
): { store: Shown | null; blocked: boolean } {
  if (!held) return { store: { digest, bound, at: now }, blocked: false };
  if (held.stale || held.digest !== digest || JSON.stringify(held.bound) !== JSON.stringify(bound))
    return { store: { ...held, stale: true }, blocked: true };
  return { store: null, blocked: false };
}

/**
 * What a confirmed action is held to: the card's `bound`, when the card was shown for this very
 * tool and input and never changed since; otherwise nothing, which an action that needs a hold
 * (a cart submit) refuses.
 */
export const heldBound = (held: Shown | undefined, digest: string) =>
  held && !held.stale && held.digest === digest ? held.bound : null;

/** The `shown:` keys of cards the person declined. */
export function declinedCards(messages: UIMessage[]): string[] {
  return messages.flatMap((m) =>
    m.parts.flatMap((part) => {
      const t = part as { toolCallId?: string; state?: string; approval?: { approved?: boolean } };
      return t.toolCallId && (t.state === 'output-denied' || t.approval?.approved === false)
        ? [shownKey(t.toolCallId)]
        : [];
    }),
  );
}

/** A call's ids, all a page edit's line needs: cart text and addresses stay out of the store. */
export function idsOf(input: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries((input ?? {}) as Record<string, unknown>).filter(
      (e): e is [string, string] => /Id$/.test(e[0]) && typeof e[1] === 'string',
    ),
  );
}

/** What a page edit's result keeps in the conversation: what it did and where, and counts. */
export function kept(output: unknown): Record<string, unknown> {
  const o = (output ?? {}) as Record<string, unknown>;
  const pick = ['done', 'href', 'id', 'status', 'applied', 'version', 'orderId', 'instanceId'];
  const out = Object.fromEntries(pick.filter((k) => k in o).map((k) => [k, o[k]]));
  if (Array.isArray(o.results))
    out.results = o.results.map((r: Record<string, unknown>) => ({
      orderId: r.orderId,
      nodeId: r.nodeId,
      ok: r.ok,
      ...(r.error ? { error: r.error } : {}),
    }));
  return out;
}

/**
 * The conversation with these page cards let go, as if declined, once left unanswered past
 * `CARD_TTL_MS`: their input (a guest's address, a pasted PO) isn't kept past then, only its ids.
 */
export function lapseCards(messages: UIMessage[], lapsed: ReadonlySet<string>): UIMessage[] {
  return messages.map((m) => ({
    ...m,
    parts: m.parts.map((x) => {
      const t = x as { toolCallId?: string; state?: string; input?: unknown };
      if (!t.toolCallId || !lapsed.has(t.toolCallId) || t.state !== 'approval-requested') return x;
      return {
        ...x,
        input: idsOf(t.input),
        state: 'output-denied',
        approval: { id: t.toolCallId, approved: false },
      } as UIMessage['parts'][number];
    }),
  }));
}

/**
 * The conversation with a page card answered: its part takes `answer` (a state, an approval, an
 * output or an error) and, answered, no longer states its input: only its ids stay stored.
 */
export function answerCard(
  messages: UIMessage[],
  messageId: string,
  callId: string,
  input: unknown,
  answer: Record<string, unknown>,
): UIMessage[] {
  return messages.map((m) =>
    m.id === messageId
      ? {
          ...m,
          parts: m.parts.map((x) => {
            if ((x as { toolCallId?: string }).toolCallId !== callId) return x;
            const { errorText: _e, output: _o, ...rest } = x as Record<string, unknown>;
            return { ...rest, input: idsOf(input), ...answer } as UIMessage['parts'][number];
          }),
        }
      : m,
  );
}

/** The tool call `act` made with this id, in the message it is in. */
export function findDirectCall(messages: UIMessage[], callId: string) {
  for (const message of messages)
    for (const part of message.parts) {
      const t = part as { type: string; toolCallId?: string; state?: string; input?: unknown };
      if (t.toolCallId !== callId || !t.type.startsWith('tool-')) continue;
      const name = t.type.slice(5);
      if (!isAssistantTool(name)) return null;
      return { message, part: { name, input: t.input, state: t.state } };
    }
  return null;
}

/**
 * The conversation as the model reads it: a page's confirm card still waiting has no result yet
 * and isn't the model's to answer, so it is left out until the person answers it.
 */
export function answeredOnly(messages: UIMessage[]): UIMessage[] {
  return messages.flatMap((m) => {
    const parts = m.parts.filter((x) => {
      const t = x as { toolCallId?: string; state?: string };
      return !(t.toolCallId?.startsWith(DIRECT) && !t.state?.startsWith('output-'));
    });
    return parts.some((x) => x.type !== 'step-start') ? [{ ...m, parts }] : [];
  });
}
