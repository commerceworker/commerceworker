import {
  fillPreviewTemplate,
  type Principal,
  SCOPES,
  type Scope,
  scopesForKind,
  ValidationError,
} from '@commerceworker/domain';
import type { Hasher } from '@commerceworker/ports';
import type { AppContext } from './context';
import { getEntry } from './entries';
import { randomSecret } from './token-crypto';

const DEFAULT_TTL_HOURS = 72;

export interface PreviewLink {
  /** The entry on the Preview API, with the token. */
  readonly url: string;
  /**
   * The entry on the customer's frontend: its type's preview URL template, filled. Absent when
   * the type has none, or a field the template names has no value in the locale yet.
   */
  readonly frontendUrl?: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface CreatePreviewLinkInput {
  readonly ttlHours?: number;
  /** Base URL for the preview API (e.g. https://cms.example.com). */
  readonly previewBaseUrl: string;
  /** The locale `frontendUrl` fills `{locale}` and `{field:…}` in; the space's default if absent. */
  readonly locale?: string;
}

/**
 * Mints an expiring preview token for a single entry. The raw token is returned
 * once; only its hash is stored. The token reads that one entry, wherever the link is opened: the
 * Preview API URL or, when the entry's type has a preview URL template, the customer's frontend.
 */
export async function createPreviewLink(
  ctx: AppContext,
  hasher: Hasher,
  scope: Scope,
  entryId: string,
  input: CreatePreviewLinkInput,
): Promise<PreviewLink> {
  const view = await getEntry(ctx, scope, entryId);
  const [contentType, config] = await Promise.all([
    ctx.store.contentTypes.get(scope, view.entry.contentTypeApiId),
    ctx.store.spaces.getConfig(scope),
  ]);
  const template = contentType?.preview?.urlTemplate;
  const defaultLocale = config?.defaultLocale ?? '';
  const locale = input.locale ?? defaultLocale;
  if (template && input.locale !== undefined && !config?.locales.includes(input.locale)) {
    throw new ValidationError([{ field: 'locale', message: `Unknown locale "${input.locale}"` }]);
  }

  const ttlHours = input.ttlHours ?? DEFAULT_TTL_HOURS;
  const expiresAt = new Date(ctx.clock.now());
  expiresAt.setHours(expiresAt.getHours() + ttlHours);

  const token = `pw_${randomSecret()}`;
  const id = ctx.ids.newId();

  await ctx.store.previewTokens.create({
    id,
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    entryId,
    hashedToken: hasher.hash(token),
    expiresAt,
    revoked: false,
  });

  const base = input.previewBaseUrl.replace(/\/$/, '');
  const url = `${base}/preview/${scope.spaceId}/${scope.environmentId}/entries/${entryId}?preview_token=${token}`;
  const frontendUrl = template
    ? fillPreviewTemplate(template, {
        id: entryId,
        token,
        locale,
        space: scope.spaceId,
        environment: scope.environmentId,
        // A field that isn't localized holds its value under the default locale; a localized one
        // never borrows another locale's value, which would preview some other locale's page.
        fields: Object.fromEntries(
          (contentType?.fields ?? []).map((f) => [
            f.apiId,
            view.fields[f.apiId]?.[f.localized ? locale : defaultLocale],
          ]),
        ),
      })
    : null;
  return {
    url,
    ...(frontendUrl ? { frontendUrl } : {}),
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Resolves a preview link token to a read-only CPA principal for one entry. */
export async function principalFromPreviewToken(
  ctx: AppContext,
  hasher: Hasher,
  scope: Scope,
  entryId: string,
  token: string | undefined,
): Promise<Principal | null> {
  if (!token) return null;
  const record = await ctx.store.previewTokens.findByHash(hasher.hash(token));
  if (!record || record.revoked) return null;
  if (
    record.spaceId !== scope.spaceId ||
    record.environmentId !== scope.environmentId ||
    record.entryId !== entryId
  ) {
    return null;
  }
  if (record.expiresAt.getTime() <= ctx.clock.now().getTime()) return null;

  const view = await getEntry(ctx, scope, entryId);
  return {
    spaceId: scope.spaceId,
    kind: 'cpa',
    scopes: scopesForKind('cpa'),
    contentGrants: [
      {
        contentTypeApiId: view.entry.contentTypeApiId,
        actions: ['read'],
      },
    ],
  };
}

/** Builds a human OIDC principal from session claims and an assigned role. */
export function principalFromOidcUser(input: {
  readonly subject: string;
  readonly spaceId: string;
  readonly scopes: readonly string[];
  readonly contentGrants?: Principal['contentGrants'];
  readonly sessionId: string;
}): Principal {
  return {
    spaceId: input.spaceId,
    kind: 'user',
    scopes: input.scopes.length ? input.scopes : [SCOPES.previewRead, SCOPES.contentWrite],
    contentGrants: input.contentGrants,
    subject: input.subject,
    sessionId: input.sessionId,
  };
}
