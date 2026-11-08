/**
 * Settings → Access → Space access: who can work in THIS space and with what role. People here
 * are the deployment's own accounts (People and sign-in, /team), matched by email; adding someone
 * here gives them this space, not a deployment account. Long-lived API keys are listed with their
 * role too. Changing a role
 * asks in place (InlineConfirm), and removing someone in a modal; the space's last administrator can't be demoted, disabled,
 * removed or revoked, and the page says so where the action would be rather than failing after.
 */

import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import {
  Catalog,
  CatalogEmpty,
  CatalogFigure,
  CatalogRow,
  CatalogTile,
  ListSearch,
  ListToolbar,
} from '@commerceworker/ui/catalog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '@commerceworker/ui/native-select';
import { Segmented, SegmentedItem } from '@commerceworker/ui/segmented';
import { Switch } from '@commerceworker/ui/switch';
import { KeyRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { ConfirmDialog } from '~/cms/components/ConfirmDialog';
import { ConfirmButton, InlineConfirm } from '~/cms/components/InlineConfirm';
import { Empty, Section } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { initials } from '~/lib/initials';
import { keyKindApi, keyKindLabel } from '../lib/key-kinds';
import {
  apiErrorMessage,
  type ManagementClient,
  type RolePresetSummary,
  type RoleSummary,
  type TeamKey,
  type TeamPerson,
  type TeamRole,
  type TeamSummary,
} from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** The message shown wherever an action would take away the last administrator. */
export const LAST_ADMIN_MESSAGE =
  'The last administrator can’t be demoted, disabled, removed or revoked. Make someone else an administrator first.';

const ISSUANCE: Record<TeamKey['issuance'], string> = {
  key: 'API key',
  pat: 'Personal token',
  oauth: 'Connected app',
  setup: 'Setup administrator',
};

interface RoleOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly admin: boolean;
}

/** Presets first, in order, then the space's custom roles. */
function roleOptions(presets: readonly RolePresetSummary[], roles: readonly RoleSummary[]) {
  const preset: RoleOption[] = presets.map((p) => ({
    id: p.roleId,
    name: p.name,
    description: p.description,
    admin: p.scopes.includes('space:admin'),
  }));
  const custom: RoleOption[] = roles
    .filter((r) => !r.preset)
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      admin: r.scopes.includes('space:admin'),
    }));
  return { preset, custom, all: [...preset, ...custom] };
}

export function Team(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const team = useScopedQuery(['team'], () => client.getTeam());
  const presets = useScopedQuery(['role-presets'], () => client.listRolePresets()).data ?? [];
  const roles = useScopedQuery(['roles'], () => client.listRoles()).data ?? [];
  const options = useMemo(() => roleOptions(presets, roles), [presets, roles]);
  const data = team.data;

  const refresh = () => invalidate(['team']);
  // For a confirm that says a refusal itself.
  const attempt = async (fn: () => Promise<unknown>, done: string) => {
    await fn();
    await refresh();
    toast.success(done);
  };
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await attempt(fn, done);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      <People client={client} team={data} options={options} act={act} attempt={attempt} />
      <Keys team={data} options={options} act={act} client={client} />
      {data?.sso ? <SignIn client={client} team={data} act={act} /> : null}
    </div>
  );
}

type Act = (fn: () => Promise<unknown>, done: string) => Promise<void>;
type Options = ReturnType<typeof roleOptions>;

/** Which people the list shows. */
type PersonFilter = 'all' | 'active' | 'disabled';

/** The last admin: one administrator left, and this is it. */
const isLastAdmin = (team: TeamSummary | undefined, admin: boolean) =>
  !!team && admin && team.adminCount <= 1;

function People(props: {
  client: ManagementClient;
  team: TeamSummary | undefined;
  options: Options;
  act: Act;
  attempt: Act;
}) {
  const { client, team, options, act } = props;
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('viewer');
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<PersonFilter>('all');
  // The api lists everyone in the space, so filtering here can't miss anyone.
  const people = team?.people ?? [];
  const needle = query.trim().toLowerCase();
  const shown = people.filter(
    (p) =>
      (show === 'all' || p.disabled === (show === 'disabled')) &&
      (!needle ||
        `${p.name ?? ''} ${p.email} ${p.role?.name ?? ''}`.toLowerCase().includes(needle)),
  );

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    await act(
      () =>
        client.addMember({
          email: email.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          role,
        }),
      `${email.trim()} added`,
    );
    setEmail('');
    setName('');
  };

  return (
    <Section
      title="People in this space"
      description={
        <>
          Who can work in this space, and their role here. People sign in with their deployment
          account (managed under{' '}
          <Link to="/team" className="text-link underline">
            People and sign-in
          </Link>
          ); their email links them to this space.
        </>
      }
      flush
    >
      <form className="flex flex-wrap items-end gap-2 px-5 py-4" onSubmit={add}>
        <div className="space-y-1.5">
          <Label htmlFor="team-email">Email</Label>
          <Input
            id="team-email"
            type="email"
            className="w-64"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="team-name">
            Name <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="team-name"
            className="w-48"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="team-role">Role</Label>
          <NativeSelect id="team-role" value={role} onChange={(e) => setRole(e.target.value)}>
            {['viewer', 'approver', 'editor', 'manager', 'admin'].map((p, i) => (
              <NativeSelectOption key={p} value={p}>
                {options.preset[i]?.name ?? p}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit">Add person</Button>
      </form>
      {/* No one at all is the news, so it is `Empty` in place of the list. */}
      {!team ? null : people.length === 0 ? (
        <Empty>No one on the team yet. Add someone by email above.</Empty>
      ) : (
        <>
          <ListToolbar className="border-t" summary={`${shown.length} shown`}>
            <ListSearch
              label="Search people"
              placeholder="Search names, emails and roles"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery('')}
            />
            <Segmented
              aria-label="Show people"
              value={show}
              onValueChange={(v) => setShow(v as PersonFilter)}
            >
              <SegmentedItem value="all">All</SegmentedItem>
              <SegmentedItem value="active">Active</SegmentedItem>
              <SegmentedItem value="disabled">Disabled</SegmentedItem>
            </Segmented>
          </ListToolbar>
          {shown.length === 0 ? (
            <CatalogEmpty
              onClear={() => {
                setQuery('');
                setShow('all');
              }}
            >
              No people match.
            </CatalogEmpty>
          ) : (
            <Catalog aria-label="People" className="pt-0">
              {shown.map((p) => (
                <PersonRow
                  key={p.id}
                  person={p}
                  team={team}
                  options={options}
                  act={act}
                  attempt={props.attempt}
                  client={client}
                />
              ))}
            </Catalog>
          )}
        </>
      )}
    </Section>
  );
}

function PersonRow(props: {
  person: TeamPerson;
  team: TeamSummary | undefined;
  options: Options;
  act: Act;
  attempt: Act;
  client: ManagementClient;
}) {
  const { person: p, team, options, act, client } = props;
  // People are administrators only where they can sign in (SSO).
  const last = isLastAdmin(team, p.admin && !!team?.sso && !p.disabled);
  const who = p.name ? `${p.name} (${p.email})` : p.email;
  const role = useRoleChange({
    subject: who,
    current: p.role,
    options,
    lastAdmin: last,
    onChange: (roleId, roleName) =>
      act(
        () => client.updateMember(p.id, { role: roleId ?? undefined }),
        `${who} is now ${roleName}`,
      ),
  });
  return (
    <>
      <CatalogRow
        // Turning someone off asks in place: the question wraps in the row, not past its edge.
        className="[&>*]:max-w-full"
        media={<CatalogTile aria-hidden="true">{initials(p.name, p.email)}</CatalogTile>}
        title={p.name ?? p.email}
        meta={
          p.name || !p.linked ? (
            <span className="flex flex-wrap gap-x-2">
              {p.name ? <span>{p.email}</span> : null}
              {!p.linked ? <span>Hasn’t signed in yet</span> : null}
            </span>
          ) : undefined
        }
        aside={
          <>
            {/* Only the exception is stamped: a row of "Active" on everyone says nothing. */}
            {p.disabled ? (
              <StatusBadge status="disabled" />
            ) : (
              <span className="sr-only">Active</span>
            )}
            {role.select}
          </>
        }
        actions={
          last ? (
            <span className="text-muted-foreground text-xs">Last administrator</span>
          ) : (
            <span className="flex flex-wrap items-center justify-end gap-1">
              <ConfirmButton
                message={p.disabled ? `Let ${who} sign in again?` : `Turn off ${who}’s access?`}
                note={
                  p.disabled ? undefined : 'Their SSO sign-in is refused until you turn it back on.'
                }
                confirmLabel={p.disabled ? 'Turn on' : 'Turn off'}
                tone={p.disabled ? 'default' : 'destructive'}
                onConfirm={() =>
                  void act(
                    () => client.updateMember(p.id, { disabled: !p.disabled }),
                    p.disabled ? `${who} can sign in` : `${who}’s access is off`,
                  )
                }
              >
                {(ask) => (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={`${p.disabled ? 'Turn on' : 'Turn off'} ${who}`}
                    onClick={ask}
                  >
                    {p.disabled ? 'Turn on' : 'Turn off'}
                  </Button>
                )}
              </ConfirmButton>
              <ConfirmDialog
                message={`Remove ${who} from the team?`}
                note="They lose their role here; adding them again starts over."
                confirmLabel="Remove"
                onConfirm={() => props.attempt(() => client.removeMember(p.id), `${who} removed`)}
              >
                {(ask) => (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={`Remove ${who}`}
                    onClick={ask}
                  >
                    Remove
                  </Button>
                )}
              </ConfirmDialog>
            </span>
          )
        }
      />
      {role.confirm ? <li>{role.confirm}</li> : null}
    </>
  );
}

function Keys(props: {
  client: ManagementClient;
  team: TeamSummary | undefined;
  options: Options;
  act: Act;
}) {
  const { client, team, options, act } = props;
  const [query, setQuery] = useState('');
  // The api lists every long-lived key, so filtering here can't miss one.
  const keys = team?.keys ?? [];
  const needle = query.trim().toLowerCase();
  const shown = keys.filter(
    (k) =>
      !needle ||
      `${k.name ?? ''} ${keyKindLabel(k.kind)} ${ISSUANCE[k.issuance]} ${k.subject ?? ''} ${k.role?.name ?? ''}`
        .toLowerCase()
        .includes(needle),
  );
  return (
    <Section
      title="API keys"
      description="Long-lived keys and the role each acts with. Mint and revoke them under API keys."
      flush
    >
      {!team ? null : keys.length === 0 ? (
        <Empty>No API keys.</Empty>
      ) : (
        <>
          <ListToolbar summary={`${shown.length} shown`}>
            <ListSearch
              label="Search API keys"
              placeholder="Search names, roles and owners"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery('')}
            />
          </ListToolbar>
          {shown.length === 0 ? (
            <CatalogEmpty onClear={() => setQuery('')}>No API keys match “{query}”.</CatalogEmpty>
          ) : (
            <Catalog aria-label="API keys and their roles" className="pt-0">
              {shown.map((k) => (
                <KeyRow
                  key={k.id}
                  teamKey={k}
                  team={team}
                  options={options}
                  act={act}
                  client={client}
                />
              ))}
            </Catalog>
          )}
        </>
      )}
    </Section>
  );
}

function KeyRow(props: {
  teamKey: TeamKey;
  team: TeamSummary;
  options: Options;
  act: Act;
  client: ManagementClient;
}) {
  const { teamKey: k, team, options, act, client } = props;
  const label = k.name ?? `${keyKindLabel(k.kind)} key`;
  const role = useRoleChange({
    subject: label,
    current: k.role,
    options,
    lastAdmin: isLastAdmin(team, k.admin),
    allowNone: true,
    onChange: (roleId, roleName) =>
      act(() => client.setApiKeyRole(k.id, roleId), `${label} is now ${roleName}`),
  });
  return (
    <>
      <CatalogRow
        media={
          <CatalogTile>
            <KeyRound aria-hidden="true" />
          </CatalogTile>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {label}
            <Badge variant="outline" title={keyKindApi(k.kind)}>
              {keyKindLabel(k.kind)}
            </Badge>
          </span>
        }
        meta={
          <span className="flex flex-wrap gap-x-2">
            <span>{ISSUANCE[k.issuance]}</span>
            {k.subject ? <span>{k.subject}</span> : null}
          </span>
        }
        aside={
          <>
            <CatalogFigure label="Last used">
              {k.lastUsedAt ? <Ago at={k.lastUsedAt} /> : 'Never'}
            </CatalogFigure>
            {role.select}
          </>
        }
      />
      {role.confirm ? <li>{role.confirm}</li> : null}
    </>
  );
}

const NONE = '__none__';

/**
 * The role, as a select; picking another asks in place before changing it. On the last
 * administrator, picking a role that isn't an administrator's says why it can't instead. The select
 * sits in the row and the question on its own line under it, too long for the row's narrow side.
 */
function useRoleChange(props: {
  subject: string;
  current: TeamRole | null;
  options: Options;
  lastAdmin: boolean;
  allowNone?: boolean;
  onChange: (roleId: string | null, roleName: string) => Promise<void>;
}) {
  const { subject, current, options, lastAdmin, allowNone, onChange } = props;
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = current?.id ?? NONE;
  const target = pending === NONE ? null : options.all.find((o) => o.id === pending);
  const targetName = pending === NONE ? 'No role (key defaults)' : (target?.name ?? '');
  const blocked = lastAdmin && pending !== null && !target?.admin;

  const select = (
    <NativeSelect
      aria-label={`Role for ${subject}`}
      wrapperClassName="max-w-full"
      value={pending ?? value}
      onChange={(e) => setPending(e.target.value === value ? null : e.target.value)}
      disabled={busy}
    >
      {allowNone ? (
        <NativeSelectOption value={NONE}>No role (key defaults)</NativeSelectOption>
      ) : null}
      {!current && !allowNone ? (
        <NativeSelectOption value={NONE}>No role</NativeSelectOption>
      ) : null}
      <NativeSelectOptGroup label="Presets">
        {options.preset.map((o) => (
          <NativeSelectOption key={o.id} value={o.id}>
            {o.name}
          </NativeSelectOption>
        ))}
      </NativeSelectOptGroup>
      {options.custom.length ? (
        <NativeSelectOptGroup label="Custom roles">
          {options.custom.map((o) => (
            <NativeSelectOption key={o.id} value={o.id}>
              {o.name}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      ) : null}
    </NativeSelect>
  );

  const confirm =
    pending === null ? null : blocked ? (
      <InlineConfirm
        message={`${subject} is the last administrator.`}
        note={LAST_ADMIN_MESSAGE}
        cancelLabel="OK"
        onCancel={() => setPending(null)}
      >
        {null}
      </InlineConfirm>
    ) : (
      <InlineConfirm
        message={`Change ${subject} to ${targetName}?`}
        note={target?.description ?? 'They act with their kind’s default scopes.'}
        onCancel={() => setPending(null)}
      >
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onChange(pending === NONE ? null : pending, targetName);
            } finally {
              setBusy(false);
              setPending(null);
            }
          }}
        >
          Change role
        </Button>
      </InlineConfirm>
    );

  return { select, confirm };
}

function SignIn(props: { client: ManagementClient; team: TeamSummary; act: Act }) {
  const { client, team, act } = props;
  const on = team.settings.ssoOnly;
  return (
    <Section
      title="Sign-in"
      description="With single sign-on required, the administrator token setup created stops working. A setup recovery code turns this off again."
    >
      <div className="flex items-center gap-3">
        <Switch
          id="team-sso-only"
          checked={on}
          onCheckedChange={(next) =>
            void act(
              () => client.setAccessSettings({ ssoOnly: next }),
              next ? 'Single sign-on is required' : 'Single sign-on is no longer required',
            )
          }
        />
        <Label htmlFor="team-sso-only">Require single sign-on for people</Label>
      </div>
    </Section>
  );
}
