/**
 * What the catalog's admin writes record in the audit log, as REST and MCP both write it: one place
 * for the counts, so the same write reads the same on either transport (each adds its own `via`).
 */

import type { EditResult, StageEdit, WriteResult } from './api';

/** What a product write did, by outcome. */
export function productsWritten(results: WriteResult[], urgent?: boolean) {
  const count = (s: WriteResult['status']) => results.filter((r) => r.status === s).length;
  return {
    created: count('created'),
    updated: count('updated'),
    unchanged: count('unchanged'),
    rejected: count('rejected'),
    urgent: urgent ?? false,
  };
}

export const productsDeleted = (results: WriteResult[]) => ({
  deleted: results.filter((r) => r.status === 'deleted').length,
});

/** What staging edits did: how many landed, were refused, on how many products, from drafts. */
export function editsStaged(edits: StageEdit[], results: EditResult[]) {
  const staged = results.filter((r) => r.ok);
  return {
    staged: staged.length,
    refused: results.length - staged.length,
    products: new Set(staged.map((r) => r.key)).size,
    fromDrafts: edits.filter((e, i) => e.source === 'assistant' && results[i]?.ok).length,
  };
}

/** A refused delete's answer: `notFound` when there was nothing to delete, else still in use. */
export const deleteRefusal = (
  what: string,
  r: { issues: string[]; notFound?: true },
): { notFound: boolean; message: string } => ({
  notFound: !!r.notFound,
  message: r.notFound
    ? `Not found: ${r.issues.join(' ')}`
    : `${what} is in use: ${r.issues.join(' ')}`,
});

/** The name a feed gets when its caller gives none. */
export const feedName = (name: string | null | undefined, format: string) =>
  (name || `feed.${format}`).slice(0, 200);
