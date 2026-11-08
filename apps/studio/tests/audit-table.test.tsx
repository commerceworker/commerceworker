// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditTable, type AuditTableEvent } from '~/components/audit-table';

afterEach(cleanup);

const at = Date.parse('2026-10-01T09:30:00.000Z');
const EVENTS: AuditTableEvent[] = [
  {
    id: 1,
    at,
    action: 'auth.sign_in_failed',
    actor: null,
    target: 'ann@example.com',
    detail: { reason: 'wrong email or password' },
    ip: '203.0.113.9',
  },
  {
    id: 2,
    at: at - 60_000,
    action: 'auth.sign_in',
    actor: 'ann@example.com',
    target: null,
    detail: null,
    ip: '203.0.113.9',
  },
];

describe('the audit table', () => {
  it('leads each row with the event, then who, when and from where', () => {
    render(<AuditTable events={EVENTS} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['What', 'Who', 'When', 'From']);
    const first = screen.getAllByRole('row')[1] as HTMLElement;
    expect(within(first).getAllByRole('cell')[0]?.textContent).toMatch(/Sign-in failed/);
  });

  it('says a refusal in words, in a badge, not by colour alone', () => {
    render(<AuditTable events={EVENTS} />);
    const [refused, ok] = screen.getAllByRole('row').slice(1) as HTMLElement[];
    expect(within(refused as HTMLElement).getByText('Refused')).toBeTruthy();
    expect(within(ok as HTMLElement).queryByText('Refused')).toBeNull();
  });

  it('shows the time itself, with how long ago beside it', () => {
    render(<AuditTable events={EVENTS} />);
    const first = screen.getAllByRole('row')[1] as HTMLElement;
    const times = first.querySelectorAll('time');
    expect(times[0]?.getAttribute('dateTime')).toBe('2026-10-01T09:30:00.000Z');
    expect(times[0]?.textContent).toMatch(/2026/);
    expect(times[1]?.textContent).toMatch(/ago/);
  });
});
