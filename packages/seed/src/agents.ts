import {
  createAgentReview,
  createAgentSchedule,
  listAgentReviews,
  listAgentRuns,
  listAgentSchedules,
} from '@commerceworker/application';
import { logger } from '@commerceworker/telemetry';
import { backdated, localized, pick } from './helpers';
import type { SeedRun } from './types';

/**
 * Agent observability data: 30 days of deterministic runs (usage/cost charts),
 * pending human-in-the-loop reviews, and recurring schedules. Runs are written
 * through the store repo (there is deliberately no public "create run" API);
 * reviews and schedules go through their use-cases.
 */
export async function seedAgents(run: SeedRun, articleIds: readonly string[]): Promise<void> {
  const { ctx, scope, locale } = run;

  if ((await listAgentRuns(ctx, scope, { limit: 1 })).length === 0) {
    await seedAgentRuns(run, articleIds);
  }

  if (articleIds.length >= 8 && (await listAgentReviews(ctx, scope, {})).length === 0) {
    const proposals = [
      { field: 'summary', note: 'Tightened the summary to one concrete claim' },
      { field: 'summary', note: 'Rewrote the summary for a practitioner audience' },
      { field: 'body', note: 'Flagged an unsourced statistic and proposed neutral wording' },
      { field: 'summary', note: 'Aligned the summary with the updated title' },
      { field: 'body', note: 'Proposed splitting the second paragraph' },
      { field: 'summary', note: 'Added the audience and outcome to the summary' },
      { field: 'body', note: 'Moderation: softened absolute claims in paragraph three' },
      { field: 'summary', note: 'Localized-summary parity check produced a revision' },
    ] as const;
    for (let i = 0; i < proposals.length; i++) {
      const p = proposals[i]!;
      await createAgentReview(ctx, scope, {
        workflow: pick(['enrich', 'moderate', 'curate'] as const, i),
        entryId: articleIds[i]!,
        proposed: {
          [p.field]: localized(locale, `Agent proposal #${i + 1}: ${p.note.toLowerCase()}.`),
        },
        notes: [p.note, `Seeded review ${i + 1} — approve or reject in the admin.`],
      });
    }
  }

  if ((await listAgentSchedules(ctx, scope)).length === 0) {
    await createAgentSchedule(ctx, scope, {
      workflow: 'enrich',
      cron: '0 6 * * *',
      contentTypeApiId: 'article',
    });
    await createAgentSchedule(ctx, scope, {
      workflow: 'moderate',
      cron: '*/30 * * * *',
      enabled: false,
      autoApply: true,
    });
  }
}

/**
 * Records a deterministic spread of agent runs across the last 60 days so the
 * dashboard's usage-trend, throughput, and per-workflow cards render
 * real-looking data with month-over-month shape. Timestamps are backdated off
 * the injected clock; tokens and statuses follow a fixed pattern (no
 * randomness) for reproducible demos. Runs reference real seeded entries so
 * drill-downs resolve.
 */
async function seedAgentRuns(run: SeedRun, articleIds: readonly string[]): Promise<void> {
  const { ctx, scope } = run;
  const now = ctx.clock.now();
  const workflows = ['enrich', 'moderate', 'generate', 'curate', 'repurpose'] as const;
  const statuses = [
    'completed',
    'completed',
    'completed',
    'applied',
    'needs_review',
    'held',
    'failed',
  ] as const;

  let n = 0;
  for (let day = 59; day >= 0; day--) {
    // 0–5 runs per day, denser toward the present so week-over-week trends up.
    const count = Math.max(0, Math.round(5 - day / 12 + (day % 2 === 0 ? 1 : 0)) % 6);
    for (let k = 0; k < count; k++) {
      const workflow = workflows[n % workflows.length]!;
      await ctx.store.agentRuns.record(scope, {
        id: ctx.ids.newId(),
        workflow,
        entryId: articleIds.length ? pick(articleIds, n) : '',
        status: statuses[n % statuses.length]!,
        decisions: [`${workflow} pass ${n + 1}`],
        inputTokens: 420 + ((n * 137) % 900),
        outputTokens: 130 + ((n * 71) % 380),
        createdAt: backdated(now, day, 9 + ((k * 3) % 12)),
      });
      n++;
    }
  }
  logger.info({ runs: n }, 'seed: created sample agent runs');
}
