/**
 * Saga compensations for the catalog nodes marked `rollback`. The
 * interpreter runs them in reverse completion order when a run fails; cancelling a run runs them
 * too. Each one checks the entry is still as the node left it before undoing anything, so it is
 * idempotent and never undoes someone else's later work.
 */

import type { EntryFields } from '@commerceworker/domain';
import { updateEntry } from '../entries';
import { unpublishEntry } from '../publishing';
import { removeEntryFromRelease } from '../releases';
import { cancelScheduledAction } from '../scheduling';
import { resolveTask } from '../tasks';
import { getEntryMetadata, setEntryMetadata } from '../taxonomy';
import { isRecord } from './support';
import type { Compensate } from './types';

const out = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

export const WORKFLOW_COMPENSATIONS: Record<string, Compensate> = {
  'content.publish': async ({ ctx, scope, entryId, output }) => {
    const o = out(output);
    if (o.publishedByRun !== true) return 'Left live: it was live before this step';
    const found = await ctx.store.entries.get(scope, entryId);
    if (!found || found.entry.publishedVersion === null) return 'Already unpublished';
    if (found.entry.publishedVersion !== o.version) {
      return `Skipped: republished since (version ${found.entry.publishedVersion} is live)`;
    }
    await unpublishEntry(ctx, scope, entryId);
    return `Unpublished version ${String(o.version)}`;
  },

  'content.schedule': async ({ ctx, scope, output }) => {
    const id = out(output).actionId;
    if (typeof id !== 'string') return 'No schedule to cancel';
    const action = await ctx.store.scheduledActions.get(scope, id);
    if (action?.status !== 'pending') return `Schedule already ${action?.status ?? 'gone'}`;
    await cancelScheduledAction(ctx, scope, id);
    return `Cancelled the scheduled ${action.action}`;
  },

  'content.add_to_release': async ({ ctx, scope, entryId, output }) => {
    const o = out(output);
    if (o.wasMember === true) return 'Left in the release: it was there before this step';
    const releaseId = typeof o.releaseId === 'string' ? o.releaseId : '';
    const release = releaseId ? await ctx.store.releases.get(scope, releaseId) : null;
    if (!release) return 'Release gone';
    if (release.status !== 'open') return `Skipped: the release is ${release.status}`;
    const items = await ctx.store.releases.listItems(scope, releaseId);
    if (!items.some((it) => it.entityId === entryId)) return 'Already out of the release';
    await removeEntryFromRelease(ctx, scope, releaseId, entryId);
    return `Removed from ${release.title}`;
  },

  'content.set_fields': async ({ ctx, scope, entryId, output }) => {
    const o = out(output);
    const prior = out(o.prior);
    const locale = typeof o.locale === 'string' ? o.locale : '';
    const found = await ctx.store.entries.get(scope, entryId);
    if (!found || !locale) return 'Entry gone';
    if (found.entry.currentVersion !== o.version) {
      return `Skipped: edited since (version ${found.entry.currentVersion})`;
    }
    const fields: EntryFields = { ...found.fields };
    for (const [apiId, value] of Object.entries(prior)) {
      const localized = { ...(fields[apiId] ?? {}) };
      if (value === null || value === undefined) delete localized[locale];
      else localized[locale] = value;
      if (Object.keys(localized).length) fields[apiId] = localized;
      else delete fields[apiId];
    }
    await updateEntry(ctx, scope, entryId, fields);
    return `Restored ${Object.keys(prior).join(', ')}`;
  },

  'content.set_tags': async ({ ctx, scope, entryId, output }) => {
    const o = out(output);
    const prior = Array.isArray(o.priorTagIds) ? (o.priorTagIds as string[]) : [];
    const set = Array.isArray(o.tagIds) ? (o.tagIds as string[]) : [];
    const current = await getEntryMetadata(ctx, scope, entryId);
    const now = [...(current?.tags ?? [])];
    if (sameSet(now, prior)) return 'Tags already restored';
    if (!sameSet(now, set)) return 'Skipped: tags changed since';
    await setEntryMetadata(ctx, scope, entryId, { tags: prior, concepts: current?.concepts ?? [] });
    return 'Restored the previous tags';
  },

  'content.assign': async ({ ctx, scope, output }) => {
    const id = out(output).taskId;
    if (typeof id !== 'string') return 'No task to resolve';
    const task = await ctx.store.tasks.get(scope, id);
    if (!task) return 'Task gone';
    if (task.status !== 'open') return 'Task already resolved';
    await resolveTask(ctx, scope, id);
    return 'Resolved the task';
  },
};
