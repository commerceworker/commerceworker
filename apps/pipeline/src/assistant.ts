/**
 * The engine's AssistantAgent: the agent in `@commerceworker/http/assistant/agent`, given this
 * Worker's wiring. Its MCP server is built the way the api's composition root builds it, from
 * the same `wireEdge`, so a tool the assistant runs is the tool `/mcp` serves. Who is behind a
 * socket is read from the web app's own tables (users, sessions) in the shared D1.
 */
import { InProcessAgentRuntime, makeActivities } from '@commerceworker/agent-runtime';
import { createHasher } from '@commerceworker/application';
import { WEB_SIGN_IN } from '@commerceworker/http/api/access-policy';
import {
  AssistantAgentBase,
  type AssistantWiring,
  type PersonNow,
  type PersonRefused,
  type SocketClaims,
} from '@commerceworker/http/assistant/agent';
import { wireEdge } from '@commerceworker/platform/wire';
import { sendReviewDecision } from '@commerceworker/platform/workflows';
import { isRole, sessionIdleMs } from '@commerceworker/security/roles';
import { anyPeople, authDbOf, personNow } from '@commerceworker/store/auth';

export class AssistantAgent extends AssistantAgentBase {
  protected override wire(): AssistantWiring {
    const wired = wireEdge(this.env);
    const env = this.env;
    return {
      deps: {
        ctx: wired.ctx,
        ai: wired.ai,
        rag: wired.rag,
        // On-demand agent actions run in-process, as on the api's /mcp.
        agents: new InProcessAgentRuntime(makeActivities({ ctx: wired.ctx, ai: wired.ai })),
        hasher: createHasher(env.TOKEN_PEPPER),
        // The MCP root token never authenticates anything here: the principal is resolved first.
        adminToken: '',
        blob: wired.blob,
        moderateBeforePublish: wired.config.moderateBeforePublish,
        accessPolicy: WEB_SIGN_IN,
        remoteFetcher: wired.remoteFetcher,
        signalReview: env.AGENT_WF
          ? (review, decision) => sendReviewDecision(env.AGENT_WF as Workflow, review.id, decision)
          : undefined,
        ...(wired.workflowEngine ? { workflowEngine: wired.workflowEngine } : {}),
        workflowNodes: wired.workflowNodes,
      },
      close: () => wired.close(),
    };
  }

  /**
   * The person as the web app has them now. Open local development (`local`) stays open only
   * while nobody has an account, as the web Worker treats it. Anyone else must have signed from a
   * session (`sid`) that still exists, is theirs, unexpired and not idle past their role's limit,
   * and their account must exist and be enabled: a session that ended lets them come back; an
   * account gone or disabled ends the conversation.
   */
  protected override async personNow(claims: SocketClaims): Promise<PersonNow | PersonRefused> {
    const d1 = this.env.DB;
    if (claims.sub === 'local') {
      const open = !d1 || !(await anyPeople(authDbOf(d1)));
      return open ? { name: 'local', email: '', role: claims.role } : { refused: 'session' };
    }
    if (!d1 || !claims.sid) return { refused: 'session' };
    const db = authDbOf(d1);
    const now = Date.now();
    const row = await personNow(db, { sub: claims.sub, sid: claims.sid }, now);
    if (row && isRole(row.role)) {
      if (row.seenAt !== undefined && now - row.seenAt > sessionIdleMs(row.role))
        return { refused: 'session' };
      return { name: row.name, email: row.email, role: row.role };
    }
    // Why not: their session, or them?
    return (await personNow(db, { sub: claims.sub }, now))
      ? { refused: 'session' }
      : { refused: 'person' };
  }
}
