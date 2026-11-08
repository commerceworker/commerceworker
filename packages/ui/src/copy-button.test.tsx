import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from './copy-button';

afterEach(() => {
  cleanup();
});

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

describe('CopyButton', () => {
  const writeText = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    writeText.mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    });
  });

  it('copies value and shows success toast', async () => {
    render(<CopyButton value="secret-token" showLabel />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('secret-token'));
    expect(toastSuccess).toHaveBeenCalledWith('Copied to clipboard');
  });

  it('toasts error when clipboard rejects', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const onCopyError = vi.fn();
    render(<CopyButton value="x" showLabel onCopyError={onCopyError} />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not copy to clipboard'));
    expect(onCopyError).toHaveBeenCalled();
  });

  it('copies from icon variant without showLabel', async () => {
    render(<CopyButton value="token" />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('token'));
  });

  it('switches the label to Copied after a successful copy', async () => {
    render(<CopyButton value="token" showLabel />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await vi.waitFor(() => expect(screen.getByRole('button').textContent).toContain('Copied'));
  });

  it('does not toast when showToast is false on success', async () => {
    render(<CopyButton value="token" showLabel showToast={false} />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('does not toast when showToast is false on failure', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<CopyButton value="x" showLabel showToast={false} />);
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalled();
  });
});
