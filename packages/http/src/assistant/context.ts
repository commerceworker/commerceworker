import {
  type AssistantContext,
  type AssistantPage,
  isSetupScope,
  SETUP_SCOPE,
} from '@commerceworker/domain';

/** Ids as the admin uses them in a URL: no spaces, no path separators, not unbounded. */
const ID = /^[\w.:-]{1,128}$/;

const label = (v: unknown, fallback: string) =>
  (typeof v === 'string' && v.trim() ? v.trim() : fallback).slice(0, 120);

/**
 * The page context the panel sent with a message or a page edit, or null when it names no usable
 * scope: every turn and every edit runs in exactly one space and environment, so without them
 * there is nothing to do. A page that is malformed counts as "everything". `SETUP_SCOPE` (no space
 * yet: setting one up) is a scope of its own, about no page.
 */
export function readContext(raw: unknown): AssistantContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const { scope, page } = raw as { scope?: unknown; page?: unknown };
  if (!scope || typeof scope !== 'object') return null;
  const { spaceId, environmentId, locale } = scope as Record<string, unknown>;
  if (
    typeof spaceId === 'string' &&
    typeof environmentId === 'string' &&
    isSetupScope({ spaceId, environmentId })
  )
    return { scope: SETUP_SCOPE, page: { kind: 'everything' } };
  if (typeof spaceId !== 'string' || !ID.test(spaceId)) return null;
  if (typeof environmentId !== 'string' || !ID.test(environmentId)) return null;
  return {
    scope: {
      spaceId,
      environmentId,
      ...(typeof locale === 'string' && /^[A-Za-z0-9-]{2,35}$/.test(locale) ? { locale } : {}),
    },
    page: readPage(page),
  };
}

function readPage(raw: unknown): AssistantPage {
  const p = (raw ?? {}) as Record<string, unknown>;
  const contentType =
    typeof p.contentType === 'string' && ID.test(p.contentType) ? p.contentType : '';
  if (p.kind === 'entry' && typeof p.entryId === 'string' && ID.test(p.entryId) && contentType)
    return { kind: 'entry', entryId: p.entryId, contentType, label: label(p.label, p.entryId) };
  if (p.kind === 'content-type' && contentType)
    return { kind: 'content-type', contentType, label: label(p.label, contentType) };
  return { kind: 'everything' };
}
