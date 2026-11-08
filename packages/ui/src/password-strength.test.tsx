import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PasswordStrength } from './password-strength';

describe('PasswordStrength', () => {
  it('mounts an empty live region before anything is typed', () => {
    // Deliberately not "renders nothing": a role="status" node that enters the DOM
    // in the same tick as its text is commonly never announced, so the region has
    // to exist first and be updated. The bars stay out until there is a score.
    render(<PasswordStrength password="" />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    expect(document.querySelectorAll('[class*="h-1"]').length).toBe(0);
  });

  it('shows Strong for long mixed password', () => {
    render(<PasswordStrength password="abcdEFGH1234" />);
    expect(screen.getByText('Strong')).toBeTruthy();
  });

  it('shows Weak for short simple password', () => {
    render(<PasswordStrength password="abcd" />);
    expect(screen.getByText('Weak')).toBeTruthy();
  });
});
