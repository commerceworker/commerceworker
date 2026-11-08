import {
  createAIAction,
  createAppExtension,
  createFunction,
  createWebhook,
  listAIActions,
  listAppExtensions,
  listFunctions,
  listScheduledActions,
  listWebhooks,
  scheduleAction,
} from '@commerceworker/application';
import type { SeedRun } from './types';

/**
 * Automation surfaces: webhook subscriptions, event-driven functions, admin UI
 * extensions, reusable AI actions, and pending scheduled publishes. Each block
 * is guarded by its own existence check; definitions only — nothing here calls
 * an AI provider or delivers a webhook at boot.
 */
export async function seedAutomation(
  run: SeedRun,
  autumnReleaseId: string | null,
  draftEntryId: string | null,
  publishedEntryId: string | null,
): Promise<void> {
  const { ctx, scope } = run;
  const now = run.ctx.clock.now();

  if ((await listWebhooks(ctx, scope)).length === 0) {
    await createWebhook(ctx, scope, {
      url: 'https://example.com/hooks/on-publish',
      topics: ['entry.published', 'release.published'],
      secret: 'dev-webhook-secret',
    });
    await createWebhook(ctx, scope, {
      url: 'https://example.com/hooks/unpublish-audit',
      topics: ['entry.unpublished'],
      secret: 'dev-webhook-secret-2',
      headers: { 'x-team': 'compliance' },
    });
    await createWebhook(ctx, scope, {
      url: 'https://example.com/hooks/firehose',
      topics: ['*'],
      secret: 'dev-webhook-secret-3',
      active: false,
      headers: { 'x-demo': 'commerceworker' },
    });
  }

  if ((await listFunctions(ctx, scope)).length === 0) {
    await createFunction(ctx, scope, {
      name: 'Sync search index',
      eventPattern: 'entry.*',
      url: 'https://example.com/functions/sync-search',
    });
    await createFunction(ctx, scope, {
      name: 'Warm edge cache',
      eventPattern: 'content_type.published',
      url: 'https://example.com/functions/warm-cache',
    });
    await createFunction(ctx, scope, {
      name: 'Notify on release',
      eventPattern: 'release.published',
      url: 'https://example.com/functions/notify-release',
      active: false,
    });
  }

  if ((await listAppExtensions(ctx, scope)).length === 0) {
    await createAppExtension(ctx, scope, {
      name: 'SEO checklist',
      target: 'sidebar',
      entryUrl: 'https://example.com/apps/seo-checklist',
    });
    await createAppExtension(ctx, scope, {
      name: 'Markdown editor',
      target: 'field-editor',
      entryUrl: 'https://example.com/apps/markdown-editor',
      fieldTypes: ['RichText', 'Text'],
      active: false,
    });
  }

  if ((await listAIActions(ctx, scope)).length === 0) {
    await createAIAction(ctx, scope, {
      name: 'Summarize entry',
      description: 'Condense the body into a one-sentence summary.',
      promptTemplate: 'Summarize the following in one sentence:\n\n{{body}}',
      targetField: 'summary',
      tier: 'fast',
    });
    await createAIAction(ctx, scope, {
      name: 'Rewrite for tone',
      description: 'Rewrite copy in a given tone of voice.',
      promptTemplate: 'Rewrite this in a {{tone}} tone for {{audience}}:\n\n{{body}}',
      tier: 'balanced',
    });
    await createAIAction(ctx, scope, {
      name: 'SEO keywords',
      description: 'Propose search keywords from the body and title.',
      promptTemplate:
        'Given the title "{{title}}" and body below, list 5 SEO keywords:\n\n{{body}}',
      tier: 'flagship',
    });
  }

  if ((await listScheduledActions(ctx, scope)).length === 0) {
    const at = (days: number) => {
      const d = new Date(now);
      d.setDate(d.getDate() + days);
      d.setHours(9, 0, 0, 0);
      return d.toISOString();
    };
    if (autumnReleaseId) {
      await scheduleAction(ctx, scope, {
        action: 'publish',
        entityType: 'Release',
        entityId: autumnReleaseId,
        scheduledFor: at(7),
      });
    }
    if (draftEntryId) {
      await scheduleAction(ctx, scope, {
        action: 'publish',
        entityType: 'Entry',
        entityId: draftEntryId,
        scheduledFor: at(2),
      });
    }
    if (publishedEntryId) {
      await scheduleAction(ctx, scope, {
        action: 'unpublish',
        entityType: 'Entry',
        entityId: publishedEntryId,
        scheduledFor: at(14),
      });
    }
  }
}
