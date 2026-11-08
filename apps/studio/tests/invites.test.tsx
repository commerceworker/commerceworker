// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRoutesStub } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvitesSection } from '~/components/invites';
import type { Invite } from '~/lib/invites';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(cleanup);

const LINK = `https://acme.commerceworker.com/invite/cwi_${'b'.repeat(43)}`;
const invite = (over: Partial<Invite> = {}): Invite => ({
  id: 'inv-1',
  email: 'grace@example.com',
  role: 'member',
  grants: [{ spaceId: 'blog', roleId: 'r1' }],
  status: 'pending',
  expiresAt: '2026-11-08T00:00:00.000Z',
  invitedBy: { kind: 'user', id: 'usr_ada' },
  createdAt: '2026-11-01T00:00:00.000Z',
  sentAt: '2026-11-01T00:00:00.000Z',
  sendCount: 1,
  ...over,
});

/** The Team page's action, as the section's forms reach it: what each intent was sent with. */
function renderSection(invites: Invite[] | null, stepUp: 'password' | null = 'password') {
  const sent: Record<string, string>[] = [];
  const Stub = createRoutesStub([
    {
      path: '/team',
      Component: () => (
        <InvitesSection invites={invites} spaces={[{ id: 'blog', name: 'Blog' }]} stepUp={stepUp} />
      ),
      action: async ({ request }) => {
        const f = Object.fromEntries((await request.formData()).entries()) as Record<
          string,
          string
        >;
        sent.push(f);
        if (f.intent === 'invite' && f.email === 'taken@example.com')
          return { error: 'taken@example.com already has a pending invitation; resend it instead' };
        if (f.intent === 'invite' || f.intent === 'invite-resend')
          return {
            link: {
              email: f.email ?? 'grace@example.com',
              url: LINK,
              expiresAt: '2026-11-08T00:00:00.000Z',
            },
          };
        return { done: 'The invitation for grace@example.com is revoked.' };
      },
    },
  ]);
  render(<Stub initialEntries={['/team']} />);
  return sent;
}

describe('the Team page’s invitations', () => {
  it('lists open invitations with their status in words', () => {
    renderSection([invite(), invite({ id: 'inv-2', email: 'old@example.com', status: 'expired' })]);
    const list = screen.getByRole('list', { name: 'Invitations' });
    expect(within(list).getByText('grace@example.com')).toBeTruthy();
    expect(within(list).getByText('Pending')).toBeTruthy();
    expect(within(list).getByText('Expired')).toBeTruthy();
    expect(within(list).getAllByText('Member')).toHaveLength(2);
    expect(within(list).getAllByText('Blog')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^Send a new link for / })).toBeTruthy();
  });

  it('says so when there are none, or they couldn’t be loaded', () => {
    renderSection([]);
    expect(screen.getByText(/No open invitations/)).toBeTruthy();
    cleanup();
    renderSection(null);
    expect(screen.getByRole('alert').textContent).toMatch(/couldn’t be loaded/);
  });

  it('invites from the dialog and shows the link once, focused, with Copy', async () => {
    const sent = renderSection([]);
    fireEvent.click(screen.getByRole('button', { name: 'Invite a person' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a person' });
    fireEvent.change(within(dialog).getByLabelText('Email'), {
      target: { value: 'grace@example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Space/), { target: { value: 'blog' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(within(dialog).getByText(LINK)).toBeTruthy());
    expect(sent[0]).toMatchObject({
      intent: 'invite',
      email: 'grace@example.com',
      role: 'member',
      space: 'blog',
      spaceRole: 'editor',
    });
    expect(within(dialog).getByRole('button', { name: /copy/i })).toBeTruthy();
    expect(document.activeElement?.textContent).toContain('Invitation link for grace@example.com');
  });

  it('asks who you are before inviting an admin, and shows a refusal in the dialog', async () => {
    renderSection([]);
    fireEvent.click(screen.getByRole('button', { name: 'Invite a person' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText('Your password')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'admin' } });
    expect(within(dialog).getByLabelText('Your password')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'member' } });
    fireEvent.change(within(dialog).getByLabelText('Email'), {
      target: { value: 'taken@example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/resend it instead/);
  });

  it('confirms a revoke in place, and a resend of an admin’s invitation asks for step-up', async () => {
    const sent = renderSection([invite({ role: 'admin' })]);
    fireEvent.click(screen.getByRole('button', { name: /^Resend for / }));
    expect(screen.getByLabelText('Your password')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    fireEvent.click(screen.getByRole('button', { name: /^Revoke for / }));
    expect(screen.getByText(/Revoke the invitation for grace@example.com\?/)).toBeTruthy();
    expect(screen.queryByLabelText('Your password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/revoked/);
    expect(sent.at(-1)).toMatchObject({ intent: 'invite-revoke', id: 'inv-1' });
  });
});

vi.stubGlobal('scrollTo', () => {});
