/**
 * How the panel talks to the person's AssistantAgent (`@commerceworker/http/assistant`, hosted by
 * the engine): the agent's address, the body every chat request carries, and the two calls a page's
 * edit makes. Kept in one place so the wire can change without touching the panel or the pages.
 *
 * - `act(tool, input, context, about?)`: one exact MCP tool call, no model. A tool with `confirm`
 *   answers `{ callId, waiting: true }` and shows a card in the conversation (a `tool-<name>` part in
 *   `approval-requested`, `toolMetadata: { direct: true, about }`); anything else runs at once and
 *   answers `{ callId, output }`, leaving a line. A refusal rejects with the words to show.
 * - `resolve(callId, approved)`: answers a card `act` made. Cards the model proposes are answered
 *   with the AI SDK's own tool-approval response instead (`addToolApprovalResponse`).
 */

import {
  ASSISTANT_AGENT,
  type AssistantContext,
  type AssistantScope,
  type AssistantTool,
  DIRECT_CALL_PREFIX,
} from '@commerceworker/domain';

/** The one method of `useAgent`'s connection the calls need, so tests can stand in for it. */
export interface AgentCaller {
  call<T = unknown>(method: string, args?: unknown[]): Promise<T>;
}

/** `useAgent`'s address for a person's own agent; only that person's principal reaches it. */
export const agentAddress = (personId: string) => ({ agent: ASSISTANT_AGENT, name: personId });

/** What every chat request sends beside the messages (`onChatMessage`'s `options.body`). */
export const chatBody = (context: AssistantContext) => ({ context });

/**
 * MCP tools name their scope `space` and `environment`. The agent overwrites both from the turn's
 * context; they are sent so the call reads as the tool's own input, in the conversation too.
 */
export const scopeArgs = (scope: AssistantScope) => ({
  space: scope.spaceId,
  environment: scope.environmentId,
});

export type ActReply = { callId: string; waiting: true } | { callId: string; output: unknown };

export const sendAct = (
  agent: AgentCaller,
  tool: AssistantTool,
  input: unknown,
  context: AssistantContext,
  about?: string,
) =>
  agent.call<ActReply>(
    'act',
    about === undefined ? [tool, input, context] : [tool, input, context, about],
  );

/** `{ output }` once a confirmed card has run; `{ done: null }` when it was declined. */
export type ResolveReply = { output?: unknown; done?: null };

export const sendAnswer = (agent: AgentCaller, callId: string, approved: boolean) =>
  agent.call<ResolveReply>('resolve', [callId, approved]);

/** A tool part's metadata, as `act` writes it. */
export interface DirectMeta {
  readonly direct?: boolean;
  /** The human label the card or line shows: "Spring launch notes". */
  readonly about?: string;
}

type ToolPartLike = { toolCallId: string; toolMetadata?: unknown };

export const metaOf = (part: ToolPartLike): DirectMeta =>
  (part.toolMetadata && typeof part.toolMetadata === 'object'
    ? part.toolMetadata
    : {}) as DirectMeta;

/** A call a page made (`act`), never one the model proposed. */
export const isDirectCall = (part: ToolPartLike) =>
  part.toolCallId.startsWith(DIRECT_CALL_PREFIX) || metaOf(part).direct === true;
