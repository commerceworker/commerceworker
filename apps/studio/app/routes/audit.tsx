import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Form, Link, useLoaderData, useSubmit } from 'react-router';
import { AuditTable } from '~/components/audit-table';
import { Empty, PageHeader, Section } from '~/components/page';
import { AUDIT_GROUPS, isAuditGroup } from '~/lib/audit';
import { listAudit } from '~/lib/audit.server';
import { requireUser } from '~/lib/auth.server';
import type { Route } from './+types/audit';

export const meta = () => [{ title: 'Audit log · CommerceWorker' }];

const PAGE = 100;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request, 'admin');
  const q = new URL(request.url).searchParams;
  const type = q.get('type');
  const group = isAuditGroup(type) ? type : undefined;
  const before = Number(q.get('before')) || undefined;
  const beforeId = q.get('beforeId') || undefined;
  // Where this page sits, for its label: paging is by time (`before`), so the page number rides
  // along in the URL. Without `before` it's the first page, whatever the URL says.
  const page = before ? Math.max(2, Math.trunc(Number(q.get('page'))) || 2) : 1;
  const events = await listAudit({ group, before, beforeId, limit: PAGE });
  return { events, group: group ?? '', before: before ?? null, page, more: events.length === PAGE };
}

export default function Audit() {
  const { events, group, before, page, more } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const older = events.at(-1);
  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Sign-ins, and changes to people, single sign-on, SCIM and sign-in rules, newest first. Content changes are in each space’s own audit log."
        crumbs={<Link to="/team">People and sign-in</Link>}
      />
      <div className="mx-auto max-w-page space-y-4 px-4 pb-10 sm:px-6">
        <Form method="get" className="flex items-center gap-2">
          <label htmlFor="type" className="text-muted-foreground text-sm">
            Show
          </label>
          <NativeSelect
            id="type"
            name="type"
            defaultValue={group}
            className="h-8"
            onChange={(e) => submit(e.currentTarget.form)}
          >
            <NativeSelectOption value="">Everything</NativeSelectOption>
            {Object.entries(AUDIT_GROUPS).map(([k, label]) => (
              <NativeSelectOption key={k} value={k}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Form>
        <Section title="Events" flush>
          {events.length ? (
            <AuditTable events={events} />
          ) : (
            <Empty>
              {group
                ? 'Nothing of this kind yet.'
                : 'Sign-ins, changes to people and tokens, and refused API calls appear here as they happen, newest first.'}
            </Empty>
          )}
        </Section>
        {before || (more && older) ? (
          <nav aria-label="Audit log pages" className="flex items-center gap-4 text-sm">
            {before ? (
              <Link
                to={group ? `/audit?type=${group}` : '/audit'}
                className="hit-area text-link hover:underline"
              >
                Newest
              </Link>
            ) : null}
            <span className="text-muted-foreground" aria-current="page">
              Page {page}
            </span>
            {more && older ? (
              <Link
                to={`/audit?${new URLSearchParams({ ...(group ? { type: group } : {}), before: String(older.at), beforeId: older.id, page: String(page + 1) })}`}
                className="hit-area text-link hover:underline"
              >
                Older
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </>
  );
}
