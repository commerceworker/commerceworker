import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  // Vitest `globals` is off here, so RTL never registers its automatic cleanup.
  cleanup();
});

describe('ConfirmDialog', () => {
  it('invokes onConfirm once per confirmation', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfirmDialog
        title="Delete?"
        description="Test confirmation"
        onConfirm={onConfirm}
        open={true}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  it('ignores duplicate confirm clicks while async onConfirm runs', async () => {
    let resolveFn!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveFn = resolve;
        }),
    );
    render(
      <ConfirmDialog
        title="Delete?"
        description="Test confirmation"
        onConfirm={onConfirm}
        open={true}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    resolveFn();
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });

  /**
   * DESIGN.md's third friction tier: an action touching a live tenant is held
   * until the operator types the object's name.
   */
  describe('typed confirmation', () => {
    it('holds the action until the exact string is typed', async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();
      render(
        <ConfirmDialog
          open
          title="Delete tenant?"
          description="The storefront stops serving immediately."
          confirmLabel="Delete"
          requireTypedConfirmation="acme-corp"
          onConfirm={onConfirm}
        />,
      );

      const confirm = screen.getByRole('button', { name: 'Delete' });
      expect(confirm.hasAttribute('disabled')).toBe(true);

      const field = screen.getByLabelText(/type the name acme-corp to confirm/i);
      await user.type(field, 'acme');
      expect(confirm.hasAttribute('disabled')).toBe(true);

      await user.type(field, '-corp');
      expect(confirm.hasAttribute('disabled')).toBe(false);

      await user.click(confirm);
      expect(onConfirm).toHaveBeenCalledOnce();
    });

    it('rejects a near miss', async () => {
      const onConfirm = vi.fn();
      const user = userEvent.setup();
      render(
        <ConfirmDialog
          open
          title="Delete tenant?"
          description="The storefront stops serving immediately."
          confirmLabel="Delete"
          requireTypedConfirmation="acme-corp"
          onConfirm={onConfirm}
        />,
      );

      await user.type(screen.getByLabelText(/type the name acme-corp to confirm/i), 'acme-Corp');
      expect(screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled')).toBe(true);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('names what is being typed when told', () => {
      render(
        <ConfirmDialog
          open
          title="Delete tenant?"
          description="The storefront stops serving immediately."
          requireTypedConfirmation="acme-corp"
          typedConfirmationLabel="tenant slug"
          onConfirm={vi.fn()}
        />,
      );
      expect(screen.getByLabelText(/type the tenant slug acme-corp to confirm/i)).toBeTruthy();
    });
  });
});
