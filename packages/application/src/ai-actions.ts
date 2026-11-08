import {
  type EntryFields,
  isValidApiId,
  NotFoundError,
  type Scope,
  ValidationError,
} from '@commerceworker/domain';
import type { AIActionDefinition, AIProvider, ModelTier } from '@commerceworker/ports';
import { recordAgentRun } from './agent-audit';
import { generateWithBudget } from './ai-budget';
import { UNTRUSTED_CONTENT_GUARD } from './ai-prompt';
import type { AppContext } from './context';
import { getEntry, updateEntry } from './entries';

const VAR_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Extracts the distinct `{{variable}}` names referenced by a template. */
export function templateVariables(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) if (m[1]) out.add(m[1]);
  return [...out];
}

/** Substitutes `{{var}}` tokens from `values`; unknown tokens become empty. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(VAR_RE, (_, name: string) => values[name] ?? '');
}

export interface CreateAIActionInput {
  readonly name: string;
  readonly description?: string;
  readonly promptTemplate: string;
  readonly targetField?: string;
  readonly tier?: ModelTier;
}

/** Creates a reusable AI Action. Variables are derived from the template. */
export async function createAIAction(
  ctx: AppContext,
  scope: Scope,
  input: CreateAIActionInput,
): Promise<AIActionDefinition> {
  if (!input.name.trim()) {
    throw new ValidationError([{ field: 'name', message: 'Name is required' }]);
  }
  if (input.targetField && !isValidApiId(input.targetField)) {
    throw new ValidationError([{ field: 'targetField', message: 'Invalid field apiId' }]);
  }
  const action: AIActionDefinition = {
    id: ctx.ids.newId(),
    name: input.name.trim(),
    description: input.description,
    promptTemplate: input.promptTemplate,
    variables: templateVariables(input.promptTemplate),
    targetField: input.targetField,
    tier: input.tier ?? 'balanced',
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.aiActions.create(scope, action);
  return action;
}

export async function listAIActions(ctx: AppContext, scope: Scope): Promise<AIActionDefinition[]> {
  return ctx.store.aiActions.list(scope);
}

export async function getAIAction(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<AIActionDefinition> {
  const action = await ctx.store.aiActions.get(scope, id);
  if (!action) throw new NotFoundError('AIAction', id);
  return action;
}

export async function deleteAIAction(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  await ctx.store.aiActions.delete(scope, id);
}

export interface RunAIActionInput {
  /** Values for the template's `{{variables}}`. */
  readonly variables?: Record<string, string>;
  /** Entry to target: its text fields become `{{field.<apiId>}}` variables, and
   *  with `apply` the output is written into the action's `targetField`. */
  readonly entryId?: string;
  readonly locale?: string;
  readonly apply?: boolean;
}

export interface RunAIActionResult {
  readonly actionId: string;
  readonly output: string;
  readonly applied: boolean;
  readonly usage: { inputTokens: number; outputTokens: number };
}

/**
 * Runs a stored AI Action: renders its prompt template from the supplied
 * variables (plus the target entry's fields as `{{field.<apiId>}}`), calls the
 * AI provider, and — with `apply` and a `targetField` — writes the result back
 * through the same validators a human edit uses. Every run hits the cost ledger.
 */
export async function runAIAction(
  ctx: AppContext,
  ai: AIProvider,
  scope: Scope,
  id: string,
  input: RunAIActionInput = {},
): Promise<RunAIActionResult> {
  const action = await getAIAction(ctx, scope, id);

  const values: Record<string, string> = { ...input.variables };
  let entryFields: EntryFields | undefined;
  let locale = input.locale;
  if (input.entryId) {
    const { entry, fields } = await getEntry(ctx, scope, input.entryId);
    entryFields = fields;
    const config = await ctx.store.spaces.getConfig(scope);
    locale = locale ?? config?.defaultLocale;
    void entry;
    if (locale) {
      for (const [apiId, localized] of Object.entries(fields)) {
        const value = localized[locale];
        if (typeof value === 'string') values[`field.${apiId}`] = value;
      }
    }
  }

  const prompt = renderTemplate(action.promptTemplate, values);
  const result = await generateWithBudget(ctx, ai, scope, {
    system: `You are running the AI Action "${action.name}". Follow the instructions and return only the requested output. ${UNTRUSTED_CONTENT_GUARD}`,
    prompt,
    tier: action.tier,
    maxTokens: 2048,
  });
  const output = (result.text ?? '').trim();

  let applied = false;
  if (input.apply && action.targetField && input.entryId && entryFields && locale) {
    const merged: EntryFields = { ...entryFields };
    merged[action.targetField] = { ...merged[action.targetField], [locale]: output };
    await updateEntry(ctx, scope, input.entryId, merged);
    applied = true;
  }

  await recordAgentRun(ctx, scope, {
    workflow: `ai-action:${action.name}`,
    entryId: input.entryId ?? '',
    status: 'completed',
    decisions: [`Ran AI Action "${action.name}"`],
    usage: result.usage,
  });

  return { actionId: action.id, output, applied, usage: result.usage };
}
