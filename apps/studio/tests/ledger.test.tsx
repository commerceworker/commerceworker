// Ledger in the CMS screens: the primitives never fade a control through low contrast, the
// stylesheet carries the tokens the ported screens use, statuses read in words as well as colour,
// and tables stack on a phone. (Palette parity with @commerceworker/design is packages/design's.)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@commerceworker/ui/tabs';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge, ToneBadge } from '~/cms/components/status';
import { ago, countLabel, statusLabel, statusTone } from '~/cms/lib/format';

// The stylesheet as text (Vite's ?raw comes back empty under vitest's CSS handling).
const css = readFileSync(join(process.cwd(), 'app/app.css'), 'utf8');

// The UI primitives' source, to check what their transitions animate.
const primitives = import.meta.glob('../../../packages/ui/src/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('UI primitives', () => {
  it('never fade a control through low contrast: a disabled state never animates opacity', () => {
    const offenders = Object.entries(primitives)
      .filter(([, src]) => src.includes('disabled:opacity'))
      // On the element itself; a pseudo-element's own fade (`after:transition-opacity`, a tab's
      // underline) never carries the control's text.
      .filter(([, src]) =>
        /(?<![\w:-])transition-(?:all|opacity)\b|(?<![\w:-])transition-\[[^\]]*opacity/.test(src),
      )
      .map(([file]) => file);
    expect(offenders).toEqual([]);
    expect(Object.keys(primitives).length).toBeGreaterThan(10);
  });
});

describe('Tabs', () => {
  // A trigger is drawn 25px tall in a 32px list: under DESIGN.md's 44px for a finger. On a coarse
  // pointer each trigger is at least 44px square and the list grows to hold it; a mouse keeps the
  // drawn size. (The measured size on each device is apps/studio/e2e/shell.spec.ts's.)
  it('gives every trigger a 44px target on touch and lets the list grow to hold it', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Concepts</TabsTrigger>
          <TabsTrigger value="b">Tags</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className.split(' ')).toEqual(
        expect.arrayContaining(['touch:min-h-11', 'touch:min-w-11', 'h-[calc(100%-1px)]']),
      );
    }
    expect(screen.getByRole('tablist').className.split(' ')).toEqual(
      expect.arrayContaining([
        'group-data-horizontal/tabs:h-8',
        'touch:group-data-horizontal/tabs:h-auto',
      ]),
    );
  });
});

// The admin's screens' source, for rules that hold across files.
const screens = import.meta.glob(['../app/**/*.tsx', '!../app/**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('The current item', () => {
  it('is marked by its fill, never by a brand stripe or tick at its edge', () => {
    expect(css).toMatch(/@utility current-item \{/);
    const block = css.slice(css.indexOf('@utility current-item {'));
    expect(block.slice(0, block.indexOf('\n}\n'))).not.toContain('::before');
    const edges = Object.entries({ ...primitives, ...screens })
      .filter(([, src]) =>
        /inset_\d+px_0_var\(--brand\)|border-[lse]-brand|border-l-\[?var\(--brand|before:[^'"`\s]*bg-brand|tick-current/.test(
          src,
        ),
      )
      .map(([file]) => file);
    expect(edges).toEqual([]);
  });

  it('takes a hairline outline, unless focused, under forced colours', () => {
    const block = css.slice(css.indexOf('@utility current-item {'));
    const forced = block.slice(0, block.indexOf('\n}\n'));
    expect(forced).toContain('@media (forced-colors: active)');
    expect(forced).toContain('&:not(:focus-visible)');
    expect(forced).toContain('outline: 1px solid CanvasText');
  });

  it('never shares its fill with hover, press or an open menu, so nothing else looks current', () => {
    const src = (name: string) =>
      Object.entries({ ...primitives, ...screens }).find(([f]) => f.endsWith(name))?.[1] ?? '';
    // The sidebar's menu button variants: the rows that can be current.
    const sidebar = src('/sidebar.tsx');
    const start = sidebar.indexOf('sidebarMenuButtonVariants = cva(');
    const button = sidebar.slice(start, sidebar.indexOf('\n);\n', start));
    expect(button).toContain('data-active:current-item');
    // Every fill other than the current one is guarded off the current row and a step lighter.
    expect(button).not.toMatch(/(?<![:\w-])(hover|active|data-open):bg-sidebar-accent(?![/\w])/);
    expect(button.match(/not-data-active:hover:bg-sidebar-accent\/60/g)).toHaveLength(3);
    expect(button).toContain('not-data-active:active:bg-sidebar-accent/60');
    expect(button).toContain('not-data-active:data-open:bg-sidebar-accent/60');
    // A screen's own nav: the hover fill only on rows that aren't current.
    expect(src('/AssetFolderTree.tsx')).toMatch(
      /props\.current\s*\?\s*'current-item[^']*'\s*:\s*'hover:bg-muted\/60'/,
    );
    // The More sheet's rows, the shell's one list that marks a current page.
    const row = src('/routes/shell.tsx').match(/'flex min-h-11[^']*'/)?.[0] ?? '';
    expect(row).toContain('current-item');
    expect(row).toContain('not-aria-[current=page]:hover:bg-accent/60');
    expect(row).not.toMatch(/(?<![:\w-])hover:bg-accent(?![/\w])/);
  });

  it('never has its forced-colours outline removed by the row itself', () => {
    // A bare outline-none / outline-hidden (not behind focus-visible) beats the utility's outline.
    for (const [file, text] of Object.entries({ ...primitives, ...screens })) {
      for (const cls of text.match(/['"`][^'"`]*current-item[^'"`]*['"`]/g) ?? [])
        expect(cls, file).not.toMatch(/(?<![:\w-])outline-(none|hidden)\b/);
    }
    const tree = Object.entries(screens).find(([f]) => f.endsWith('/AssetFolderTree.tsx'))?.[1];
    expect(tree).not.toMatch(/(?<![:\w-])outline-none\b/);
  });
});

describe('Ledger tokens in app.css', () => {
  it('defines the motion tokens and state variants the CMS screens and primitives use', () => {
    for (const t of ['--motion-instant', '--motion-move', '--motion-travel', '--ease-arrive'])
      expect(css).toContain(`${t}:`);
    for (const v of ['data-open', 'data-closed', 'data-checked', 'data-active', 'data-horizontal'])
      expect(css).toContain(`@custom-variant ${v} {`);
    expect(css).toContain('.rich-text-editor');
    expect(css).toContain('--color-cat-content');
  });

  it('defines every status token in light and dark', () => {
    const [light, dark] = css.split(':root[data-theme="dark"]');
    for (const t of ['ok', 'wait', 'bad', 'undo', 'idle', 'brand']) {
      expect(light).toMatch(new RegExp(`--${t}: oklch`));
      expect(dark).toMatch(new RegExp(`--${t}: oklch`));
    }
    // Run is the work blue in both themes; a model's work is the brand, and so is focus.
    expect(light).toContain('--run: var(--link);');
    expect(light).toContain('--ai: var(--brand);');
    expect(light).toContain('--ring: var(--brand);');
  });
});

describe('status vocabulary', () => {
  it("maps commerceworker's statuses onto one meaning each", () => {
    expect(statusTone('published')).toBe('ok');
    expect(statusTone('changed')).toBe('wait');
    expect(statusTone('scheduled')).toBe('run');
    expect(statusTone('draft')).toBe('idle');
    expect(statusTone('archived')).toBe('idle');
    expect(statusTone('revoked')).toBe('idle');
    expect(statusTone('failed')).toBe('bad');
    expect(statusTone('proposed')).toBe('ai');
    expect(statusTone('something-new')).toBe('idle');
    expect(statusLabel('in_review')).toBe('In review');
    expect(countLabel(100)).toBe('99+');
    expect(ago(Date.now() - 3 * 60_000)).toBe('3m ago');
  });

  it('tints a status and rules a bad ending, in words as well as colour', () => {
    render(
      <>
        <StatusBadge status="published" />
        <StatusBadge status="failed" />
        <ToneBadge tone="wait" label="Unsaved changes" />
      </>,
    );
    const ok = screen.getByText('Published');
    expect(ok.getAttribute('style')).toContain('var(--ok)');
    expect(ok.getAttribute('style')).toContain('color-mix');
    const bad = screen.getByText('Failed');
    expect(bad.getAttribute('style')).toContain('border-color: var(--bad)');
    expect(screen.getByText('Unsaved changes').getAttribute('style')).toContain('var(--wait)');
  });
});

describe('Table', () => {
  it('stacks into cards on a phone, labelling every cell but the first', () => {
    render(
      <Table stack="cards" caption="Keys">
        <TableHead>
          <Tr>
            <Th>Name</Th>
            <Th numeric>Uses</Th>
          </Tr>
        </TableHead>
        <TableBody>
          <Tr>
            <Td>dev-cma</Td>
            <Td label="Uses" numeric>
              12
            </Td>
          </Tr>
        </TableBody>
      </Table>,
    );
    const table = screen.getByRole('table', { name: 'Keys' });
    expect(table.className).toContain('table-stack');
    // Explicit roles survive the phone layout, which drops them in WebKit otherwise.
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByRole('columnheader', { name: 'Uses' }).className).toContain(
      'text-right',
    );
    expect(within(table).getByRole('cell', { name: '12' }).dataset.label).toBe('Uses');
  });
});
