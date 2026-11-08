/**
 * Executors for the `content.*` nodes. Each one calls the use-case a person's API call would, after the same
 * authorization the API applies (`guard`), so a workflow can never do what its starter couldn't.
 */

import {
  type DomainEvent,
  durationMs,
  type EntryFields,
  evaluateLogic,
  evaluatePolicy,
  interpolate,
  type LocalizedValue,
  linksIn,
  parsePolicyRules,
  SCOPES,
  stringList,
  validateEntryFields,
  type Webhook,
} from '@commerceworker/domain';
import { addComment } from '../comments';
import { getEntry, updateEntry } from '../entries';
import { grantWorkflowRunPublish } from '../publish-gate';
import { publishEntry, unpublishEntry } from '../publishing';
import { addEntryToRelease, getRelease, publishRelease } from '../releases';
import { listScheduledActions, scheduleAction } from '../scheduling';
import { createTask } from '../tasks';
import { createTag, getEntryMetadata, listTags, setEntryMetadata } from '../taxonomy';
import { assertSafeExternalUrl } from '../url-safety';
import { defaultLocaleOf, guard, interpolateDeep, isRecord, loadRunEntry, str } from './support';
import type { Exec, ExecInput } from './types';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A fresh entry snapshot, so expressions after this node see what it changed. */
const fresh = (i: ExecInput) => loadRunEntry(i.ctx, i.scope, i.entryId);

/** Very small address check: something@something.tld, no spaces. */
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export const CONTENT_EXECUTORS: Record<string, Exec> = {
  'content.validate': async (i) => {
    guard(i, SCOPES.previewRead, 'read');
    const { entry, fields } = await getEntry(i.ctx, i.scope, i.entryId);
    const ct = await i.ctx.store.contentTypes.get(i.scope, entry.contentTypeApiId);
    const config = await i.ctx.store.spaces.getConfig(i.scope);
    if (!ct || !config) return { failed: 'The entry’s content type or space is missing' };
    const issues = validateEntryFields(ct, fields, {
      defaultLocale: config.defaultLocale,
      locales: config.locales,
    });
    return {
      branches: [issues.length ? 'invalid' : 'valid'],
      output: { valid: issues.length === 0, issues },
      summary: issues.length
        ? `${plural(issues.length, 'problem')}: ${issues
            .slice(0, 3)
            .map((x) => `${x.field || 'entry'} ${x.message}`)
            .join('; ')}`
        : 'Valid',
    };
  },

  'content.policy': async (i) => {
    guard(i, SCOPES.previewRead, 'read');
    const parsed = parsePolicyRules(i.config.rules);
    if (!parsed.ok) return { failed: `Policy rules are not valid: ${parsed.issues.join('; ')}` };
    const { fields } = await getEntry(i.ctx, i.scope, i.entryId);
    const assetIds = [
      ...new Set(
        linksIn(fields)
          .filter((l) => l.linkType === 'Asset')
          .map((l) => l.id),
      ),
    ];
    const assets = assetIds.length ? await i.ctx.store.assets.getMany(i.scope, assetIds) : [];
    const assetAltText: Record<string, LocalizedValue> = Object.fromEntries(
      assets.map((a) => [a.id, a.metadata.altText]),
    );
    const locale = str(i.config.locale).trim();
    const result = evaluatePolicy(
      parsed.rules,
      { fields, assetAltText, ...(locale ? { locale } : {}) },
      i.ctx.clock.now().getTime(),
    );
    return {
      branches: [result.pass ? 'pass' : 'fail'],
      output: result,
      summary: result.pass ? 'All rules pass' : result.failures.join('; '),
    };
  },

  'content.publish': async (i) => {
    guard(i, SCOPES.contentPublish, 'publish');
    const before = i.run.entry;
    const current = await i.ctx.store.entries.get(i.scope, i.entryId);
    // Already live at this version (a step retried after its publish committed, or the entry
    // was published before the run): publishing again would only repeat the event.
    const alreadyLive =
      current !== null && current.entry.publishedVersion === current.entry.currentVersion;
    // The run's grant: a workflow that gates publishing lets its own runs publish what it covers.
    const published = alreadyLive
      ? current.entry
      : await publishEntry(i.ctx, i.scope, i.entryId, {
          grant: grantWorkflowRunPublish(i.workflowId, i.runId),
        });
    return {
      output: {
        version: published.publishedVersion,
        previousVersion: alreadyLive
          ? published.publishedVersion
          : (before.publishedVersion ?? null),
        publishedByRun: !alreadyLive,
      },
      summary: alreadyLive
        ? `Already live at version ${published.publishedVersion}`
        : `Published version ${published.publishedVersion}`,
      entry: await fresh(i),
    };
  },

  'content.unpublish': async (i) => {
    guard(i, SCOPES.contentPublish, 'unpublish');
    const current = await i.ctx.store.entries.get(i.scope, i.entryId);
    if (!current || current.entry.publishedVersion === null) {
      return { summary: 'Not published', output: { unpublished: false }, entry: await fresh(i) };
    }
    const version = current.entry.publishedVersion;
    await unpublishEntry(i.ctx, i.scope, i.entryId);
    return {
      summary: `Unpublished version ${version}`,
      output: { unpublished: true, version },
      entry: await fresh(i),
    };
  },

  'content.schedule': async (i) => {
    const action = str(i.config.action, 'publish') === 'unpublish' ? 'unpublish' : 'publish';
    guard(i, SCOPES.contentPublish, action);
    const now = i.ctx.clock.now().getTime();
    let at: number;
    if (i.config.at !== undefined && i.config.at !== null && i.config.at !== '') {
      const v = evaluateLogic(i.config.at, { ...i.run, now });
      at = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : Number.NaN;
      if (!Number.isFinite(at)) return { failed: 'Schedule: “At” did not give a time' };
    } else {
      at = now + durationMs(str(i.config.after, '1 day'));
    }
    const scheduledFor = new Date(at).toISOString();
    // A retried step finds the action its first attempt created instead of adding another.
    const existing = (await listScheduledActions(i.ctx, i.scope, { status: 'pending' })).find(
      (a) =>
        a.entityType === 'Entry' &&
        a.entityId === i.entryId &&
        a.action === action &&
        a.scheduledFor === scheduledFor,
    );
    const scheduled =
      existing ??
      (await scheduleAction(i.ctx, i.scope, {
        action,
        entityType: 'Entry',
        entityId: i.entryId,
        scheduledFor,
      }));
    return {
      output: { actionId: scheduled.id, action, scheduledFor },
      summary: `${action === 'publish' ? 'Publish' : 'Unpublish'} at ${scheduledFor}`,
    };
  },

  'content.add_to_release': async (i) => {
    guard(i, SCOPES.contentWrite, 'write');
    const releaseId = interpolate(str(i.config.releaseId), i.run).trim();
    if (!releaseId) return { failed: 'Add to release: no release' };
    const release = await getRelease(i.ctx, i.scope, releaseId);
    const wasMember = release.items.some((it) => it.entityId === i.entryId);
    if (!wasMember) {
      await addEntryToRelease(
        i.ctx,
        i.scope,
        releaseId,
        { entityId: i.entryId },
        { principal: i.actor.principal },
      );
    }
    return {
      output: { releaseId, wasMember },
      vars: { releaseId },
      summary: wasMember
        ? `Already in ${release.release.title}`
        : `Added to ${release.release.title}`,
    };
  },

  'content.publish_release': async (i) => {
    guard(i, SCOPES.contentPublish, 'publish');
    const releaseId = interpolate(str(i.config.releaseId), i.run).trim();
    if (!releaseId) return { failed: 'Publish release: no release' };
    const release = await getRelease(i.ctx, i.scope, releaseId);
    if (release.release.status === 'published') {
      return {
        output: { releaseId, published: false },
        summary: `${release.release.title} already shipped`,
      };
    }
    // The run ships the release as its starter would: their role covers every member's action.
    const shipped = await publishRelease(i.ctx, i.scope, releaseId, {
      grant: grantWorkflowRunPublish(i.workflowId, i.runId),
      principal: i.actor.principal,
    });
    return {
      output: { releaseId, published: true, entries: shipped.items.length },
      summary: `Published ${release.release.title} (${plural(shipped.items.length, 'entry', 'entries')})`,
      entry: await fresh(i),
    };
  },

  'content.set_fields': async (i) => {
    const raw = isRecord(i.config.values) ? i.config.values : {};
    const values = interpolateDeep(raw, (s) => interpolate(s, i.run)) as Record<string, unknown>;
    if (Object.keys(values).length === 0) return { summary: 'Nothing to set', output: {} };
    guard(i, SCOPES.contentWrite, 'write', values);
    const locale = str(i.config.locale).trim() || (await defaultLocaleOf(i.ctx, i.scope));
    const { fields } = await getEntry(i.ctx, i.scope, i.entryId);
    const merged: EntryFields = { ...fields };
    const prior: Record<string, unknown> = {};
    for (const [apiId, value] of Object.entries(values)) {
      prior[apiId] = fields[apiId]?.[locale] ?? null;
      merged[apiId] = { ...(fields[apiId] ?? {}), [locale]: value };
    }
    const saved = await updateEntry(i.ctx, i.scope, i.entryId, merged);
    return {
      output: { locale, prior, values, version: saved.entry.currentVersion },
      summary: `Set ${Object.keys(values).join(', ')}`,
      entry: await fresh(i),
    };
  },

  'content.set_tags': async (i) => {
    guard(i, SCOPES.contentWrite, 'write');
    const names = stringList(i.config.tags, []).map((t) => interpolate(t, i.run).trim());
    const mode = str(i.config.mode, 'add');
    const current = await getEntryMetadata(i.ctx, i.scope, i.entryId);
    const priorTagIds = [...(current?.tags ?? [])];
    const vocabulary = await listTags(i.ctx, i.scope);
    const byName = new Map(vocabulary.map((t) => [t.name.toLowerCase(), t.id]));
    const resolve = async (create: boolean) => {
      const ids: string[] = [];
      for (const name of names) {
        if (!name) continue;
        let id = byName.get(name.toLowerCase());
        if (!id && create) {
          id = (await createTag(i.ctx, i.scope, { name })).id;
          byName.set(name.toLowerCase(), id);
        }
        if (id) ids.push(id);
      }
      return ids;
    };
    let tagIds: string[];
    if (mode === 'remove') {
      const drop = new Set(await resolve(false));
      tagIds = priorTagIds.filter((id) => !drop.has(id));
    } else if (mode === 'replace') {
      tagIds = [...new Set(await resolve(true))];
    } else {
      tagIds = [...new Set([...priorTagIds, ...(await resolve(true))])];
    }
    await setEntryMetadata(i.ctx, i.scope, i.entryId, {
      tags: tagIds,
      concepts: current?.concepts ?? [],
    });
    return {
      output: { priorTagIds, tagIds },
      summary: `${mode === 'remove' ? 'Removed' : mode === 'replace' ? 'Replaced with' : 'Added'} ${names.join(', ')}`,
      entry: await fresh(i),
    };
  },

  'content.stage': async (i) => {
    guard(i, SCOPES.contentWrite, 'write');
    const stepId = str(i.config.stepId).trim();
    if (!stepId) return { failed: 'Set stage: no stage id' };
    const previous = await i.ctx.store.workflows.getState(i.scope, i.entryId);
    await i.ctx.store.workflows.saveState(i.scope, {
      entryId: i.entryId,
      workflowId: i.workflowId,
      currentStepId: stepId,
    });
    return {
      output: { stepId, previousStepId: previous?.currentStepId ?? null },
      vars: { stage: stepId },
      summary: `Stage: ${str(i.config.name) || stepId}`,
    };
  },

  'content.assign': async (i) => {
    guard(i, SCOPES.contentWrite, 'write');
    const assignee = interpolate(str(i.config.assignee), i.run).trim();
    const title = interpolate(str(i.config.title, 'Review “{{ref}}”'), i.run);
    const due = str(i.config.due).trim();
    const dueAt = due
      ? new Date(i.ctx.clock.now().getTime() + durationMs(due)).toISOString()
      : null;
    // Tasks have no due date of their own; it goes in the body people read.
    const task = await createTask(i.ctx, i.scope, {
      entryId: i.entryId,
      body: dueAt ? `${title} (due ${dueAt})` : title,
      ...(assignee ? { assignee } : {}),
    });
    return {
      output: { taskId: task.id, assignee: task.assignee, due: dueAt },
      summary: `Assigned to ${assignee || 'nobody'}: ${title}`,
    };
  },

  'content.comment': async (i) => {
    guard(i, SCOPES.contentWrite, 'write');
    const body = interpolate(str(i.config.body), i.run).trim();
    if (!body) return { failed: 'Comment: the comment is empty' };
    const comment = await addComment(i.ctx, i.scope, {
      entryId: i.entryId,
      body,
      author: `workflow:${i.workflowId}`,
    });
    return { output: { commentId: comment.id }, summary: body.slice(0, 80) };
  },

  'content.notify': async (i) => {
    guard(i, SCOPES.previewRead, 'read');
    if (!i.deps.email) return { failed: 'Notify: email sending is not configured' };
    const to = stringList(i.config.to, [])
      .flatMap((t) => interpolate(t, i.run).split(','))
      .map((t) => t.trim())
      .filter(Boolean);
    const bad = to.filter((t) => !EMAIL_RE.test(t));
    if (!to.length || bad.length) {
      return { failed: `Notify: not an email address: ${bad.join(', ') || '(none)'}` };
    }
    const subject = interpolate(str(i.config.subject, '“{{ref}}” needs attention'), i.run);
    const text = interpolate(str(i.config.message, '“{{ref}}” needs attention.'), i.run);
    const sent = await i.deps.email.send({
      to,
      subject,
      text,
      idempotencyKey: `${i.runId}:${i.effectKey}`,
    });
    // Throwing lets the step retry with backoff; a mail provider being down is transient.
    if (!sent.delivered) throw new Error(`Email not sent: ${sent.error ?? 'unknown error'}`);
    return {
      output: { to, subject, id: sent.id ?? null },
      summary: `→ ${to.join(', ')}: ${subject}`,
    };
  },

  'content.webhook': async (i) => {
    guard(i, SCOPES.previewRead, 'read');
    if (!i.deps.webhooks) return { failed: 'Webhook: outbound webhooks are not configured' };
    const url = str(i.config.url).trim();
    assertSafeExternalUrl(url);
    const payload = interpolateDeep(isRecord(i.config.payload) ? i.config.payload : {}, (s) =>
      interpolate(s, i.run),
    ) as Record<string, unknown>;
    // The id is the node's effect key, so a retried step is the same delivery to the receiver.
    const event: DomainEvent = {
      id: `${i.runId}:${i.effectKey}`,
      type: 'workflow.webhook',
      scope: i.scope,
      occurredAt: i.ctx.clock.now().toISOString(),
      runId: i.runId,
      nodeId: i.node.id,
      entryId: i.entryId,
      payload,
    };
    const hook: Webhook = {
      id: `workflow:${i.runId}:${i.node.id}`,
      url,
      topics: ['workflow.webhook'],
      // Node-configured targets carry no shared secret; the signature header is not a credential.
      secret: '',
      active: true,
      environmentId: i.scope.environmentId,
    };
    const res = await i.deps.webhooks.send(hook, event);
    if (!res.delivered) {
      throw new Error(`Webhook not delivered: ${res.error ?? `HTTP ${res.statusCode ?? '?'}`}`);
    }
    return {
      output: { url, status: res.statusCode ?? null },
      summary: `POST ${new URL(url).host}`,
    };
  },
};
