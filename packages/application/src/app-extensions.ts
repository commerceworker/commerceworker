import { type Scope, ValidationError } from '@commerceworker/domain';
import type { AppExtension } from '@commerceworker/ports';
import type { AppContext } from './context';

export interface CreateAppExtensionInput {
  readonly name: string;
  readonly target: 'field-editor' | 'sidebar';
  readonly entryUrl: string;
  readonly fieldTypes?: readonly string[];
  readonly active?: boolean;
}

/** Registers a UI extension the admin renders in a sandboxed iframe. */
export async function createAppExtension(
  ctx: AppContext,
  scope: Scope,
  input: CreateAppExtensionInput,
): Promise<AppExtension> {
  if (!input.name.trim()) {
    throw new ValidationError([{ field: 'name', message: 'Name is required' }]);
  }
  if (input.target !== 'field-editor' && input.target !== 'sidebar') {
    throw new ValidationError([
      { field: 'target', message: 'target must be "field-editor" or "sidebar"' },
    ]);
  }
  if (!/^https?:\/\//.test(input.entryUrl)) {
    throw new ValidationError([{ field: 'entryUrl', message: 'entryUrl must be an http(s) URL' }]);
  }
  const app: AppExtension = {
    id: ctx.ids.newId(),
    name: input.name.trim(),
    target: input.target,
    entryUrl: input.entryUrl,
    fieldTypes: input.fieldTypes?.length ? input.fieldTypes : undefined,
    active: input.active ?? true,
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.appExtensions.create(scope, app);
  return app;
}

export async function listAppExtensions(ctx: AppContext, scope: Scope): Promise<AppExtension[]> {
  return ctx.store.appExtensions.list(scope);
}

export async function deleteAppExtension(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  await ctx.store.appExtensions.delete(scope, id);
}

/** True if a `field-editor` extension can edit a field of `fieldType`. */
export function appHandlesFieldType(app: AppExtension, fieldType: string): boolean {
  if (app.target !== 'field-editor' || !app.active) return false;
  return !app.fieldTypes || app.fieldTypes.length === 0 || app.fieldTypes.includes(fieldType);
}
