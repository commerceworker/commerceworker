// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useCallback, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// jsdom ships no ResizeObserver; radix's Checkbox measures itself through it.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

/** See connected-apps.test.tsx: the cache scoping is not what these tests are about. */
const refetchers = new Set<() => void>();
vi.mock('~/cms/lib/queries', () => ({
  useScopedQuery: <T,>(_segments: readonly unknown[], queryFn: () => Promise<T>) => {
    const [data, setData] = useState<T>();
    const load = useCallback(() => {
      queryFn().then(setData);
    }, [queryFn]);
    useEffect(() => {
      load();
      refetchers.add(load);
      return () => {
        refetchers.delete(load);
      };
    }, [load]);
    return { data };
  },
  useInvalidate: () => async () => {
    for (const r of refetchers) r();
  },
}));

const { Plugins } = await import('~/cms/components/Plugins');
const { ToastProvider } = await import('~/cms/lib/toast');
type ManagementClient = import('~/cms/lib/management').ManagementClient;
type InstalledPluginSummary = import('~/cms/lib/management').InstalledPluginSummary;

afterEach(() => {
  cleanup();
  refetchers.clear();
});

const renderWith = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);

const plugin = (over: Partial<InstalledPluginSummary> = {}): InstalledPluginSummary => ({
  id: 'com.example.seo',
  name: 'SEO helper',
  version: '1.2.0',
  requestedCapabilities: ['content:read'],
  approvedCapabilities: ['content:read'],
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  checksum: 'a'.repeat(64),
  enabled: false,
  installedAt: '2026-08-01T10:00:00.000Z',
  ...over,
});

function fakeClient(initial: InstalledPluginSummary[] = []) {
  let plugins = [...initial];
  return {
    listPlugins: vi.fn(async () => plugins),
    installPlugin: vi.fn(async (input: Parameters<ManagementClient['installPlugin']>[0]) => {
      const created = plugin({
        id: input.manifest.id,
        name: input.manifest.name,
        version: input.manifest.version,
        requestedCapabilities: [...input.manifest.capabilities],
        approvedCapabilities: [...input.approvedCapabilities],
        hooks: [...input.manifest.hooks],
      });
      plugins = [...plugins, created];
      return created;
    }),
    setPluginEnabled: vi.fn(async (id: string, enabled: boolean) => {
      plugins = plugins.map((p) => (p.id === id ? { ...p, enabled } : p));
      return plugins.find((p) => p.id === id) as InstalledPluginSummary;
    }),
    uninstallPlugin: vi.fn(async (id: string) => {
      plugins = plugins.filter((p) => p.id !== id);
    }),
    inspectPluginPackage: vi.fn(async () => ({
      manifest: MANIFEST,
      checksum: 'b'.repeat(64),
      publishedAt: '2026-08-01T00:00:00.000Z',
      bundleBytes: 1234,
    })),
    installPluginFromUrl: vi.fn(async () => plugin()),
    getPluginSettings: vi.fn(async (id: string) => ({
      pluginId: id,
      fields: [{ key: 'apiKey', label: 'API key', type: 'string', secret: true }],
      values: {},
      secretsSet: ['apiKey'],
      version: 1,
    })),
  } as unknown as ManagementClient & {
    inspectPluginPackage: ReturnType<typeof vi.fn>;
    installPluginFromUrl: ReturnType<typeof vi.fn>;
    listPlugins: ReturnType<typeof vi.fn>;
    installPlugin: ReturnType<typeof vi.fn>;
    setPluginEnabled: ReturnType<typeof vi.fn>;
    uninstallPlugin: ReturnType<typeof vi.fn>;
  };
}

const MANIFEST = {
  id: 'com.example.seo',
  name: 'SEO helper',
  version: '1.0.0',
  description: 'Checks titles before they are saved.',
  capabilities: ['content:read', 'content:write'],
  allowedHosts: [],
  hooks: ['entry:beforeSave'],
  entrypoint: 'index.js',
};

/** jsdom's File has no usable text() in this version; stub what the component calls. */
function fileOf(name: string, contents: string, type: string): File {
  const file = new File([contents], name, { type });
  Object.defineProperty(file, 'text', { value: async () => contents });
  return file;
}

const upload = (labelText: RegExp, file: File) => {
  const input = screen.getByLabelText(labelText) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
};

/** Opens a row's ⋯ (Radix menus open on pointerdown) and picks an item from it. */
const fromMore = async (item: string | RegExp, name = 'SEO helper') => {
  fireEvent.pointerDown(await screen.findByRole('button', { name: `More actions for “${name}”` }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
};

const openInstall = async (manifest: unknown = MANIFEST) => {
  fireEvent.click(screen.getByRole('button', { name: /install plugin/i }));
  upload(/manifest/i, fileOf('plugin.json', JSON.stringify(manifest), 'application/json'));
  upload(/bundle/i, fileOf('index.js', 'export class Plugin {}', 'text/javascript'));
  await screen.findByText('It is asking to:');
};

describe('plugin settings', () => {
  it('opens a plugin’s settings from its row, named for that plugin', async () => {
    const client = fakeClient([plugin()]);
    renderWith(<Plugins client={client} />);
    await fromMore('SEO helper settings');
    const sheet = await screen.findByRole('dialog', { name: 'SEO helper settings' });
    expect(await within(sheet).findByRole('button', { name: 'Replace API key' })).toBeTruthy();
    expect(within(sheet).getByText('Set')).toBeTruthy();
  });
});

describe('what the list tells an operator', () => {
  it('says what a plugin runs on, in the operator’s words', async () => {
    renderWith(<Plugins client={fakeClient([plugin({ hooks: ['entry:beforePublish'] })])} />);
    // Not "entry:beforePublish" — the point is what it intercepts.
    expect(await screen.findByText(/every publish/i)).toBeTruthy();
  });

  it('names capabilities in plain language, not scope strings', async () => {
    renderWith(
      <Plugins
        client={fakeClient([
          plugin({
            requestedCapabilities: ['content:write'],
            approvedCapabilities: ['content:write'],
          }),
        ])}
      />,
    );
    expect(await screen.findByText(/create and edit content/i)).toBeTruthy();
    expect(screen.queryByText('content:write')).toBeNull();
  });

  it('shows an unknown capability verbatim rather than hiding it', async () => {
    renderWith(
      <Plugins
        client={fakeClient([
          plugin({
            requestedCapabilities: ['future:thing'],
            approvedCapabilities: ['future:thing'],
          }),
        ])}
      />,
    );
    // A capability the admin cannot read is exactly the one they must see.
    expect(await screen.findByText(/future:thing/)).toBeTruthy();
  });

  it('surfaces what a plugin asked for and did not get', async () => {
    renderWith(
      <Plugins
        client={fakeClient([
          plugin({
            requestedCapabilities: ['content:read', 'content:publish'],
            approvedCapabilities: ['content:read'],
          }),
        ])}
      />,
    );
    // A plugin behaving oddly is usually one doing without something.
    expect(await screen.findByText(/asked for, not granted.*publish/i)).toBeTruthy();
  });

  it('says what each fact is, with no column header left to say it', async () => {
    renderWith(<Plugins client={fakeClient([plugin()])} />);
    const row = (await screen.findByText('SEO helper')).closest('li') as HTMLElement;
    expect(within(row).getByText('com.example.seo')).toBeTruthy();
    expect(within(row).getByText('v1.2.0')).toBeTruthy();
    expect(within(row).getByText('Runs on every entry save')).toBeTruthy();
    expect(within(row).getByText(/^Can: /)).toBeTruthy();
  });

  it('distinguishes running from installed-but-disabled', async () => {
    renderWith(<Plugins client={fakeClient([plugin({ enabled: true })])} />);
    // Status is a word, never color alone.
    expect(await screen.findByText('Running')).toBeTruthy();
  });
});

describe('consent', () => {
  it('does not show the capability checkboxes before there is a manifest to read', async () => {
    renderWith(<Plugins client={fakeClient()} />);
    fireEvent.click(await screen.findByRole('button', { name: /install plugin/i }));
    // Otherwise people learn to click through the step that matters most.
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('It is asking to:')).toBeNull();
  });

  it('names every capability checkbox itself', async () => {
    renderWith(<Plugins client={fakeClient()} />);
    await openInstall();
    // Asserting the name *source*, not `getByRole(…, {name})` — that query
    // passes in jsdom whether or not the box is named, which is how an unnamed
    // permission checkbox shipped once already. The browser check lives in
    // e2e/accessibility.spec.ts; this one only pins that we did not drop the
    // attribute. Radix renders a <button role="checkbox">.
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('pre-approves what the manifest asked for, so unchecking narrows', async () => {
    renderWith(<Plugins client={fakeClient()} />);
    await openInstall();
    expect(
      (screen.getByRole('checkbox', { name: /read content/i }) as HTMLElement).getAttribute(
        'data-state',
      ),
    ).toBe('checked');
    expect(
      (
        screen.getByRole('checkbox', { name: /create and edit content/i }) as HTMLElement
      ).getAttribute('data-state'),
    ).toBe('checked');
  });

  it('installs only what was left checked', async () => {
    const client = fakeClient();
    renderWith(<Plugins client={client} />);
    await openInstall();
    fireEvent.click(screen.getByRole('checkbox', { name: /create and edit content/i }));
    fireEvent.click(screen.getByRole('button', { name: /install disabled/i }));

    await waitFor(() => expect(client.installPlugin).toHaveBeenCalled());
    expect(client.installPlugin.mock.calls[0]?.[0].approvedCapabilities).toEqual(['content:read']);
  });

  it('says what the code will intercept before it is installed', async () => {
    renderWith(<Plugins client={fakeClient()} />);
    await openInstall();
    expect(screen.getByText(/every entry save/i)).toBeTruthy();
    expect(screen.getByText(/can refuse it/i)).toBeTruthy();
  });

  it('refuses a file that is not a manifest instead of failing later', async () => {
    renderWith(<Plugins client={fakeClient()} />);
    fireEvent.click(screen.getByRole('button', { name: /install plugin/i }));
    upload(/manifest/i, fileOf('nope.json', '{"hello":"world"}', 'application/json'));
    expect(await screen.findByText(/not a plugin manifest/i)).toBeTruthy();
  });

  it('cannot be submitted with only one of the two files', async () => {
    renderWith(<Plugins client={fakeClient()} />);
    fireEvent.click(screen.getByRole('button', { name: /install plugin/i }));
    upload(/manifest/i, fileOf('plugin.json', JSON.stringify(MANIFEST), 'application/json'));
    await screen.findByText('It is asking to:');
    // A manifest without bytes would install a plugin that is not there.
    expect(screen.getByRole('button', { name: /install disabled/i })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('installs disabled, and the button says so', async () => {
    renderWith(<Plugins client={fakeClient()} />);
    await openInstall();
    // Approving a capability list and running code are two decisions.
    expect(screen.getByRole('button', { name: /install disabled/i })).toBeTruthy();
  });
});

describe('network access', () => {
  const NETWORKY = {
    ...MANIFEST,
    capabilities: ['content:read', 'network:request'],
    allowedHosts: ['api.example.com'],
  };

  it('is approvable, and says it reads rather than writes', async () => {
    renderWith(<Plugins client={fakeClient()} />);
    await openInstall(NETWORKY);

    const box = screen.getByRole('checkbox', { name: /call external services/i });
    // No longer offered-and-unapprovable: the isolate has no network at all,
    // and access is a capability method checked against the allowlist.
    expect(box.getAttribute('data-state')).toBe('checked');
    expect(box).toHaveProperty('disabled', false);
    expect(screen.getByText(/it cannot write to them/i)).toBeTruthy();
  });

  it('shows the hosts the plugin listed', async () => {
    renderWith(<Plugins client={fakeClient()} />);
    await openInstall(NETWORKY);
    expect(screen.getByText(/api\.example\.com/)).toBeTruthy();
  });

  it('is granted when left checked', async () => {
    const client = fakeClient();
    renderWith(<Plugins client={client} />);
    await openInstall(NETWORKY);
    fireEvent.click(screen.getByRole('button', { name: /install disabled/i }));

    await waitFor(() => expect(client.installPlugin).toHaveBeenCalled());
    expect(client.installPlugin.mock.calls[0]?.[0].approvedCapabilities).toEqual([
      'content:read',
      'network:request',
    ]);
  });

  it('can still be declined, leaving a plugin that runs without it', async () => {
    const client = fakeClient();
    renderWith(<Plugins client={client} />);
    await openInstall(NETWORKY);
    fireEvent.click(screen.getByRole('checkbox', { name: /call external services/i }));
    fireEvent.click(screen.getByRole('button', { name: /install disabled/i }));

    await waitFor(() => expect(client.installPlugin).toHaveBeenCalled());
    expect(client.installPlugin.mock.calls[0]?.[0].approvedCapabilities).toEqual(['content:read']);
  });
});

describe('lifecycle', () => {
  it('enables a plugin and reflects it', async () => {
    const client = fakeClient([plugin()]);
    renderWith(<Plugins client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable “SEO helper”' }));

    await waitFor(() =>
      expect(client.setPluginEnabled).toHaveBeenCalledWith('com.example.seo', true),
    );
    expect(await screen.findByText('Running')).toBeTruthy();
  });

  it('confirms before uninstalling, and says what survives', async () => {
    const client = fakeClient([plugin()]);
    renderWith(<Plugins client={client} />);
    await fromMore(/uninstall/i);

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/content it already changed stays/i)).toBeTruthy();
    expect(client.uninstallPlugin).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: /^uninstall$/i }));
    await waitFor(() => expect(client.uninstallPlugin).toHaveBeenCalledWith('com.example.seo'));
  });

  it('goes back to the row’s ⋯ when the uninstall question is declined', async () => {
    const client = fakeClient([plugin()]);
    renderWith(<Plugins client={client} />);
    await fromMore(/uninstall/i);

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'More actions for “SEO helper”',
      ),
    );
    expect(client.uninstallPlugin).not.toHaveBeenCalled();
  });

  it('invites the first install rather than showing an empty table', async () => {
    renderWith(<Plugins client={fakeClient()} />);
    expect(await screen.findByText(/no plugins installed/i)).toBeTruthy();
  });
});

describe('installing from a URL', () => {
  const openUrlMode = async () => {
    fireEvent.click(screen.getByRole('button', { name: /install plugin/i }));
    fireEvent.click(screen.getByRole('button', { name: /from a url/i }));
  };

  it('asks for nothing until the package has been fetched', async () => {
    renderWith(<Plugins client={fakeClient()} />);
    await openUrlMode();
    // Same rule as the file flow: no consent checkboxes before there is
    // anything to consent to.
    expect(screen.queryByText('It is asking to:')).toBeNull();
    expect(screen.getByRole('button', { name: /install disabled/i })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('stays closable while a package is fetched, and drops what comes back late', async () => {
    const client = fakeClient();
    let signal: AbortSignal | undefined;
    client.inspectPluginPackage.mockImplementationOnce((_input: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise(() => {});
    });
    renderWith(<Plugins client={client} />);
    await openUrlMode();
    fireEvent.change(screen.getByLabelText(/package url/i), {
      target: { value: 'https://plugins.example.com/seo.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^fetch$/i }));
    await screen.findByRole('button', { name: 'Fetching…' });

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel.hasAttribute('disabled')).toBe(false);
    fireEvent.click(cancel);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(signal?.aborted).toBe(true);
  });

  it('shows what the server verified, not what the URL claimed', async () => {
    const client = fakeClient();
    renderWith(<Plugins client={client} />);
    await openUrlMode();
    fireEvent.change(screen.getByLabelText(/package url/i), {
      target: { value: 'https://plugins.example.com/seo.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^fetch$/i }));

    await screen.findByText('It is asking to:');
    expect(client.inspectPluginPackage).toHaveBeenCalledWith(
      { packageUrl: 'https://plugins.example.com/seo.json' },
      expect.any(AbortSignal),
    );
    expect(screen.getByText(/1,234 bytes/)).toBeTruthy();
    expect(screen.getByText(new RegExp('b'.repeat(64)))).toBeTruthy();
  });

  it('pins the checksum it displayed', async () => {
    const client = fakeClient();
    renderWith(<Plugins client={client} />);
    await openUrlMode();
    fireEvent.change(screen.getByLabelText(/package url/i), {
      target: { value: 'https://plugins.example.com/seo.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^fetch$/i }));
    await screen.findByText('It is asking to:');
    fireEvent.click(screen.getByRole('button', { name: /install disabled/i }));

    await waitFor(() => expect(client.installPluginFromUrl).toHaveBeenCalled());
    // A release swapped in between fetch and install is refused server-side,
    // rather than installed under an approval given for something else.
    expect(client.installPluginFromUrl.mock.calls[0]?.[0]).toMatchObject({
      packageUrl: 'https://plugins.example.com/seo.json',
      expectedChecksum: 'b'.repeat(64),
      approvedCapabilities: ['content:read', 'content:write'],
    });
  });

  it('drops what it fetched when the URL is edited', async () => {
    renderWith(<Plugins client={fakeClient()} />);
    await openUrlMode();
    const url = screen.getByLabelText(/package url/i);
    fireEvent.change(url, { target: { value: 'https://plugins.example.com/seo.json' } });
    fireEvent.click(screen.getByRole('button', { name: /^fetch$/i }));
    await screen.findByText('It is asking to:');

    fireEvent.change(url, { target: { value: 'https://plugins.example.com/other.json' } });
    // Leaving the old manifest on screen would mean approving one thing and
    // installing another.
    expect(screen.queryByText('It is asking to:')).toBeNull();
  });

  it('reports a package the server refused', async () => {
    const client = fakeClient();
    (client.inspectPluginPackage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Bundle does not match its declared checksum'),
    );
    renderWith(<Plugins client={client} />);
    await openUrlMode();
    fireEvent.change(screen.getByLabelText(/package url/i), {
      target: { value: 'https://plugins.example.com/seo.json' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^fetch$/i }));

    expect(await screen.findByText(/does not match its declared checksum/i)).toBeTruthy();
  });
});
describe('approving capabilities on an installed plugin', () => {
  const withApproval = (initial: InstalledPluginSummary[]) => {
    const client = fakeClient(initial);
    const approvePluginCapabilities = vi.fn(async (_id: string, approved: string[]) =>
      plugin({ ...initial[0], approvedCapabilities: approved, needsReapproval: false }),
    );
    const upgradePlugin = vi.fn(async (_id: string, input: { manifest: { version: string } }) =>
      plugin({ ...initial[0], version: input.manifest.version }),
    );
    return Object.assign(client, { approvePluginCapabilities, upgradePlugin });
  };

  it('flags a plugin that predates capability manifests and will not switch it on', async () => {
    renderWith(
      <Plugins client={withApproval([plugin({ needsReapproval: true, enabled: false })])} />,
    );
    expect(await screen.findByText('Needs review')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^enable/i })).toBeNull();
    expect(screen.getByRole('button', { name: /review access/i })).toBeTruthy();
  });

  it('re-approves through an in-place confirmation, sending exactly what is checked', async () => {
    const client = withApproval([
      plugin({
        needsReapproval: true,
        requestedCapabilities: ['content:read', 'taxonomy:read'],
        approvedCapabilities: ['content:read', 'taxonomy:read'],
      }),
    ]);
    renderWith(<Plugins client={client} />);
    fireEvent.click(await screen.findByRole('button', { name: /review access/i }));

    const confirm = screen.getByRole('alertdialog');
    expect(
      within(confirm).getByText(/installed before plugins declared capabilities/i),
    ).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('checkbox', { name: /read taxonomy/i }));
    fireEvent.click(within(confirm).getByRole('button', { name: /^approve$/i }));

    await waitFor(() => expect(client.approvePluginCapabilities).toHaveBeenCalled());
    expect(client.approvePluginCapabilities.mock.calls[0]).toEqual([
      'com.example.seo',
      ['content:read'],
    ]);
  });

  it('says up front that granting more will stop the plugin', async () => {
    renderWith(
      <Plugins
        client={withApproval([
          plugin({
            enabled: true,
            requestedCapabilities: ['content:read', 'content:publish'],
            approvedCapabilities: ['content:read'],
          }),
        ])}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Access for “SEO helper”' }));
    const confirm = screen.getByRole('alertdialog');
    const publish = within(confirm).getByRole('checkbox', { name: /publish content/i });
    expect(publish.getAttribute('data-state')).toBe('unchecked');
    fireEvent.click(publish);
    expect(within(confirm).getByRole('button', { name: /approve and disable/i })).toBeTruthy();
  });

  it('marks what an upgrade newly asks for, and keeps earlier declines', async () => {
    const client = withApproval([
      plugin({
        enabled: true,
        requestedCapabilities: ['content:read', 'content:write'],
        approvedCapabilities: ['content:read'],
      }),
    ]);
    renderWith(<Plugins client={client} />);
    await fromMore(/upgrade/i);
    upload(
      /new manifest/i,
      fileOf(
        'plugin.json',
        JSON.stringify({
          ...MANIFEST,
          version: '2.0.0',
          capabilities: ['content:read', 'content:write', 'taxonomy:read'],
        }),
        'application/json',
      ),
    );
    upload(/new bundle/i, fileOf('index.js', 'export class Plugin {} // v2', 'text/javascript'));
    await screen.findByText(/one capability the installed version never did/i);

    const state = (name: RegExp) =>
      screen.getByRole('checkbox', { name }).getAttribute('data-state');
    expect(state(/read content/i)).toBe('checked');
    // Declined before, still declined: re-asking is not new information.
    expect(state(/create and edit content/i)).toBe('unchecked');
    // New, and pre-checked so consent can only narrow.
    expect(state(/read taxonomy/i)).toBe('checked');
    expect(screen.getByText('New')).toBeTruthy();

    const submit = screen.getByRole('button', { name: /upgrade disabled/i }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(client.upgradePlugin).toHaveBeenCalled());
    expect(client.upgradePlugin.mock.calls[0]?.[1]).toMatchObject({
      approvedCapabilities: ['content:read', 'taxonomy:read'],
    });
  });

  it('refuses a manifest for a different plugin', async () => {
    renderWith(<Plugins client={withApproval([plugin()])} />);
    await fromMore(/upgrade/i);
    upload(
      /new manifest/i,
      fileOf('plugin.json', JSON.stringify({ ...MANIFEST, id: 'com.other' }), 'application/json'),
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/for “com\.other”/);
  });
});
