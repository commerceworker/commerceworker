import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@commerceworker/ui/breadcrumb';
import { Fragment } from 'react';
import { Link, useLocation } from 'react-router';
import { useClient } from '../../lib/client-context';
import { useContentTypesQuery, useEntryQuery, useScopedQuery } from '../../lib/queries';
import { navItemFor, SETTINGS_SECTIONS } from './nav';

/** Fixed child segments under a content type. */
const CONTENT_CHILD: Record<string, string> = { new: 'New entry', import: 'Import entries' };

/** Sentence-case a raw segment ("audit-log" → "Audit log") for routes NAV doesn't know. */
const sentence = (seg: string) => {
  const s = decodeURIComponent(seg).replace(/[-_]+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** An entry's display title in `locale`, else in any locale; undefined if it has none. */
export function entryTitle(
  fields: Readonly<Record<string, unknown>>,
  displayField: string | undefined,
  locale: string,
): string | undefined {
  if (!displayField) return undefined;
  const value = fields[displayField];
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const byLocale = value as Record<string, unknown>;
  const pick = byLocale[locale] ?? Object.values(byLocale).find((v) => typeof v === 'string');
  return typeof pick === 'string' && pick.trim() ? pick.trim() : undefined;
}

/**
 * Breadcrumb trail derived from the URL and named from NAV and the query
 * cache: Content / Article / “Hello world”. Every crumb is sentence case; an
 * entry reads as its title (never its id), or "Entry" until it has loaded.
 * `pages` names top-level pages NAV doesn't list (the deployment's own, the
 * account), so they read as their titles rather than their URL.
 */
export function Breadcrumbs({
  pages = [],
}: {
  pages?: readonly { readonly to: string; readonly label: string }[];
}) {
  const segments = useLocation().pathname.split('/').filter(Boolean);
  const { conn } = useClient();
  const isContent = segments[0] === 'content';
  const typeId = isContent ? segments[1] : undefined;
  const child = isContent ? segments[2] : undefined;
  const entryId = child && !(child in CONTENT_CHILD) ? child : undefined;

  const types = useContentTypesQuery().data;
  const type = typeId ? types?.find((t) => t.apiId === typeId) : undefined;
  const entry = useEntryQuery(entryId).data;
  // A workflow reads as its name, from the editor's own query (never fetched from here).
  const workflowId = segments[0] === 'workflows' ? segments[1] : undefined;
  const { client } = useClient();
  const workflow = useScopedQuery(
    ['workflow', workflowId ? decodeURIComponent(workflowId) : ''],
    () => client.getWorkflow(decodeURIComponent(workflowId ?? '')),
    { enabled: false },
  ).data;

  if (segments.length === 0) return null;

  const labelAt = (i: number): string => {
    const seg = segments[i] ?? '';
    if (i === 0) {
      const to = `/${seg}`;
      return navItemFor(to)?.label ?? pages.find((p) => p.to === to)?.label ?? sentence(seg);
    }
    if (segments[0] === 'settings' && i === 1) {
      return SETTINGS_SECTIONS.find((s) => s.id === seg)?.label ?? sentence(seg);
    }
    if (isContent && i === 1) return type?.name ?? seg;
    if (workflowId && i === 1) return workflow?.name || 'Workflow';
    if (isContent && i === 2) {
      if (!entryId) return CONTENT_CHILD[seg] ?? sentence(seg);
      const title = entry && entryTitle(entry.fields, type?.displayField, conn.locale);
      return title ?? 'Entry';
    }
    return sentence(seg);
  };

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {segments.map((_seg, i) => {
          const href = `/${segments.slice(0, i + 1).join('/')}`;
          const isLast = i === segments.length - 1;
          const label = labelAt(i);
          return (
            <Fragment key={href}>
              {/* Ancestors give way on a phone; the page you're on always shows. */}
              <BreadcrumbItem className={isLast ? 'min-w-0' : 'hidden shrink-0 sm:inline-flex'}>
                {isLast ? (
                  <BreadcrumbPage className="truncate">{label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={href}>{label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && <BreadcrumbSeparator className="hidden sm:inline-flex" />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
