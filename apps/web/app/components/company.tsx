/**
 * A business customer's company on its page: its status and the moves it may make, its members
 * (their roles, teams and own order limits) and its team tree. Every change goes through the
 * assistant (`useChange`), so its card says what it does, a refusal says why, and the audit trail
 * names the person. Which moves are offered is core's lifecycle, not a list kept here.
 */
import {
  COMPANY_LIFECYCLE,
  COMPANY_ROLE_LABELS,
  COMPANY_ROLES,
  COMPANY_STATUS_LABELS,
  type CompanyRole,
  type CompanyStatus,
  CUSTOMER_KINDS,
  MEMBER_LIFECYCLE,
  MEMBER_STATUS_LABELS,
  type MemberStatus,
  teamDepth,
} from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { count, money } from '@commerceworker/ui/lib/format';
import { cn } from '@commerceworker/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Empty, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { FormSheet } from '~/components/form-sheet';
import { type Tone, ToneBadge } from '~/components/status';
import { humanize } from '~/lib/format';
import { useChange } from '~/lib/use-change';

const COMPANY_TONE: Record<CompanyStatus, Tone> = {
  pending: 'wait',
  active: 'ok',
  suspended: 'bad',
  rejected: 'idle',
  closed: 'idle',
};

const MEMBER_TONE: Record<MemberStatus, Tone> = {
  invited: 'wait',
  active: 'ok',
  inactive: 'idle',
  removed: 'idle',
};

/** What a move is called on its button. */
const COMPANY_MOVE: Record<string, string> = {
  'pending>active': 'Approve',
  'pending>rejected': 'Reject',
  'active>suspended': 'Suspend',
  'suspended>active': 'Reinstate',
  'active>closed': 'Close',
  'suspended>closed': 'Close',
};

const MEMBER_MOVE: Record<string, string> = {
  'invited>active': 'Activate',
  'active>inactive': 'Pause',
  'inactive>active': 'Resume',
};

export type CompanyData = {
  company: {
    id: string;
    name: string;
    status: CompanyStatus;
    legalName: string;
    taxId: string | null;
    parentCompanyId: string | null;
  };
  parent: { id: string; name: string } | null;
  teams: { id: string; parentId: string | null; name: string; path: string }[];
  members: {
    members: {
      id: string;
      name: string;
      email: string;
      role: CompanyRole;
      teamId: string | null;
      status: MemberStatus;
      orderLimit: number | null;
    }[];
    total: number;
    cursor: string | null;
  } | null;
  memberFilter: { status: MemberStatus | null; role: CompanyRole | null };
};

type Team = CompanyData['teams'][number];
type Member = NonNullable<CompanyData['members']>['members'][number];

/** The company's status, its details and the moves its lifecycle allows. */
export function CompanySection({ data, canOperate }: { data: CompanyData; canOperate: boolean }) {
  const { company, parent } = data;
  const change = useChange();
  const moves = COMPANY_LIFECYCLE.next(company.status);
  return (
    <Section
      id="company"
      title="Company"
      description="Orders from a company that isn’t active are declined."
      actions={
        canOperate && moves.length ? (
          <div className="flex flex-wrap gap-2">
            {moves.map((to) => (
              <Button
                key={to}
                variant={to === 'closed' || to === 'rejected' ? 'outline' : 'default'}
                size="sm"
                disabled={change.busy}
                onClick={() =>
                  void change.run('set_company_status', { companyId: company.id, status: to })
                }
              >
                {COMPANY_MOVE[`${company.status}>${to}`] ?? humanize(to)}
              </Button>
            ))}
          </div>
        ) : null
      }
    >
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-muted-foreground text-xs">Status</dt>
          <dd className="mt-1">
            <ToneBadge
              tone={COMPANY_TONE[company.status]}
              label={COMPANY_STATUS_LABELS[company.status]}
            />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs">Legal name</dt>
          <dd className="mt-1 break-words">{company.legalName}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs">Tax id</dt>
          <dd className="mt-1 break-words">
            {company.taxId ?? <span className="text-muted-foreground">None on file</span>}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground text-xs">Parent company</dt>
          <dd className="mt-1 break-words">
            {parent ? (
              <Link to={`/customers/${parent.id}`} className="text-link hover:underline">
                {parent.name}
              </Link>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </dd>
        </div>
      </dl>
      {change.error ? (
        <p role="alert" className="mt-3 text-bad text-sm">
          {change.error}
        </p>
      ) : null}
    </Section>
  );
}

/** Whether a field reads as a number the form may send: empty is none. */
const limitOf = (raw: FormDataEntryValue | null) => {
  const text = String(raw ?? '').trim();
  return text === '' ? null : Number(text);
};

/** A member's fields, for adding one and for changing one. */
function MemberForm({
  teams,
  member,
  busy,
  error,
  onSubmit,
}: {
  teams: Team[];
  member?: Member;
  busy: boolean;
  error: string | null;
  onSubmit: (f: FormData) => void;
}) {
  const id = member?.id ?? 'new';
  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
    >
      <FieldGroup className="gap-5">
        <Field className="gap-2">
          <FieldLabel htmlFor={`member-name-${id}`}>Name</FieldLabel>
          <Input
            id={`member-name-${id}`}
            name="name"
            required
            maxLength={120}
            defaultValue={member?.name}
          />
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`member-email-${id}`}>Work email</FieldLabel>
          <Input
            id={`member-email-${id}`}
            name="email"
            type="email"
            required
            maxLength={254}
            autoCapitalize="none"
            autoCorrect="off"
            defaultValue={member?.email}
            readOnly={!!member}
            aria-describedby={member ? `member-email-hint-${id}` : undefined}
          />
          {member ? (
            <FieldDescription id={`member-email-hint-${id}`}>
              A member is known by their email: add a new member to change it.
            </FieldDescription>
          ) : null}
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`member-role-${id}`}>Role</FieldLabel>
          <NativeSelect
            id={`member-role-${id}`}
            name="role"
            defaultValue={member?.role ?? 'buyer'}
            wrapperClassName="w-full"
          >
            {COMPANY_ROLES.map((r) => (
              <NativeSelectOption key={r} value={r}>
                {COMPANY_ROLE_LABELS[r]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`member-team-${id}`}>Team</FieldLabel>
          <NativeSelect
            id={`member-team-${id}`}
            name="teamId"
            defaultValue={member?.teamId ?? ''}
            wrapperClassName="w-full"
          >
            <NativeSelectOption value="">No team</NativeSelectOption>
            {teams.map((t) => (
              <NativeSelectOption key={t.id} value={t.id}>
                {'– '.repeat(teamDepth(t.path) - 1)}
                {t.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`member-limit-${id}`}>Order limit (optional)</FieldLabel>
          <Input
            id={`member-limit-${id}`}
            name="orderLimit"
            inputMode="decimal"
            pattern="[0-9]*\.?[0-9]*"
            defaultValue={member?.orderLimit ?? ''}
            aria-describedby={`member-limit-hint-${id}`}
          />
          <FieldDescription id={`member-limit-hint-${id}`}>
            The most one order of theirs may total, in the base currency. Order Flows can read it as
            buyer.orderLimit.
          </FieldDescription>
        </Field>
        {member ? null : (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="active" className="size-4" /> Active now (otherwise
            invited)
          </label>
        )}
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            {member ? 'Save member' : 'Add member'}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

/** The company's members: a page, filtered by status, with the moves each may make. */
export function MembersSection({ data, canOperate }: { data: CompanyData; canOperate: boolean }) {
  const { company, teams, members, memberFilter } = data;
  const change = useChange();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const closed = company.status === 'closed' || company.status === 'rejected';

  const put = async (m: Pick<Member, 'name' | 'email'> & Record<string, unknown>) =>
    change.run('put_company_members', { companyId: company.id, members: [m] });
  const fromForm = (f: FormData, edit?: Member) => ({
    name: String(f.get('name') ?? ''),
    email: String(f.get('email') ?? ''),
    role: String(f.get('role') ?? 'buyer'),
    teamId: String(f.get('teamId') ?? '') || null,
    orderLimit: limitOf(f.get('orderLimit')),
    ...(edit ? {} : { status: f.get('active') ? 'active' : 'invited' }),
  });

  const filterLink = (status: MemberStatus | null) => {
    const p = new URLSearchParams();
    if (status) p.set('member-status', status);
    const s = p.toString();
    return `${s ? `?${s}` : '?'}#members`;
  };
  const after = (cursor: string | null) => {
    const p = new URLSearchParams();
    if (memberFilter.status) p.set('member-status', memberFilter.status);
    if (cursor) p.set('members-after', cursor);
    return `?${p.toString()}#members`;
  };

  return (
    <Section
      id="members"
      title="Members"
      description="The people who buy, approve and administer for this company. Only an active member can be the buyer on an order."
      flush
      actions={
        canOperate && !closed ? (
          <FormSheet
            open={adding}
            onOpenChange={(o) => {
              setAdding(o);
              change.clearError();
            }}
            label="Add member"
            title="Add a member"
            description="They can be the buyer on an order once they are active."
          >
            <MemberForm
              teams={teams}
              busy={change.busy}
              error={change.error}
              onSubmit={async (f) => {
                if (await put(fromForm(f))) setAdding(false);
              }}
            />
          </FormSheet>
        ) : null
      }
    >
      {members ? (
        <>
          <nav
            aria-label="Filter members by status"
            className="flex flex-wrap gap-1 px-4 py-2 text-sm"
          >
            {[null, ...MEMBER_LIFECYCLE.states].map((s) => (
              <Link
                key={s ?? 'all'}
                to={filterLink(s)}
                aria-current={memberFilter.status === s ? 'true' : undefined}
                className={cn(
                  'hit-area rounded-full px-3 py-1 hover:bg-muted',
                  memberFilter.status === s && 'bg-muted font-medium',
                )}
              >
                {s ? MEMBER_STATUS_LABELS[s] : 'All'}
              </Link>
            ))}
          </nav>
          {members.members.length ? (
            <Table stack="cards" caption="Company members">
              <TableHead>
                <Tr>
                  <Th>Member</Th>
                  <Th>Role</Th>
                  <Th>Team</Th>
                  <Th>Status</Th>
                  <Th numeric>Order limit</Th>
                  <Th className="w-0">
                    <span className="sr-only">Actions</span>
                  </Th>
                </Tr>
              </TableHead>
              <TableBody>
                {members.members.map((m) => (
                  <Tr key={m.id} className={cn(m.status === 'removed' && 'text-muted-foreground')}>
                    <Td>
                      {m.name}
                      <div className="break-all text-muted-foreground text-xs">{m.email}</div>
                    </Td>
                    <Td label="Role">{COMPANY_ROLE_LABELS[m.role]}</Td>
                    <Td label="Team">
                      {m.teamId ? (
                        (teamName.get(m.teamId) ?? m.teamId)
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </Td>
                    <Td label="Status">
                      <ToneBadge
                        tone={MEMBER_TONE[m.status]}
                        label={MEMBER_STATUS_LABELS[m.status]}
                      />
                    </Td>
                    <Td numeric label="Order limit">
                      {m.orderLimit === null ? (
                        <span className="text-muted-foreground">None</span>
                      ) : (
                        money(m.orderLimit)
                      )}
                    </Td>
                    <Td className="max-md:-ml-3 max-md:basis-full">
                      {canOperate && m.status !== 'removed' && !closed ? (
                        <div className="flex flex-wrap gap-1">
                          {MEMBER_LIFECYCLE.next(m.status)
                            .filter((to) => to !== 'removed')
                            .map((to) => (
                              <Button
                                key={to}
                                variant="ghost"
                                size="sm"
                                disabled={change.busy}
                                aria-label={`${MEMBER_MOVE[`${m.status}>${to}`]} ${m.name}`}
                                onClick={() =>
                                  void put({ name: m.name, email: m.email, status: to })
                                }
                              >
                                {MEMBER_MOVE[`${m.status}>${to}`]}
                              </Button>
                            ))}
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={change.busy}
                            aria-label={`Edit ${m.name}`}
                            onClick={() => {
                              change.clearError();
                              setEditing(m);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={change.busy}
                            aria-label={`Remove ${m.name}`}
                            onClick={() =>
                              void change.run('remove_company_member', {
                                companyId: company.id,
                                memberId: m.id,
                              })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              {memberFilter.status
                ? `No ${MEMBER_STATUS_LABELS[memberFilter.status].toLowerCase()} members.`
                : 'No members yet. Add the people who place orders for this company.'}
            </Empty>
          )}
          <nav
            aria-label="Members pages"
            className="flex items-center gap-4 border-t py-2 pr-4 pl-4 text-xs"
          >
            <span className="text-muted-foreground tabular">{count(members.total)} in all</span>
            <span className="ml-auto flex gap-4">
              {members.cursor ? (
                <Link to={after(members.cursor)} className="hit-area text-link hover:underline">
                  Next page
                </Link>
              ) : null}
            </span>
          </nav>
        </>
      ) : (
        <Empty>Members are shown to operators and above.</Empty>
      )}
      {change.error && !adding && !editing ? (
        <p role="alert" className="px-4 py-2 text-bad text-sm">
          {change.error}
        </p>
      ) : null}
      <FormSheet
        bare
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
          change.clearError();
        }}
        label="Edit member"
        title={editing ? `Edit ${editing.name}` : 'Edit member'}
      >
        {editing ? (
          <MemberForm
            key={editing.id}
            teams={teams}
            member={editing}
            busy={change.busy}
            error={change.error}
            onSubmit={async (f) => {
              if (await put(fromForm(f, editing))) setEditing(null);
            }}
          />
        ) : null}
      </FormSheet>
    </Section>
  );
}

/** A team's name and where it sits, for adding one and for renaming or moving one. */
function TeamForm({
  teams,
  team,
  busy,
  error,
  onSubmit,
}: {
  teams: Team[];
  team?: Team;
  busy: boolean;
  error: string | null;
  onSubmit: (f: FormData) => void;
}) {
  const id = team?.id ?? 'new';
  // Not under itself, nor anything beneath it.
  const options = teams.filter((t) => !team || !t.path.startsWith(team.path));
  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
    >
      <FieldGroup className="gap-5">
        <Field className="gap-2">
          <FieldLabel htmlFor={`team-name-${id}`}>Team name</FieldLabel>
          <Input
            id={`team-name-${id}`}
            name="name"
            required
            maxLength={80}
            defaultValue={team?.name}
          />
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`team-parent-${id}`}>Sits under</FieldLabel>
          <NativeSelect
            id={`team-parent-${id}`}
            name="parentTeamId"
            defaultValue={team?.parentId ?? ''}
            wrapperClassName="w-full"
          >
            <NativeSelectOption value="">The top of the company</NativeSelectOption>
            {options.map((t) => (
              <NativeSelectOption key={t.id} value={t.id}>
                {'– '.repeat(teamDepth(t.path) - 1)}
                {t.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            {team ? 'Save team' : 'Add team'}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

/** The company's teams as a tree. */
export function TeamsSection({ data, canOperate }: { data: CompanyData; canOperate: boolean }) {
  const { company, teams } = data;
  const change = useChange();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Team | null>(null);
  const closed = company.status === 'closed' || company.status === 'rejected';
  const save = async (f: FormData, team?: Team) =>
    change.run('put_company_team', {
      companyId: company.id,
      ...(team ? { teamId: team.id } : {}),
      name: String(f.get('name') ?? ''),
      parentTeamId: String(f.get('parentTeamId') ?? '') || null,
    });
  return (
    <Section
      id="teams"
      title="Teams"
      description="A company’s teams nest, and a member belongs to one. Order Flows can read a buyer’s team as buyer.team."
      actions={
        canOperate && !closed ? (
          <FormSheet
            open={adding}
            onOpenChange={(o) => {
              setAdding(o);
              change.clearError();
            }}
            label="Add team"
            title="Add a team"
          >
            <TeamForm
              teams={teams}
              busy={change.busy}
              error={change.error}
              onSubmit={async (f) => {
                if (await save(f)) setAdding(false);
              }}
            />
          </FormSheet>
        ) : null
      }
    >
      {teams.length ? (
        <ul className="-mx-2 flex flex-col gap-0.5" aria-label="Company teams">
          {teams.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-2 rounded-2xl px-2 py-1 text-sm hover:bg-muted/60"
              style={{ paddingLeft: `${0.5 + (teamDepth(t.path) - 1) * 1.25}rem` }}
            >
              <span className="min-w-0 truncate">{t.name}</span>
              {canOperate && !closed ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Rename or move ${t.name}`}
                  onClick={() => {
                    change.clearError();
                    setEditing(t);
                  }}
                >
                  Edit
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No teams. Add one to group the company’s members.</Empty>
      )}
      {change.error && !adding && !editing ? (
        <p role="alert" className="mt-2 text-bad text-sm">
          {change.error}
        </p>
      ) : null}
      <FormSheet
        bare
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
          change.clearError();
        }}
        label="Edit team"
        title={editing ? `Edit ${editing.name}` : 'Edit team'}
      >
        {editing ? (
          <TeamForm
            key={editing.id}
            teams={teams}
            team={editing}
            busy={change.busy}
            error={change.error}
            onSubmit={async (f) => {
              if (await save(f, editing)) setEditing(null);
            }}
          />
        ) : null}
      </FormSheet>
    </Section>
  );
}

const TERMS = ['due_on_receipt', 'net_15', 'net_30', 'net_60'] as const;

/** The customer account fields, for a new customer and for changing one. */
function CustomerForm({
  customer,
  busy,
  error,
  onSubmit,
}: {
  customer?: { name: string; email: string; kind: string; tier: string; terms: string };
  busy: boolean;
  error: string | null;
  onSubmit: (f: FormData) => void;
}) {
  const [kind, setKind] = useState(customer?.kind ?? 'business');
  const id = customer ? 'edit' : 'new';
  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
    >
      <FieldGroup className="gap-5">
        <Field className="gap-2">
          <FieldLabel htmlFor={`customer-name-${id}`}>Name</FieldLabel>
          <Input
            id={`customer-name-${id}`}
            name="name"
            required
            maxLength={120}
            defaultValue={customer?.name}
          />
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`customer-email-${id}`}>Email</FieldLabel>
          <Input
            id={`customer-email-${id}`}
            name="email"
            type="email"
            required
            maxLength={254}
            autoCapitalize="none"
            autoCorrect="off"
            defaultValue={customer?.email}
          />
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`customer-kind-${id}`}>Kind</FieldLabel>
          <NativeSelect
            id={`customer-kind-${id}`}
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            wrapperClassName="w-full"
          >
            {CUSTOMER_KINDS.map((k) => (
              <NativeSelectOption key={k} value={k}>
                {humanize(k)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`customer-tier-${id}`}>Pricing tier</FieldLabel>
          <Input
            id={`customer-tier-${id}`}
            name="tier"
            required
            maxLength={32}
            pattern="[a-z][a-z0-9_\-]*"
            autoCapitalize="none"
            autoCorrect="off"
            defaultValue={customer?.tier ?? 'standard'}
            aria-describedby={`customer-tier-hint-${id}`}
          />
          <FieldDescription id={`customer-tier-hint-${id}`}>
            Lower case, like standard or gold. Price rules and promotions can match it.
          </FieldDescription>
        </Field>
        <Field className="gap-2">
          <FieldLabel htmlFor={`customer-terms-${id}`}>Payment terms</FieldLabel>
          <NativeSelect
            id={`customer-terms-${id}`}
            name="terms"
            defaultValue={customer?.terms ?? 'net_30'}
            wrapperClassName="w-full"
          >
            {TERMS.map((t) => (
              <NativeSelectOption key={t} value={t}>
                {humanize(t)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        {customer || kind !== 'business' ? null : (
          <>
            <Field className="gap-2">
              <FieldLabel htmlFor="customer-legal-new">Legal name (optional)</FieldLabel>
              <Input id="customer-legal-new" name="legalName" maxLength={200} />
            </Field>
            <Field className="gap-2">
              <FieldLabel htmlFor="customer-taxid-new">Tax id (optional)</FieldLabel>
              <Input
                id="customer-taxid-new"
                name="taxId"
                maxLength={64}
                autoCapitalize="characters"
                autoCorrect="off"
              />
            </Field>
          </>
        )}
        {error ? <FieldError>{error}</FieldError> : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            {customer ? 'Save customer' : 'Add customer'}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

/** What a customer form sent: only the fields set, the company's details when it makes one. */
function customerFields(f: FormData) {
  const text = (k: string) => String(f.get(k) ?? '').trim();
  return {
    name: text('name'),
    email: text('email'),
    kind: text('kind'),
    tier: text('tier'),
    terms: text('terms'),
  };
}

/** A new customer: a business one gets its company, active at once. Opens the customer's page. */
export function NewCustomer({ navigate }: { navigate: (to: string) => void }) {
  const change = useChange();
  const [open, setOpen] = useState(false);
  return (
    <FormSheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        change.clearError();
      }}
      label="New customer"
      title="Add a customer"
      description="A business customer also gets its company. It starts with no credit limit."
    >
      <CustomerForm
        busy={change.busy}
        error={change.error}
        onSubmit={async (f) => {
          const legalName = String(f.get('legalName') ?? '').trim();
          const taxId = String(f.get('taxId') ?? '').trim();
          const fields = customerFields(f);
          const out = (await change.run('create_customer', {
            ...fields,
            ...(fields.kind === 'business' && (legalName || taxId)
              ? { company: { ...(legalName ? { legalName } : {}), ...(taxId ? { taxId } : {}) } }
              : {}),
          })) as { href?: string } | null;
          if (out) {
            setOpen(false);
            if (out.href) navigate(out.href);
          }
        }}
      />
    </FormSheet>
  );
}

/** Changes the customer's name, email, kind, tier and terms (never the credit limit). */
export function EditCustomer({
  customer,
}: {
  customer: { id: string; name: string; email: string; kind: string; tier: string; terms: string };
}) {
  const change = useChange();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <FormSheet
        bare
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          change.clearError();
        }}
        label="Edit customer"
        title="Edit customer"
        description="The credit limit isn’t changed here."
      >
        <CustomerForm
          customer={customer}
          busy={change.busy}
          error={change.error}
          onSubmit={async (f) => {
            if (
              await change.run('update_customer', { customerId: customer.id, ...customerFields(f) })
            )
              setOpen(false);
          }}
        />
      </FormSheet>
    </>
  );
}
