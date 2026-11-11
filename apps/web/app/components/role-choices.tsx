import { ROLE_LABELS, type Role } from '@commerceworker/core';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@commerceworker/ui/field';
import type { GRANTABLE_ROLES } from '~/lib/oauth.server';

/** What an app may be granted (`GRANTABLE_ROLES`). Admin isn't offered. */
export const ROLE_SCOPE: Partial<Record<Role, string>> = {
  viewer: 'Read orders, flows, approvals and stock',
  approver: 'Also approve or reject approvals',
  operator: 'Also deliver events, cancel orders, publish flows and run the stock review',
} satisfies Record<(typeof GRANTABLE_ROLES)[number], string>;
export const grantable = (r: Role) => r in ROLE_SCOPE;

/**
 * The role a person gives a connected app, as the consent page and the device page both ask it:
 * the roles they may give, what each lets the app do, and what the app's access follows.
 */
export function RoleChoices({
  roles,
  who,
  channel,
  onChoose,
  checked = roles[0],
}: {
  roles: Role[];
  who: string;
  channel: string;
  onChoose?: (role: Role) => void;
  checked?: Role | undefined;
}) {
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label" className="mb-1 font-normal">
        It will act as <span className="font-medium">{who}</span>, with the role
      </FieldLegend>
      {roles.map((r) => (
        <FieldLabel
          key={r}
          className="cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-secondary"
        >
          <Field orientation="horizontal" className="items-start gap-2.5 p-3!">
            <input
              type="radio"
              name="role"
              value={r}
              defaultChecked={r === checked}
              onChange={() => onChoose?.(r)}
              className="mt-0.5"
            />
            <FieldContent>
              <FieldTitle>{ROLE_LABELS[r]}</FieldTitle>
              <FieldDescription className="text-xs">{ROLE_SCOPE[r]}</FieldDescription>
            </FieldContent>
          </Field>
        </FieldLabel>
      ))}
      <FieldDescription className="mt-1 text-xs">
        Orders show what it does as “{who} via {channel}”. It keeps access until you disconnect it
        on your Account page, and never more than your own role: lower your role, and the app’s
        drops with it.
      </FieldDescription>
    </FieldSet>
  );
}
