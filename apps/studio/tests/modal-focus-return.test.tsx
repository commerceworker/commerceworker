// Focus goes back where it came from when an overlay closes, with no DialogTrigger to help Radix.
// Real browsers are in e2e/modal-focus.spec.ts; these pin the choices when the opener can't take it.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTitle,
} from '@commerceworker/ui/alert-dialog';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@commerceworker/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@commerceworker/ui/sheet';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

const focused = (name: string) =>
  waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name })));

function Plain({
  onCloseAutoFocus,
  afterOpen,
}: {
  onCloseAutoFocus?: (e: Event) => void;
  afterOpen?: 'disable' | 'remove';
}) {
  const [open, setOpen] = useState(false);
  const [changed, setChanged] = useState(false);
  return (
    <main>
      <div>
        <button type="button">Neighbour</button>
        {afterOpen === 'remove' && changed ? null : (
          <button
            type="button"
            disabled={afterOpen === 'disable' && changed}
            onClick={() => setOpen(true)}
          >
            Open
          </button>
        )}
      </div>
      <button type="button">Elsewhere</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
          <DialogTitle>Details</DialogTitle>
          <button type="button" onClick={() => setChanged(true)}>
            Change
          </button>
          <DialogClose>Done</DialogClose>
        </DialogContent>
      </Dialog>
    </main>
  );
}

const openDialog = () => {
  const open = screen.getByRole('button', { name: 'Open' });
  open.focus();
  fireEvent.click(open);
  return screen.findByRole('dialog');
};
const close = () => fireEvent.click(screen.getByRole('button', { name: 'Done' }));

describe('closing an overlay opened from state', () => {
  it('goes back to what opened it', async () => {
    render(<Plain />);
    await openDialog();
    close();
    await focused('Open');
  });

  it('goes back to a pressed button that never took focus, as in Safari', async () => {
    render(<Plain />);
    const open = screen.getByRole('button', { name: 'Open' });
    fireEvent.pointerDown(open);
    fireEvent.click(open);
    await screen.findByRole('dialog');
    close();
    await focused('Open');
  });

  it('goes back to the button, not the scroller Safari focused for its press', async () => {
    function InScroller() {
      const [open, setOpen] = useState(false);
      return (
        <main>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling table's wrapper. */}
          <div tabIndex={0} data-testid="scroller">
            <button type="button" onClick={() => setOpen(true)}>
              Open
            </button>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Details</DialogTitle>
              <DialogClose>Done</DialogClose>
            </DialogContent>
          </Dialog>
        </main>
      );
    }
    render(<InScroller />);
    const open = screen.getByRole('button', { name: 'Open' });
    fireEvent.pointerDown(open);
    screen.getByTestId('scroller').focus();
    fireEvent.click(open);
    await screen.findByRole('dialog');
    close();
    await focused('Open');
  });

  it('leaves the choice to onCloseAutoFocus when it takes it', async () => {
    render(
      <Plain
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          screen.getByRole('button', { name: 'Elsewhere' }).focus();
        }}
      />,
    );
    await openDialog();
    close();
    await focused('Elsewhere');
  });

  it('still goes back when onCloseAutoFocus passes', async () => {
    const pass = vi.fn();
    render(<Plain onCloseAutoFocus={pass} />);
    await openDialog();
    close();
    await focused('Open');
    expect(pass).toHaveBeenCalledOnce();
  });

  it('goes to what stands beside an opener that is now disabled', async () => {
    render(<Plain afterOpen="disable" />);
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    close();
    await focused('Neighbour');
  });

  it('goes to what stands beside an opener that has gone', async () => {
    render(<Plain afterOpen="remove" />);
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    close();
    await focused('Neighbour');
  });

  it('looks further up when nothing stands right beside the opener', async () => {
    function Row() {
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      return (
        <main>
          <table>
            <tbody>
              <tr>
                <td>
                  <button type="button">Row title</button>
                </td>
                <td>
                  <button type="button" disabled={busy} onClick={() => setOpen(true)}>
                    Open
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Details</DialogTitle>
              <button type="button" onClick={() => setBusy(true)}>
                Change
              </button>
              <DialogClose>Done</DialogClose>
            </DialogContent>
          </Dialog>
        </main>
      );
    }
    render(<Row />);
    await openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    close();
    await focused('Row title');
  });

  it('forgets a press once the person has pressed elsewhere', async () => {
    function Opened() {
      const [open, setOpen] = useState(false);
      return (
        <main tabIndex={-1}>
          <button type="button">Old press</button>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => setOpen(true)}
            data-testid="key"
          />
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Details</DialogTitle>
              <DialogClose>Done</DialogClose>
            </DialogContent>
          </Dialog>
        </main>
      );
    }
    render(<Opened />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Old press' }));
    fireEvent.pointerDown(document.body);
    // A shortcut, not a press: nothing is focused and nothing was pressed.
    fireEvent.click(screen.getByTestId('key'));
    await screen.findByRole('dialog');
    close();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('main')));
  });

  it('falls back to the page when nothing near is left', async () => {
    function Lone() {
      const [open, setOpen] = useState(true);
      const [gone, setGone] = useState(false);
      return (
        <main tabIndex={-1}>
          {gone ? null : <button type="button">Open</button>}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Details</DialogTitle>
              <button
                type="button"
                onClick={() => {
                  setGone(true);
                  setOpen(false);
                }}
              >
                Done
              </button>
            </DialogContent>
          </Dialog>
        </main>
      );
    }
    const { rerender } = render(<div />);
    rerender(<Lone />);
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('main')));
  });

  it('leaves focus the closing action put somewhere on purpose', async () => {
    function Moves() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <input aria-label="New row" />
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Details</DialogTitle>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setTimeout(() => screen.getByLabelText('New row').focus());
                }}
              >
                Done
              </button>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<Moves />);
    await openDialog();
    close();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('New row')));
  });
});

describe('stacked overlays', () => {
  function Stack({ both }: { both?: boolean }) {
    const [sheet, setSheet] = useState(false);
    const [alert, setAlert] = useState(false);
    return (
      <main>
        <button type="button" onClick={() => setSheet(true)}>
          Open sheet
        </button>
        <Sheet open={sheet} onOpenChange={setSheet}>
          <SheetContent aria-describedby={undefined}>
            <SheetTitle>Asset</SheetTitle>
            <button type="button" onClick={() => setAlert(true)}>
              Delete
            </button>
            <AlertDialog open={alert} onOpenChange={setAlert}>
              <AlertDialogContent aria-describedby={undefined}>
                <AlertDialogTitle>Delete it?</AlertDialogTitle>
                <AlertDialogCancel>Keep</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => both && setSheet(false)}>
                  Confirm
                </AlertDialogAction>
              </AlertDialogContent>
            </AlertDialog>
          </SheetContent>
        </Sheet>
      </main>
    );
  }

  const openBoth = async () => {
    const open = screen.getByRole('button', { name: 'Open sheet' });
    open.focus();
    fireEvent.click(open);
    const del = await screen.findByRole('button', { name: 'Delete' });
    act(() => del.focus());
    fireEvent.click(del);
    await screen.findByRole('alertdialog');
  };

  it('an alert over a sheet goes back into the sheet', async () => {
    render(<Stack />);
    await openBoth();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await focused('Delete');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('an alert that closes the sheet too goes back to what opened the sheet', async () => {
    render(<Stack both />);
    await openBoth();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await focused('Open sheet');
  });
});
