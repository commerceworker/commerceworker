import {
  ConflictError,
  type ContentType,
  type EntryFields,
  ForbiddenError,
  InvalidStateError,
  MAX_PROMOTION_CONTENT_TYPES,
  MAX_PROMOTION_ENTRIES,
  NotFoundError,
  type Principal,
  type PromotedContentType,
  type PromotedEntry,
  type Promotion,
  type PromotionAssessment,
  type PromotionResult,
  type PromotionRisk,
  type PromotionStatus,
  removedFields,
  removedVariants,
  SCOPES,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type { DecisionAnswer } from '@commerceworker/ports';
import { decide } from './ai-decide';
import { wrapUntrusted } from './ai-prompt';
import { isUncheckedFallback } from './ai-provenance';
import { auditActor } from './audit';
import { compareEnvironments } from './branching';
import { describeRemovedInUse, removedContentInUse, saveContentTypeOver } from './content-types';
import { type AppContext, withActor } from './context';
import { createEntry, updateEntry } from './entries';
import { loadPublishGuard } from './publish-gate';
import { publishEntry } from './publishing';
import { resolveEnvironment, resolveWritableEnvironment } from './spaces';

/**
 * Promoting content between environments, with a risk check and, when it calls for one, a
 * person's approval.
 *
 * Requesting pins what to copy: each entry by version (what is live in the source goes live in the
 * target, a draft goes as a draft), and each content type by apiId. The risk check runs then:
 * rules that always require approval (the target is `main` or an alias points at it; a content
 * type would lose a field at any depth or a block variant, change a field's type, or make one
 * required; the target's entries still hold a field or variant it loses), and, with a decision
 * model, its view of the change, which can only add a requirement, never remove one. A
 * promotion that needs no approval is applied at once; one that does waits as
 * `awaiting_approval` for someone other than the requester.
 *
 * Applying goes through the use-cases (`createEntry` / `updateEntry` / `publishEntry`, and the
 * content-type equivalents), so validation, references, events and the delivery cache all happen
 * as they would for a person's edits, then checks that the target holds what was pinned.
 */

export interface RequestPromotionInput {
  readonly source: string;
  readonly target: string;
  /** Content types to copy; omitted with `entries`, everything that differs. */
  readonly contentTypes?: readonly string[];
  /** Entries to copy; omitted with `contentTypes`, everything that differs. */
  readonly entries?: readonly string[];
}

/** The probability at which the decision model's `review` asks for a person. */
const REVIEW_THRESHOLD = 0.5;
/** The `risk` score (0 Routine … 3 High-risk) at which it asks for one. */
const RISK_THRESHOLD = 2;
const RISK_LEVELS = ['Routine', 'Minor', 'Significant', 'High-risk'] as const;

export async function requestPromotion(
  ctx: AppContext,
  principal: Principal,
  spaceId: string,
  input: RequestPromotionInput,
): Promise<Promotion> {
  assertUnrestricted(principal);
  const sourceId = await resolveEnvironment(ctx, spaceId, input.source);
  const targetId = await resolveWritableEnvironment(ctx, spaceId, input.target);
  if (sourceId === targetId) {
    throw new ValidationError([{ field: 'target', message: 'Promote to a different environment' }]);
  }
  const source: Scope = { spaceId, environmentId: sourceId };
  const target: Scope = { spaceId, environmentId: targetId };

  // What to copy: the caller's selection, or everything that differs.
  let typeIds = input.contentTypes ? [...new Set(input.contentTypes)] : undefined;
  let entryIds = input.entries ? [...new Set(input.entries)] : undefined;
  if (!typeIds && !entryIds) {
    const diff = await compareEnvironments(ctx, spaceId, sourceId, targetId);
    typeIds = diff.contentTypes
      .filter((c) => c.kind !== 'removed' && c.kind !== 'unchanged')
      .map((c) => c.apiId);
    entryIds = diff.entries
      .filter((e) => e.kind !== 'removed' && e.kind !== 'unchanged')
      .map((e) => e.entryId);
  }
  typeIds ??= [];
  entryIds ??= [];
  if (typeIds.length === 0 && entryIds.length === 0) {
    throw new ValidationError([
      { field: 'entries', message: 'Nothing to promote: the environments match' },
    ]);
  }
  if (typeIds.length > MAX_PROMOTION_CONTENT_TYPES) {
    throw new ValidationError([
      {
        field: 'contentTypes',
        message: `A promotion copies at most ${MAX_PROMOTION_CONTENT_TYPES} content types; this one has ${typeIds.length}`,
      },
    ]);
  }
  if (entryIds.length > MAX_PROMOTION_ENTRIES) {
    throw new ValidationError([
      {
        field: 'entries',
        message: `A promotion copies at most ${MAX_PROMOTION_ENTRIES} entries; this one has ${entryIds.length}. Promote it in parts`,
      },
    ]);
  }

  const types: ContentType[] = [];
  for (const apiId of typeIds) {
    const ct = await ctx.store.contentTypes.get(source, apiId);
    if (!ct) throw new NotFoundError('ContentType', `${sourceId}/${apiId}`);
    types.push(ct);
  }
  const entries: PromotedEntry[] = [];
  for (const entryId of entryIds) {
    const found = await ctx.store.entries.get(source, entryId);
    if (!found) throw new NotFoundError('Entry', `${sourceId}/${entryId}`);
    const live = found.entry.publishedVersion;
    // What is live goes live; a draft goes as a draft.
    entries.push({
      entryId,
      contentTypeApiId: found.entry.contentTypeApiId,
      version: live ?? found.entry.currentVersion,
      publish: live !== null,
    });
  }

  await assertSingletonsHold(ctx, target, types, entries);

  // A workflow that gates publishing an entry in the target publishes it there, not a promotion:
  // such an entry goes as a draft, and the record says why.
  const gate = await loadPublishGuard(ctx.store.workflowGraphs, target);
  const gatedNotes: string[] = [];
  for (const [i, e] of entries.entries()) {
    const refused = e.publish ? gate.refusal(e.entryId, e.contentTypeApiId) : null;
    if (!refused) continue;
    entries[i] = { ...e, publish: false };
    gatedNotes.push(
      `Entry ${e.entryId} goes as a draft: ${refused.workflows.map((w) => `"${w.name}"`).join(', ')} gates publishing it in ${targetId}`,
    );
  }
  const assessed = await assessPromotion(ctx, source, target, types, entries);
  const risk: PromotionRisk = { ...assessed, reasons: [...assessed.reasons, ...gatedNotes] };
  const now = ctx.clock.now().toISOString();
  const promotion: Promotion = {
    id: ctx.ids.newId(),
    spaceId,
    source: sourceId,
    target: targetId,
    contentTypes: types.map((t): PromotedContentType => ({ apiId: t.apiId, version: t.version })),
    entries,
    status: risk.requiresApproval ? 'awaiting_approval' : 'applying',
    risk,
    requestedBy: auditActor(principal),
    createdAt: now,
  };
  await ctx.store.withTransaction(async (tx) => {
    await tx.promotions.create(promotion);
    if (risk.requiresApproval) {
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'promotion.awaiting_approval',
        scope: target,
        occurredAt: now,
        promotionId: promotion.id,
        source: sourceId,
        requestedBy: promotion.requestedBy,
        reasons: risk.reasons,
      });
    }
  });
  await ctx.store.audit.append(
    auditRow(ctx, promotion, promotion.requestedBy, 'promotion.requested'),
  );
  if (risk.requiresApproval) return promotion;
  return applyPromotion(ctx, promotion);
}

/**
 * Approves a waiting promotion and applies it. Not by whoever requested it: the point of the gate
 * is a second person. Exactly one approval applies (the record leaves `awaiting_approval` with a
 * compare-and-set); a later one finds it already decided.
 */
export async function approvePromotion(
  ctx: AppContext,
  principal: Principal,
  spaceId: string,
  id: string,
): Promise<Promotion> {
  assertDecider(principal);
  const found = await getPromotion(ctx, spaceId, id);
  const actor = auditActor(principal);
  if (found.requestedBy === actor) {
    throw new ForbiddenError('A promotion is approved by someone other than whoever requested it');
  }
  // Content types change the schema: approving that takes what changing it directly would.
  if (found.contentTypes.length > 0 && !principal.scopes.includes(SCOPES.contentManage)) {
    throw new ForbiddenError(
      `Approving a promotion with content types takes ${SCOPES.contentManage}`,
    );
  }
  // Both environments must still be there: a deleted target would collect rows no environment owns.
  await resolveEnvironment(ctx, spaceId, found.source);
  await resolveWritableEnvironment(ctx, spaceId, found.target);
  const claimed = await ctx.store.promotions.transition(spaceId, id, 'awaiting_approval', {
    status: 'applying',
    decidedBy: actor,
    decidedAt: ctx.clock.now().toISOString(),
  });
  if (!claimed) {
    throw new ConflictError(`Promotion ${id} is ${found.status}, not awaiting approval`);
  }
  await ctx.store.audit.append(auditRow(ctx, claimed, actor, 'promotion.approved'));
  return applyPromotion(ctx, claimed);
}

/** Rejects a waiting promotion; nothing is copied. */
export async function rejectPromotion(
  ctx: AppContext,
  principal: Principal,
  spaceId: string,
  id: string,
): Promise<Promotion> {
  assertDecider(principal);
  const found = await getPromotion(ctx, spaceId, id);
  const rejected = await ctx.store.promotions.transition(spaceId, id, 'awaiting_approval', {
    status: 'rejected',
    decidedBy: auditActor(principal),
    decidedAt: ctx.clock.now().toISOString(),
  });
  if (!rejected) {
    throw new ConflictError(`Promotion ${id} is ${found.status}, not awaiting approval`);
  }
  await ctx.store.audit.append(
    auditRow(ctx, rejected, rejected.decidedBy ?? auditActor(principal), 'promotion.rejected'),
  );
  return rejected;
}

/**
 * Deciding a promotion takes a person (signed in, or through their own token) or the deployment
 * admin token. API keys can request promotions (CI does) but not decide them: they carry no
 * identity beyond their kind, so "someone other than the requester" couldn't be told apart.
 */
function assertDecider(principal: Principal): void {
  if (principal.kind !== 'user' && principal.kind !== 'admin') {
    throw new ForbiddenError(
      'Approving or rejecting a promotion takes a person or the deployment admin token, not an API key',
    );
  }
  // Not an application acting for the person (an MCP or OAuth client, an agent): content it reads
  // could steer it into approving. People decide in the admin or with their own token.
  if (principal.clientId) {
    throw new ForbiddenError(
      'An application acting for you can request a promotion but not decide one; decide it yourself',
    );
  }
  assertUnrestricted(principal);
}

/**
 * Promotions write and publish whole entries across content types, so a principal whose role
 * limits it to some types or fields can't use them: that would reach what its grants forbid.
 */
function assertUnrestricted(principal: Principal): void {
  if (principal.contentGrants) {
    throw new ForbiddenError('Promotions take a role without content-type or field restrictions');
  }
}

/** An audit row for a promotion's request, decision or outcome. */
function auditRow(ctx: AppContext, promotion: Promotion, actor: string, action: string) {
  return {
    id: ctx.ids.newId(),
    spaceId: promotion.spaceId,
    environmentId: promotion.target,
    actor,
    action,
    targetType: 'promotion',
    targetId: promotion.id,
    status: 200,
    at: ctx.clock.now().toISOString(),
  };
}

export async function getPromotion(
  ctx: AppContext,
  spaceId: string,
  id: string,
): Promise<Promotion> {
  const found = await ctx.store.promotions.get(spaceId, id);
  if (!found) throw new NotFoundError('Promotion', id);
  return found;
}

export async function listPromotions(
  ctx: AppContext,
  spaceId: string,
  opts: { readonly status?: PromotionStatus; readonly limit?: number } = {},
): Promise<Promotion[]> {
  return ctx.store.promotions.list(spaceId, opts);
}

/**
 * Applies a claimed (`applying`) promotion: content types first (entries are validated against
 * them), then each entry's pinned version, published when it was live in the source. Then checks
 * the target holds what was pinned. Any failure marks it `failed`, naming the cause; what was
 * applied before the failure stays, like any other edits.
 */
async function applyPromotion(base: AppContext, promotion: Promotion): Promise<Promotion> {
  if (promotion.status !== 'applying') {
    throw new InvalidStateError(`Promotion ${promotion.id} is ${promotion.status}`);
  }
  // Written as whoever approved it, whether the approval's request or a later sweep applies it.
  const ctx = withActor(base, promotion.decidedBy ?? promotion.requestedBy);
  const source: Scope = { spaceId: promotion.spaceId, environmentId: promotion.source };
  const target: Scope = { spaceId: promotion.spaceId, environmentId: promotion.target };
  const result = {
    contentTypes: [] as string[],
    entries: [] as string[],
    published: [] as string[],
    gated: [] as string[],
  };
  const finish = async (patch: {
    status: 'completed' | 'failed';
    result: PromotionResult;
    error?: string;
  }) => {
    const done = await ctx.store.promotions.transition(
      promotion.spaceId,
      promotion.id,
      'applying',
      {
        ...patch,
        completedAt: ctx.clock.now().toISOString(),
      },
    );
    await ctx.store.audit.append({
      ...auditRow(
        ctx,
        promotion,
        promotion.decidedBy ?? promotion.requestedBy,
        `promotion.${patch.status}`,
      ),
      status: patch.status === 'completed' ? 200 : 500,
    });
    return done;
  };
  try {
    for (const pinned of promotion.contentTypes) {
      const ct = await ctx.store.contentTypes.get(source, pinned.apiId);
      if (!ct) throw new NotFoundError('ContentType', `${promotion.source}/${pinned.apiId}`);
      // What was checked (and approved) is what is copied: a type changed since fails the apply.
      if (ct.version !== pinned.version) {
        throw new ConflictError(
          `The content type "${pinned.apiId}" changed in ${promotion.source} after the promotion was requested; request a new one`,
        );
      }
      await saveContentTypeOver(
        ctx,
        target,
        await ctx.store.contentTypes.get(target, ct.apiId),
        ct,
      );
      // A published definition is saved as published, and the save announces it
      // (`content_type.published`, once): no separate publish.
      result.contentTypes.push(pinned.apiId);
    }
    const pinned = new Map<string, EntryFields>();
    for (const e of promotion.entries) {
      const version = await ctx.store.entries.getVersion(source, e.entryId, e.version);
      if (!version) throw new NotFoundError('Entry version', `${e.entryId}@${e.version}`);
      pinned.set(e.entryId, version.fields);
      // The source's pinned version, copied whole (see `EntryWriteOptions.copy`).
      if (await ctx.store.entries.get(target, e.entryId)) {
        await updateEntry(ctx, target, e.entryId, version.fields, { copy: true });
      } else {
        // A new entry in the target is the source's, promoted: it keeps who created it and when.
        const from = (await ctx.store.entries.get(source, e.entryId))?.entry;
        await createEntry(
          ctx,
          target,
          {
            contentTypeApiId: e.contentTypeApiId,
            fields: version.fields,
            id: e.entryId,
            ...(from
              ? {
                  authorship: {
                    createdAt: from.createdAt ?? null,
                    createdBy: from.createdBy ?? null,
                    firstPublishedAt: from.firstPublishedAt ?? null,
                  },
                }
              : {}),
          },
          { copy: true },
        );
      }
      result.entries.push(e.entryId);
    }
    // Published after every entry exists: a link between promoted entries resolves either way.
    // A gate added since the request: that entry stays a draft, listed, rather than failing the rest.
    const gate = await loadPublishGuard(ctx.store.workflowGraphs, target);
    for (const e of promotion.entries) {
      if (!e.publish) continue;
      if (gate.refusal(e.entryId, e.contentTypeApiId)) {
        result.gated.push(e.entryId);
        continue;
      }
      await publishEntry(ctx, target, e.entryId);
      result.published.push(e.entryId);
    }
    const mismatched: string[] = [];
    for (const [entryId, fields] of pinned) {
      const now = await ctx.store.entries.get(target, entryId);
      if (JSON.stringify(now?.fields ?? null) !== JSON.stringify(fields)) mismatched.push(entryId);
    }
    const done: PromotionResult = { ...result, mismatched };
    // Announced once applied; the record then moves to completed.
    await ctx.store.withTransaction(async (tx) => {
      await tx.outbox.append({
        id: ctx.ids.newId(),
        type: 'environment.promoted',
        scope: target,
        occurredAt: ctx.clock.now().toISOString(),
        promotionId: promotion.id,
        source: promotion.source,
        contentTypes: result.contentTypes.length,
        entries: result.entries.length,
      });
    });
    return (await finish({ status: 'completed', result: done })) ?? promotion;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await finish({ status: 'failed', result: { ...result, mismatched: [] }, error });
    throw err;
  }
}

/** Entry ids a singleton refusal names; the details carry them all. */
const SINGLETON_NAMED = 10;

/**
 * Refuses, when it is requested, a promotion that the apply would refuse for a singleton: one that
 * leaves a type that is a singleton in the target (as promoted, or as the target has it) with more
 * than one entry outside the trash, counting the target's entries and the promoted ones together.
 * The apply still holds the rule (the claim, `saveContentTypeOver`); this says so before anyone
 * approves it.
 */
async function assertSingletonsHold(
  ctx: AppContext,
  target: Scope,
  types: readonly ContentType[],
  entries: readonly PromotedEntry[],
): Promise<void> {
  const incoming = new Map(types.map((t) => [t.apiId, t]));
  const promoted = new Map<string, string[]>();
  for (const e of entries) {
    promoted.set(e.contentTypeApiId, [...(promoted.get(e.contentTypeApiId) ?? []), e.entryId]);
  }
  for (const apiId of new Set([...incoming.keys(), ...promoted.keys()])) {
    const singleton = incoming.has(apiId)
      ? incoming.get(apiId)?.singleton === true
      : (await ctx.store.contentTypes.get(target, apiId))?.singleton === true;
    if (!singleton) continue;
    const ids = promoted.get(apiId) ?? [];
    const [live, there] = await Promise.all([
      ctx.store.entries.list(target, { contentTypeApiId: apiId, limit: ids.length + 2 }),
      ids.length ? ctx.store.entries.getMany(target, ids) : Promise.resolve([]),
    ]);
    // A promoted entry the target holds in its trash stays there; any other is outside it after.
    const trashed = new Set(
      there.filter((e) => e.entry.status === 'archived').map((e) => e.entry.id),
    );
    const after = [
      ...new Set([...live.map((e) => e.entry.id), ...ids.filter((id) => !trashed.has(id))]),
    ];
    if (after.length <= 1) continue;
    const more =
      after.length > SINGLETON_NAMED ? ` and ${after.length - SINGLETON_NAMED} more` : '';
    throw new ConflictError(
      `"${apiId}" is a singleton type in ${target.environmentId}, and the promotion would leave it ` +
        `more than one entry outside the trash (${after.slice(0, SINGLETON_NAMED).join(', ')}${more}). ` +
        'Promote one entry, or move the others to the trash first.',
      { singleton: apiId, entries: after },
    );
  }
}

/** The risk check: the rules, then the decision model's view, which can only add to them. */
async function assessPromotion(
  ctx: AppContext,
  source: Scope,
  target: Scope,
  types: readonly ContentType[],
  entries: readonly PromotedEntry[],
): Promise<PromotionRisk> {
  const reasons: string[] = [];
  const aliases = (await ctx.store.spaces.listAliases(target.spaceId)).filter(
    (a) => a.targetEnvironmentId === target.environmentId,
  );
  const protectedTarget = target.environmentId === 'main' || aliases.length > 0;
  if (target.environmentId === 'main') reasons.push('The target is main');
  for (const a of aliases) reasons.push(`The alias "${a.alias}" points at the target`);

  const kept = await ctx.store.contentTypes.publishedDefinitions(target);
  const typeChanges: Record<string, string[]> = {};
  for (const ct of types) {
    const current = await ctx.store.contentTypes.get(target, ct.apiId);
    if (!current) {
      // A new type changes no field the target has, but agents read its instructions as guidance.
      const adds = [
        ...(ct.agentInstructions ? ['adds agent instructions'] : []),
        ...(ct.preview ? ['adds a preview URL'] : []),
      ];
      if (adds.length) {
        typeChanges[ct.apiId] = adds;
        for (const a of adds) reasons.push(`The content type "${ct.apiId}" ${a}`);
      }
      continue;
    }
    const changes = new Set<string>();
    const incoming = new Map(ct.fields.map((f) => [f.apiId, f]));
    // Against the target's working definition and, when a published definition replaces it, what
    // the target serves: its own draft may have dropped a field Delivery still has. A draft
    // arriving changes nothing served, so only the working definition matters then.
    const live = ct.status === 'published' ? kept.get(ct.apiId) : undefined;
    for (const before of live ? [current, { ...current, fields: live.fields }] : [current]) {
      for (const f of before.fields) {
        const next = incoming.get(f.apiId);
        if (!next) continue;
        if (next.type !== f.type) {
          changes.add(`changes "${f.apiId}" from ${f.type} to ${next.type}`);
        } else if (next.required && !f.required) changes.add(`makes "${f.apiId}" required`);
      }
      // Removals at any depth, then whether the target's entries still hold what is removed: the
      // apply would refuse those (`updateContentType`), so the approver sees which entries first.
      for (const at of removedFields(before.fields, ct.fields)) {
        changes.add(`removes the field "${at}"`);
      }
      for (const [at, variants] of removedVariants(before.fields, ct.fields)) {
        for (const v of variants) changes.add(`removes the block variant "${v}" from "${at}"`);
      }
      const inUse = await removedContentInUse(ctx, target, before, ct);
      for (const { field, entries } of inUse.fieldsInUse) {
        changes.add(
          `removes a field entries in the target still hold: ${describeRemovedInUse(field, entries)}`,
        );
      }
      for (const { variant, entries } of inUse.variantsInUse) {
        changes.add(
          `removes a block variant entries in the target still use: ${describeRemovedInUse(variant, entries)}`,
        );
      }
    }
    // Agents read these as guidance, so an approver sees a change to them even with no field moved.
    if ((ct.agentInstructions ?? '') !== (current.agentInstructions ?? '')) {
      changes.add('changes its agent instructions');
    }
    // Where preview links send their tokens: an approver sees the frontend move.
    if ((ct.preview?.urlTemplate ?? '') !== (current.preview?.urlTemplate ?? '')) {
      changes.add('changes its preview URL');
    }
    if (changes.size) {
      typeChanges[ct.apiId] = [...changes];
      for (const c of changes) reasons.push(`The content type "${ct.apiId}" ${c}`);
    }
  }

  let assessment: PromotionAssessment | undefined;
  let aiRequires = false;
  if (ctx.decisions) {
    const state = wrapUntrusted(
      JSON.stringify({
        source: source.environmentId,
        target: target.environmentId,
        targetIsProtected: protectedTarget,
        contentTypes: types.map((t) => ({ apiId: t.apiId, changes: typeChanges[t.apiId] ?? [] })),
        entries: {
          total: entries.length,
          goingLive: entries.filter((e) => e.publish).length,
          sample: await sampleChanges(ctx, source, target, entries.slice(0, 25)),
        },
      }).slice(0, 20_000),
    );
    const r = await decide(
      ctx,
      ctx.decisions,
      target,
      {
        state,
        tier: 'flagship',
        questions: {
          review: {
            type: 'noul',
            instructions:
              'Should a person check this promotion of content between environments before it goes live?',
          },
          breaking: {
            type: 'noul',
            instructions:
              'Would it remove or break content that readers or integrations depend on?',
          },
          risk: {
            type: 'score',
            instructions: 'How risky is this promotion?',
            levels: [...RISK_LEVELS],
          },
        },
      },
      {
        prompt: 'promotion.risk',
        fallback: () => ({
          review: { type: 'noul', probability: 0 },
          breaking: { type: 'noul', probability: 0 },
          risk: { type: 'score', score: 0, probabilities: [1, 0, 0, 0] },
        }),
      },
    );
    const p = (a: DecisionAnswer | undefined) => (a?.type === 'noul' ? a.probability : 0);
    const score = r.answers.risk?.type === 'score' ? r.answers.risk.score : 0;
    assessment = {
      review: p(r.answers.review),
      breaking: p(r.answers.breaking),
      risk: score,
      source: r.source,
      // The reason category only: a provider's error text has no place in a stored record.
      ...(r.fallback !== undefined ? { fallback: fallbackReason(r.fallback) } : {}),
    };
    if (isUncheckedFallback(r)) {
      // The model should have answered and couldn't: a person checks instead, never a pass.
      aiRequires = true;
      reasons.push('The risk check could not run, so a person checks it');
    } else if (r.source === 'model') {
      if (assessment.review >= REVIEW_THRESHOLD) {
        aiRequires = true;
        reasons.push(`The risk check suggests review (${Math.round(assessment.review * 100)}%)`);
      }
      if (score >= RISK_THRESHOLD) {
        aiRequires = true;
        reasons.push(`The risk check rates it ${RISK_LEVELS[Math.round(score)] ?? 'risky'}`);
      }
    }
  }

  const ruled = protectedTarget || Object.keys(typeChanges).length > 0;
  return {
    protectedTarget,
    reasons,
    ...(assessment ? { assessment } : {}),
    requiresApproval: ruled || aiRequires,
  };
}

/** For the risk check: which top-level fields each sampled entry changes in the target. */
async function sampleChanges(
  ctx: AppContext,
  source: Scope,
  target: Scope,
  entries: readonly PromotedEntry[],
): Promise<{ entryId: string; contentType: string; new: boolean; changedFields: string[] }[]> {
  const out = [];
  for (const e of entries) {
    const incoming =
      (await ctx.store.entries.getVersion(source, e.entryId, e.version))?.fields ?? {};
    const current = (await ctx.store.entries.get(target, e.entryId))?.fields;
    const changedFields = current
      ? [...new Set([...Object.keys(incoming), ...Object.keys(current)])].filter(
          (f) => JSON.stringify(incoming[f] ?? null) !== JSON.stringify(current[f] ?? null),
        )
      : Object.keys(incoming);
    out.push({ entryId: e.entryId, contentType: e.contentTypeApiId, new: !current, changedFields });
  }
  return out;
}

/** A stored fallback reason: its category, never a provider's error text. */
function fallbackReason(fallback: string): string {
  if (fallback === 'mock') return 'mock';
  return fallback.startsWith('budget') ? 'budget' : 'unavailable';
}
