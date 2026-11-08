// @vitest-environment jsdom
import type { Asset } from '@commerceworker/domain';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** As in asset-library.test.tsx: a CI runner's first render can outlast the default second. */
configure({ asyncUtilTimeout: 5000 });

const image = (over: Partial<Asset['metadata']> = {}): Asset => ({
  id: 'a1',
  status: 'draft',
  title: {},
  description: {},
  metadata: { altText: {}, tags: [], ...over },
  file: { url: 'https://cdn.example/photo.jpg', fileName: 'photo.jpg', contentType: 'image/jpeg' },
});

let assets: Asset[] = [];
const client = {
  listAssets: vi.fn(async (_q?: unknown) => ({ items: assets })),
  listAssetFolders: vi.fn(async () => []),
  listTags: vi.fn(async () => [{ id: 't1', name: 'Hero' }]),
  assetUsage: vi.fn(async () => []),
  listAssetVersions: vi.fn(async () => []),
  getTeam: vi.fn(async () => ({
    people: [],
    keys: [],
    adminCount: 1,
    settings: { ssoOnly: false },
  })),
  publishAsset: vi.fn(),
  unpublishAsset: vi.fn(),
  archiveAsset: vi.fn(),
  restoreAsset: vi.fn(),
  deleteAsset: vi.fn(),
  moveAssets: vi.fn(),
  refreshVideoAsset: vi.fn(),
  uploadAsset: vi.fn(),
  uploadVideo: vi.fn(),
  searchAssets: vi.fn(),
  getAsset: vi.fn(),
  reingestAsset: vi.fn(),
  setAssetMetadata: vi.fn(async (_id: string, _patch: unknown) => image()),
  generateAltText: vi.fn(async () => ({ altText: 'A red mug', locale: 'en-US', applied: false })),
  autoTagAsset: vi.fn(async () => ({ tagIds: ['t1'], newTags: [], applied: false })),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({
    client,
    conn: { space: 's', environment: 'main', locale: 'en-US' },
    busy: false,
    run: (fn: () => Promise<void>) => fn(),
  }),
}));

const { ToastProvider } = await import('~/cms/lib/toast');
const { AssetLibrary } = await import('~/cms/components/AssetLibrary');

afterEach(() => {
  vi.clearAllMocks();
  assets = [];
});

async function openDetails() {
  render(
    <MemoryRouter>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ToastProvider>
          <AssetLibrary locale="en-US" />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Open “photo.jpg”' }));
  const sheet = await screen.findByRole('dialog');
  await within(sheet).findByLabelText('Alt text (en-US)');
  return sheet;
}

describe('the asset sheet’s Details tab', () => {
  it('offers the AI suggestions as the admin’s other AI actions do: the mark, no emoji', async () => {
    assets = [image()];
    const sheet = await openDetails();
    const generate = within(sheet).getByRole('button', { name: 'Generate alt text' });
    const tags = within(sheet).getByRole('button', { name: 'Suggest tags' });
    for (const button of [generate, tags]) {
      expect(button.textContent).not.toMatch(/✨/u);
      // The AI mark at rest, in the ai tone, hidden from the name.
      const mark = button.querySelector('[data-slot="compose-loader"]');
      expect(mark?.getAttribute('class')).toContain('text-ai');
      expect(mark?.getAttribute('aria-hidden')).toBe('true');
      expect(mark?.getAttribute('class')).not.toContain('cw-compose');
    }

    let finish: () => void = () => {};
    client.generateAltText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ altText: 'A red mug', locale: 'en-US', applied: false });
        }),
    );
    fireEvent.click(generate);
    // While the model works: the mark composes, the label says so, and neither can be pressed.
    const busy = await within(sheet).findByRole('button', { name: 'Generating…' });
    expect(busy.querySelector('[data-slot="compose-loader"]')?.getAttribute('class')).toContain(
      'cw-compose',
    );
    expect(busy).toHaveProperty('disabled', true);
    expect(tags).toHaveProperty('disabled', true);
    finish();
    await waitFor(() =>
      expect(within(sheet).getByLabelText('Alt text (en-US)')).toHaveProperty('value', 'A red mug'),
    );
    expect(within(sheet).getByRole('button', { name: 'Generate alt text' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('opens on the form rather than Share', async () => {
    assets = [image()];
    const sheet = await openDetails();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        sheet.querySelector('button[aria-describedby="asset-focal-hint"]'),
      ),
    );
  });

  it('says Tap, and no keyboard, under a finger', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({
          matches: query.includes('pointer: coarse'),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    assets = [image()];
    const sheet = await openDetails();
    const hint = sheet.querySelector('#asset-focal-hint');
    expect(hint?.textContent).toBe('Tap the image to set a focal point for smart cropping.');
    vi.restoreAllMocks();
  });

  it('names the focal point control by where the point is, and moves it with the keyboard', async () => {
    assets = [image()];
    const sheet = await openDetails();
    const control = within(sheet).getByRole('button', { name: 'Focal point: not set' });
    expect(control.getAttribute('aria-describedby')).toBe('asset-focal-hint');
    // Where the point moves is heard: the hint is a polite live region.
    expect(sheet.querySelector('#asset-focal-hint')?.getAttribute('aria-live')).toBe('polite');
    expect(sheet.querySelector('[data-testid="focal-marker"]')).toBeNull();

    // Enter (a click with no pointer) sets it in the middle, not the corner.
    fireEvent.click(control, { detail: 0 });
    expect(control.getAttribute('aria-label')).toBe('Focal point: 50% across, 50% down');
    fireEvent.keyDown(control, { key: 'ArrowRight' });
    fireEvent.keyDown(control, { key: 'ArrowDown', shiftKey: true });
    expect(control.getAttribute('aria-label')).toBe('Focal point: 51% across, 60% down');
    // Clamped at the edge.
    for (let i = 0; i < 8; i++) fireEvent.keyDown(control, { key: 'ArrowLeft', shiftKey: true });
    expect(control.getAttribute('aria-label')).toBe('Focal point: 0% across, 60% down');

    const marker = sheet.querySelector<HTMLElement>('[data-testid="focal-marker"]');
    expect(marker?.style.left).toBe('0%');
    expect(marker?.style.top).toBe('60%');

    fireEvent.click(within(sheet).getByRole('button', { name: 'Save metadata' }));
    await waitFor(() =>
      expect(client.setAssetMetadata).toHaveBeenCalledWith(
        'a1',
        expect.objectContaining({ focalPoint: { x: 0, y: 0.6 } }),
      ),
    );
  });

  it('draws the marker in theme tokens, ink ring on a paper halo, never a fixed white', async () => {
    assets = [image({ focalPoint: { x: 0.25, y: 0.75 } })];
    const sheet = await openDetails();
    within(sheet).getByRole('button', { name: 'Focal point: 25% across, 75% down' });
    const marker = sheet.querySelector<HTMLElement>('[data-testid="focal-marker"]');
    const classes = marker?.className ?? '';
    expect(classes).toContain('border-foreground');
    expect(classes).toContain('ring-background');
    expect(classes).not.toMatch(/white|black|#[0-9a-f]{3}/i);
    expect(marker?.getAttribute('aria-hidden')).toBeNull();
    // Decorative inside its named control: the image itself adds no second name.
    expect(
      sheet.querySelector('button[aria-describedby="asset-focal-hint"] img')?.getAttribute('alt'),
    ).toBe('');
  });
});
