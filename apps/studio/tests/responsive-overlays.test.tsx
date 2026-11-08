// What keeps an overlay usable on a phone: a sheet comes from the bottom there, and a dialog's
// actions stay in reach above an on-screen keyboard. Layout itself is proved in the device tests.
import {
  Dialog,
  DialogContent,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@commerceworker/ui/dialog';
import { keyboardInset } from '@commerceworker/ui/lib/keyboard-inset';
import { Sheet, SheetFooter, SheetHeader, SheetTitle } from '@commerceworker/ui/sheet';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveSheetContent } from '~/cms/components/responsive-sheet';

const matching = (matches: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: matches && query.includes('max-width: 639px'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
});

const sheet = () =>
  render(
    <Sheet open>
      <ResponsiveSheetContent aria-describedby={undefined}>
        <SheetTitle>Details</SheetTitle>
      </ResponsiveSheetContent>
    </Sheet>,
  );

describe('responsive sheet', () => {
  it('comes from the bottom on a phone', () => {
    matching(true);
    sheet();
    expect(screen.getByRole('dialog').getAttribute('data-side')).toBe('bottom');
  });

  it('comes from the side on anything wider', () => {
    matching(false);
    sheet();
    expect(screen.getByRole('dialog').getAttribute('data-side')).toBe('right');
  });
});

describe('sheet body', () => {
  const longSheet = (inside?: ReactNode) => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    matching(false);
    render(
      <Sheet open>
        <ResponsiveSheetContent aria-describedby={undefined}>
          <SheetTitle>Shortcuts</SheetTitle>
          <p>Long text</p>
          {inside}
        </ResponsiveSheetContent>
      </Sheet>,
    );
    return screen.getByRole('dialog').querySelector<HTMLElement>('[data-slot="sheet-body"]');
  };

  it('takes focus itself, named as the sheet is, when it overflows with nothing to tab to', async () => {
    const body = longSheet();
    expect(body?.tabIndex).toBe(0);
    expect(screen.getByRole('region', { name: 'Shortcuts' })).toBe(body);
    await waitFor(() => expect(document.activeElement).toBe(body));
  });

  it('leaves that to what is inside it', () => {
    const body = longSheet(<button type="button">Refresh</button>);
    expect(body?.hasAttribute('tabindex')).toBe(false);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('scrolls the content, with the header, the footer and the way out pinned', () => {
    matching(true);
    render(
      <Sheet open>
        <ResponsiveSheetContent aria-describedby={undefined}>
          <SheetHeader data-testid="head">
            <SheetTitle>Details</SheetTitle>
          </SheetHeader>
          <p>Long content</p>
          <SheetFooter data-testid="foot">
            <button type="button">Save</button>
          </SheetFooter>
        </ResponsiveSheetContent>
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog');
    const body = dialog.querySelector('[data-slot="sheet-body"]');
    expect(body?.className).toContain('overflow-y-auto');
    expect(dialog.className).toContain('overflow-hidden');
    expect(body?.contains(screen.getByRole('button', { name: 'Close' }))).toBe(false);
    expect(screen.getByTestId('head').className).toContain('sticky');
    expect(screen.getByTestId('foot').className).toContain('sticky');
  });
});

describe('dialog body', () => {
  it('scrolls the content but not the way out', () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>New thing</DialogTitle>
          </DialogHeader>
          <form>
            <DialogFooter>
              <button type="submit">Save</button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>,
    );
    const body = document.querySelector('[data-slot="dialog-body"]');
    expect(body?.contains(screen.getByRole('button', { name: 'Save' }))).toBe(true);
    // The close button stays outside what scrolls, so it can't scroll away.
    expect(body?.contains(screen.getByRole('button', { name: 'Close' }))).toBe(false);
  });
});

describe('dialog error', () => {
  it('is heard at once, and brings itself into view above the pinned footer', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    render(<DialogError title="Nothing was imported">Row 3 has no source.</DialogError>);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Nothing was importedRow 3 has no source.');
    expect(alert.className).toContain('text-destructive');
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
  });
});

describe('keyboard inset', () => {
  const viewport = (height: number, scale = 1) => {
    const listeners: (() => void)[] = [];
    const vv = {
      height,
      scale,
      offsetTop: 0,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    return {
      vv,
      fire: () => {
        for (const fn of listeners) fn();
      },
    };
  };

  it('follows what the keyboard covers, and stops when the overlay goes', () => {
    const { vv, fire } = viewport(window.innerHeight);
    const el = document.createElement('div');
    const release = keyboardInset(el);
    expect(el.style.getPropertyValue('--keyboard-inset')).toBe('0px');

    vv.height = window.innerHeight - 300;
    fire();
    expect(el.style.getPropertyValue('--keyboard-inset')).toBe('300px');

    release?.();
    expect(vv.removeEventListener).toHaveBeenCalledTimes(2);
  });

  /** An overlay with a body that scrolls and a focused field behind the footer. */
  const withField = () => {
    const el = document.createElement('div');
    el.innerHTML = `<div data-slot="sheet-body"><input /><div data-slot="sheet-footer"></div></div>`;
    document.body.appendChild(el);
    const body = el.querySelector<HTMLElement>('[data-slot="sheet-body"]');
    const field = el.querySelector('input');
    const footer = el.querySelector('[data-slot="sheet-footer"]');
    if (!body || !field || !footer) throw new Error('no overlay');
    const box = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect;
    body.getBoundingClientRect = () => box(0, 300);
    field.getBoundingClientRect = () => box(280, 20);
    footer.getBoundingClientRect = () => box(250, 50);
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 300 });
    field.focus();
    return { el, body, footer };
  };

  it('brings the field clear as the keyboard rises, and leaves it alone on a pan', () => {
    const { vv, fire } = viewport(window.innerHeight);
    const { el, body } = withField();
    const release = keyboardInset(el);
    body.scrollTop = 0;

    // A pan at full scale: `offsetTop` changes, the keyboard doesn't.
    vv.offsetTop = 40;
    fire();
    expect(body.scrollTop).toBe(0);

    vv.height = window.innerHeight - 300;
    fire();
    expect(body.scrollTop).toBeGreaterThan(0);
    release?.();
    el.remove();
  });

  it('doesn’t pull the body back while pinch-zoomed', () => {
    const { vv, fire } = viewport(window.innerHeight);
    const { el, body } = withField();
    const release = keyboardInset(el);
    body.scrollTop = 0;
    vv.scale = 2;
    vv.height = window.innerHeight / 2;
    fire();
    expect(body.scrollTop).toBe(0);
    release?.();
    el.remove();
  });

  it('lets the header and footer go when pinned they would leave no room', () => {
    const { fire } = viewport(window.innerHeight);
    const { el, body, footer } = withField();
    const release = keyboardInset(el);
    expect(el.hasAttribute('data-cramped')).toBe(false);

    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 120 });
    footer.getBoundingClientRect = () => ({ top: 20, bottom: 120, height: 100 }) as DOMRect;
    fire();
    expect(el.hasAttribute('data-cramped')).toBe(true);
    release?.();
    el.remove();
  });

  it('reads a pinch-zoomed viewport as no keyboard', () => {
    viewport(window.innerHeight - 300, 2);
    const el = document.createElement('div');
    keyboardInset(el);
    expect(el.style.getPropertyValue('--keyboard-inset')).toBe('0px');
  });
});
