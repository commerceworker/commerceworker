import {
  type ContentType,
  type EntryFields,
  type FieldDefinition,
  fieldStates,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type { AIProvider, DecisionQuestion, ModelTier } from '@commerceworker/ports';
import { recordAgentRun } from './agent-audit';
import { decideWithBudget, generateWithBudget } from './ai-budget';
import { answerStrings, conformingAnswer } from './ai-json';
import { describeFieldForModel, UNTRUSTED_CONTENT_GUARD, wrapUntrusted } from './ai-prompt';
import type { AppContext } from './context';
import { getEntry, updateEntry } from './entries';
import { createTag, getEntryMetadata, listTags, setEntryMetadata } from './taxonomy';

/** Field types whose values are free text we can translate/summarize over. */
const TEXT_TYPES = new Set(['Symbol', 'Text']);
/** Scalar field types an autofill can produce. */
const SCALAR_TYPES = new Set(['Symbol', 'Text', 'Integer', 'Number', 'Boolean', 'Date']);

async function loadEntryForAi(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<{ fields: EntryFields; ct: ContentType; defaultLocale: string; locales: string[] }> {
  const { entry, fields } = await getEntry(ctx, scope, id);
  const ct = await ctx.store.contentTypes.get(scope, entry.contentTypeApiId);
  if (!ct) throw new NotFoundError('ContentType', entry.contentTypeApiId);
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return { fields, ct, defaultLocale: config.defaultLocale, locales: [...config.locales] };
}

/** Collects readable text from an entry's text fields in a given locale. */
function collectText(
  ct: ContentType,
  fields: EntryFields,
  locale: string,
  fallback: string,
): string {
  const parts: string[] = [];
  for (const f of ct.fields) {
    if (!TEXT_TYPES.has(f.type)) continue;
    const value = fields[f.apiId]?.[locale] ?? fields[f.apiId]?.[fallback];
    if (typeof value === 'string' && value.trim()) parts.push(`${f.name}: ${value}`);
  }
  return parts.join('\n');
}

type Usage = { inputTokens: number; outputTokens: number };

// ---- translate ------------------------------------------------------------

export interface TranslateEntryInput {
  readonly targetLocale: string;
  /** Locale to translate from; defaults to the space default locale. */
  readonly sourceLocale?: string;
  /** When true, persist the translated values as a new draft version. */
  readonly apply?: boolean;
  readonly tier?: ModelTier;
}

export interface TranslateResult {
  readonly fields: EntryFields;
  readonly translatedFields: readonly string[];
  readonly applied: boolean;
  readonly usage: Usage;
}

/**
 * Translates an entry's localized text fields into a target locale, leaving
 * other locales/fields untouched. With `apply`, saves a new draft version
 * through the same validators a human edit uses.
 */
export async function translateEntry(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  id: string,
  input: TranslateEntryInput,
): Promise<TranslateResult> {
  const { fields, ct, defaultLocale, locales } = await loadEntryForAi(ctx, scope, id);
  const source = input.sourceLocale ?? defaultLocale;
  if (!locales.includes(input.targetLocale)) {
    throw new ValidationError([
      { field: 'targetLocale', message: `Unknown locale ${input.targetLocale}` },
    ]);
  }

  const source_texts: Record<string, string> = {};
  // A field its rules hide or disable in the target locale takes no translation.
  const states = fieldStates(ct.fields, fields, input.targetLocale, defaultLocale);
  for (const f of ct.fields) {
    if (!TEXT_TYPES.has(f.type) || !f.localized) continue;
    const state = states.get(f.apiId);
    if (state?.hidden || state?.disabled) continue;
    const value = fields[f.apiId]?.[source];
    if (typeof value === 'string' && value.trim()) source_texts[f.apiId] = value;
  }
  const fieldIds = Object.keys(source_texts);
  if (fieldIds.length === 0) {
    return {
      fields,
      translatedFields: [],
      applied: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const properties: Record<string, Record<string, unknown>> = {};
  for (const apiId of fieldIds) properties[apiId] = { type: 'string' };
  const result = await generateWithBudget(ctx, ai, scope, {
    system: `You are a professional translator. Translate each field value into ${input.targetLocale}, preserving meaning, tone, and any markup. Return only the translations. ${UNTRUSTED_CONTENT_GUARD}`,
    prompt: `Translate these fields from ${source} to ${input.targetLocale}:\n${wrapUntrusted(JSON.stringify(source_texts, null, 2))}`,
    tier: input.tier ?? 'balanced',
    maxTokens: 4096,
    outputSchema: {
      type: 'object',
      properties,
      required: fieldIds,
      additionalProperties: false,
    },
  });

  const translations = (result.object ?? {}) as Record<string, unknown>;
  const merged: EntryFields = { ...fields };
  const translatedFields: string[] = [];
  for (const apiId of fieldIds) {
    const value = translations[apiId];
    if (typeof value === 'string' && value.trim()) {
      merged[apiId] = { ...merged[apiId], [input.targetLocale]: value };
      translatedFields.push(apiId);
    }
  }

  let applied = false;
  if (input.apply && translatedFields.length > 0) {
    await updateEntry(ctx, scope, id, merged);
    applied = true;
  }
  await recordAgentRun(ctx, scope, {
    workflow: 'translate',
    entryId: id,
    status: 'completed',
    decisions: [`Translated ${translatedFields.length} field(s) to ${input.targetLocale}`],
    usage: result.usage,
  });
  return { fields: merged, translatedFields, applied, usage: result.usage };
}

// ---- summarize ------------------------------------------------------------

export interface SummarizeEntryInput {
  readonly locale?: string;
  readonly maxWords?: number;
  /** When set with `apply`, write the summary into this (text) field. */
  readonly targetField?: string;
  readonly apply?: boolean;
  readonly tier?: ModelTier;
}

export interface SummarizeResult {
  readonly summary: string;
  readonly applied: boolean;
  readonly usage: Usage;
}

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
};

/** Produces a concise summary of an entry's text content. */
export async function summarizeEntry(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  id: string,
  input: SummarizeEntryInput = {},
): Promise<SummarizeResult> {
  const { fields, ct, defaultLocale } = await loadEntryForAi(ctx, scope, id);
  const locale = input.locale ?? defaultLocale;
  const text = collectText(ct, fields, locale, defaultLocale);
  if (!text.trim()) {
    throw new ValidationError([{ field: '', message: 'Entry has no text to summarize' }]);
  }
  const maxWords = input.maxWords ?? 60;
  const result = await generateWithBudget(ctx, ai, scope, {
    system: `You summarize content. Write a single clear summary of at most ${maxWords} words. ${UNTRUSTED_CONTENT_GUARD}`,
    prompt: `Summarize this ${ct.name}:\n${wrapUntrusted(text)}`,
    tier: input.tier ?? 'fast',
    maxTokens: 512,
    outputSchema: SUMMARY_SCHEMA,
  });
  // A text-only answer is the summary; a JSON one without the shape holds none.
  const obj = conformingAnswer<{ summary: string }>(result, SUMMARY_SCHEMA);
  const summary = (
    obj ? obj.summary : result.object === undefined ? (result.text ?? '') : ''
  ).trim();
  if (!summary) throw new ValidationError([{ field: 'summary', message: 'No summary produced' }]);

  let applied = false;
  if (input.apply && input.targetField) {
    const merged: EntryFields = { ...fields };
    merged[input.targetField] = { ...merged[input.targetField], [locale]: summary };
    await updateEntry(ctx, scope, id, merged);
    applied = true;
  }
  await recordAgentRun(ctx, scope, {
    workflow: 'summarize',
    entryId: id,
    status: 'completed',
    decisions: [`Summarized ${ct.name}`],
    usage: result.usage,
  });
  return { summary, applied, usage: result.usage };
}

// ---- autofill -------------------------------------------------------------

export interface AutofillFieldInput {
  readonly field: string;
  readonly locale?: string;
  readonly instructions?: string;
  readonly apply?: boolean;
  readonly tier?: ModelTier;
}

export interface AutofillResult {
  readonly field: string;
  readonly value: unknown;
  readonly applied: boolean;
  readonly usage: Usage;
}

function jsonTypeFor(field: FieldDefinition): string {
  switch (field.type) {
    case 'Integer':
      return 'integer';
    case 'Number':
      return 'number';
    case 'Boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

/** Generates a value for one scalar field from the entry's other fields. */
export async function autofillField(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  id: string,
  input: AutofillFieldInput,
): Promise<AutofillResult> {
  const { fields, ct, defaultLocale } = await loadEntryForAi(ctx, scope, id);
  const locale = input.locale ?? defaultLocale;
  const def = ct.fields.find((f) => f.apiId === input.field);
  if (!def) throw new NotFoundError('Field', input.field);
  if (!SCALAR_TYPES.has(def.type)) {
    throw new ValidationError([
      { field: input.field, message: `Cannot autofill a ${def.type} field` },
    ]);
  }
  // The rules read the entry as stored: a value for a field they hide would be content nobody
  // sees, and a disabled one would be refused on save anyway.
  const state = fieldStates(ct.fields, fields, locale, defaultLocale).get(def.apiId);
  if (state?.hidden || state?.disabled) {
    throw new ValidationError([
      {
        field: input.field,
        message: `Cannot autofill a field its rules ${state.hidden ? 'hide' : 'disable'}`,
      },
    ]);
  }

  const context = collectText(ct, fields, locale, defaultLocale);
  const result = await generateWithBudget(ctx, ai, scope, {
    system: `You fill in a single missing field of a content entry based on its other fields. Return only the value, matching the requested type. ${UNTRUSTED_CONTENT_GUARD}`,
    prompt: [
      `Content type: ${ct.name}.`,
      `Field to fill: ${describeFieldForModel(def)} (${def.type}).`,
      input.instructions ? `Instructions: ${input.instructions}` : '',
      `Other fields:\n${context ? wrapUntrusted(context) : '(none)'}`,
    ]
      .filter(Boolean)
      .join('\n'),
    tier: input.tier ?? 'balanced',
    maxTokens: 1024,
    outputSchema: {
      type: 'object',
      properties: { value: { type: jsonTypeFor(def) } },
      required: ['value'],
      additionalProperties: false,
    },
  });
  const obj = result.object as { value?: unknown } | undefined;
  const value = obj?.value;
  if (value === undefined || value === null) {
    throw new ValidationError([{ field: input.field, message: 'No value produced' }]);
  }

  let applied = false;
  if (input.apply) {
    const merged: EntryFields = { ...fields };
    merged[input.field] = { ...merged[input.field], [locale]: value };
    await updateEntry(ctx, scope, id, merged); // validated like a human edit
    applied = true;
  }
  await recordAgentRun(ctx, scope, {
    workflow: 'autofill',
    entryId: id,
    status: 'completed',
    decisions: [`Autofilled ${def.name}`],
    usage: result.usage,
  });
  return { field: input.field, value, applied, usage: result.usage };
}

// ---- classify / suggest tags ---------------------------------------------

export interface SuggestEntryTagsInput {
  readonly apply?: boolean;
  readonly tier?: ModelTier;
}

export interface SuggestEntryTagsResult {
  readonly tagIds: readonly string[];
  readonly newTags: readonly string[];
  readonly applied: boolean;
  readonly usage: Usage;
}

const TAGS_SCHEMA = {
  type: 'object',
  properties: {
    existingTags: { type: 'array', items: { type: 'string' } },
    newTags: { type: 'array', items: { type: 'string' } },
  },
  required: ['existingTags', 'newTags'],
  additionalProperties: false,
};

/** Suggests taxonomy tags for an entry, matching the existing vocabulary. */
export async function suggestEntryTags(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  id: string,
  input: SuggestEntryTagsInput = {},
): Promise<SuggestEntryTagsResult> {
  const { fields, ct, defaultLocale } = await loadEntryForAi(ctx, scope, id);
  const text = collectText(ct, fields, defaultLocale, defaultLocale);
  const existing = await listTags(ctx, scope);
  // Set when the decision model has already ruled on every existing tag (and found none).
  let decided = false;
  if (ctx.decisions && existing.length > 0) {
    // Picking from the vocabulary is a decision: one yes/no per existing tag, 64 to a request.
    // A new tag name is writing, so the generative model is asked only when nothing fits, as
    // the prompt below told it to prefer anyway.
    const state = `Content type: ${ct.name}.\n${text || '(no text)'}`.slice(0, 20_000);
    const picked: string[] = [];
    let inputTokens = 0;
    for (let at = 0; at < existing.length; at += 64) {
      const batch = existing.slice(at, at + 64);
      const questions = Object.fromEntries(
        batch.map((t, i) => [
          `t${at + i}`,
          { type: 'noul', instructions: `Does the tag "${t.name}" describe this content?` },
        ]),
      ) as Record<string, DecisionQuestion>;
      const r = await decideWithBudget(ctx, ctx.decisions, scope, {
        state,
        tier: input.tier ?? 'fast',
        questions,
      });
      inputTokens += r.usage.inputTokens;
      batch.forEach((t, i) => {
        const a = r.answers[`t${at + i}`];
        if (a?.type === 'noul' && a.probability >= TAG_THRESHOLD) picked.push(t.id);
      });
    }
    if (picked.length > 0) {
      return finishTagSuggestion(ctx, scope, id, input, picked, [], {
        inputTokens,
        outputTokens: 0,
      });
    }
    decided = true;
  }
  const result = await generateWithBudget(ctx, ai, scope, {
    system: `You classify content with taxonomy tags. Prefer the existing vocabulary; suggest new tag names only when nothing fits. Return tag NAMES, lowercase. ${UNTRUSTED_CONTENT_GUARD}`,
    prompt: [
      `Content type: ${ct.name}.`,
      `Content:\n${text ? wrapUntrusted(text) : '(no text)'}`,
      `Existing tags: ${existing.map((t) => t.name).join(', ') || '(none)'}`,
    ].join('\n'),
    tier: input.tier ?? 'fast',
    maxTokens: 512,
    outputSchema: TAGS_SCHEMA,
  });

  // Each list read on its own: what isn't a list of names suggests nothing, never a TypeError.
  const obj = {
    existingTags: answerStrings(result, 'existingTags'),
    newTags: answerStrings(result, 'newTags'),
  };
  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t]));
  // After the decision model found no existing tag that fits, only the new names are taken:
  // the generative model doesn't get to overrule that decision.
  const tagIds = decided
    ? []
    : obj.existingTags
        .map((n) => byName.get(n.toLowerCase())?.id)
        .filter((v): v is string => Boolean(v));
  const newTags = obj.newTags.map((n) => n.trim()).filter((n) => n && !byName.has(n.toLowerCase()));
  return finishTagSuggestion(ctx, scope, id, input, tagIds, newTags, result.usage);
}

/** Probability at which a decision model's yes picks an existing tag. */
const TAG_THRESHOLD = 0.5;

/** Applies (when asked), records the run, and answers: shared by both suggestion paths. */
async function finishTagSuggestion(
  ctx: AppContext,
  scope: Scope,
  id: string,
  input: SuggestEntryTagsInput,
  tagIds: readonly string[],
  newTags: readonly string[],
  usage: Usage,
): Promise<SuggestEntryTagsResult> {
  let applied = false;
  if (input.apply) {
    const createdIds: string[] = [];
    for (const name of newTags) createdIds.push((await createTag(ctx, scope, { name })).id);
    const current = await getEntryMetadata(ctx, scope, id);
    const allTags = Array.from(new Set([...(current?.tags ?? []), ...tagIds, ...createdIds]));
    // setEntryMetadata replaces the whole record — carry concepts through.
    await setEntryMetadata(ctx, scope, id, { tags: allTags, concepts: current?.concepts ?? [] });
    applied = true;
  }
  await recordAgentRun(ctx, scope, {
    workflow: 'classify',
    entryId: id,
    status: 'completed',
    decisions: [`Suggested ${tagIds.length + newTags.length} tag(s)`],
    usage,
  });
  return { tagIds: [...tagIds], newTags: [...newTags], applied, usage };
}

export interface ApplyEntryTagsInput {
  /** Existing-tag ids from a reviewed suggestion. Unknown ids are rejected. */
  readonly tagIds?: readonly string[];
  /** New tag names from a reviewed suggestion; existing names are reused. */
  readonly newTags?: readonly string[];
}

export interface ApplyEntryTagsResult {
  /** The entry's full tag set after the apply. */
  readonly tagIds: readonly string[];
  /** Tags created by this apply (names that had no vocabulary match). */
  readonly createdTags: readonly { id: string; name: string }[];
}

/**
 * Persists a REVIEWED tag suggestion exactly as approved — the human-in-the-loop
 * counterpart to `suggestEntryTags`. Deliberately deterministic: re-running the
 * model at apply time could assign tags the reviewer never saw. Mirrors the
 * suggest semantics (case-insensitive vocabulary reuse, merge with the entry's
 * current tags).
 */
export async function applyEntryTags(
  ctx: AppContext,
  scope: Scope,
  id: string,
  input: ApplyEntryTagsInput,
): Promise<ApplyEntryTagsResult> {
  // Validate everything BEFORE the createTag writes: a stale review (unknown
  // entry or deleted tag id) must fail without orphaning new vocabulary tags.
  if (!(await ctx.store.entries.get(scope, id))) throw new NotFoundError('Entry', id);
  const existing = await listTags(ctx, scope);
  const byId = new Set(existing.map((t) => t.id));
  for (const tagId of input.tagIds ?? []) {
    if (!byId.has(tagId)) throw new NotFoundError('Tag', tagId);
  }
  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t]));

  const createdTags: { id: string; name: string }[] = [];
  const reusedIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.newTags ?? []) {
    const name = raw.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const match = byName.get(name.toLowerCase());
    if (match) reusedIds.push(match.id);
    else createdTags.push(await createTag(ctx, scope, { name }));
  }

  const current = await getEntryMetadata(ctx, scope, id);
  const currentTags = current?.tags ?? [];
  const allTags = Array.from(
    new Set([
      ...currentTags,
      ...(input.tagIds ?? []),
      ...reusedIds,
      ...createdTags.map((t) => t.id),
    ]),
  );
  // setEntryMetadata replaces the whole metadata record, so carry concepts
  // through; it also validates the entry and every tag id, so an unknown id
  // from a stale review fails loudly instead of polluting metadata.
  await setEntryMetadata(ctx, scope, id, { tags: allTags, concepts: current?.concepts ?? [] });
  await recordAgentRun(ctx, scope, {
    workflow: 'classify',
    entryId: id,
    status: 'completed',
    decisions: [`Applied ${allTags.length - currentTags.length} reviewed tag(s)`],
    usage: { inputTokens: 0, outputTokens: 0 },
  });
  return { tagIds: allTags, createdTags };
}
