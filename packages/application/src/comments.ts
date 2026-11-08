import { type Comment, NotFoundError, type Scope } from '@commerceworker/domain';
import type { AppContext } from './context';

export interface AddCommentInput {
  readonly entryId: string;
  readonly body: string;
  readonly author: string;
  /** The comment being replied to, if any. */
  readonly parentId?: string;
}

/** Adds a comment (or threaded reply) to an entry. */
export async function addComment(
  ctx: AppContext,
  scope: Scope,
  input: AddCommentInput,
): Promise<Comment> {
  if (!(await ctx.store.entries.get(scope, input.entryId))) {
    throw new NotFoundError('Entry', input.entryId);
  }
  if (input.parentId && !(await ctx.store.comments.get(scope, input.parentId))) {
    throw new NotFoundError('Comment', input.parentId);
  }
  const comment: Comment = {
    id: ctx.ids.newId(),
    entryId: input.entryId,
    parentId: input.parentId ?? null,
    author: input.author,
    body: input.body,
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.comments.create(scope, comment);
  return comment;
}

export async function listComments(
  ctx: AppContext,
  scope: Scope,
  entryId: string,
): Promise<Comment[]> {
  return ctx.store.comments.listForEntry(scope, entryId);
}

export async function deleteComment(ctx: AppContext, scope: Scope, id: string): Promise<void> {
  if (!(await ctx.store.comments.get(scope, id))) throw new NotFoundError('Comment', id);
  await ctx.store.comments.delete(scope, id);
}
