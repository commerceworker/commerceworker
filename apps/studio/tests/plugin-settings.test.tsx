// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PluginSettingsSheet } from '~/cms/components/PluginSettingsSheet';
import {
  ApiError,
  type ManagementClient,
  type PluginSettingsView,
  RequestTimeoutError,
} from '~/cms/lib/management';
import { settingsDraft, settingsIssues, settingsPatch } from '~/cms/lib/plugin-settings';
import { ToastProvider } from '~/cms/lib/toast';

/**
 * The plugin settings form: drawn from the manifest's fields, secrets write-only (set or not, never
 * a value), only what changed sent, and each refusal put back where it belongs.
 */

const FIELDS: PluginSettingsView['fields'] = [
  { key: 'apiKey', label: 'API key', type: 'string', secret: true, required: true },
  { key: 'site', label: 'Site name', type: 'string', description: 'Shown in titles.' },
  { key: 'maxLength', label: 'Max length', type: 'number', default: 120 },
  { key: 'strict', label: 'Strict mode', type: 'boolean' },
  { key: 'tone', label: 'Tone', type: 'select', options: ['formal', 'casual'] },
];

const view = (over: Partial<PluginSettingsView> = {}): PluginSettingsView => ({
  pluginId: 'com.example.seo',
  fields: FIELDS,
  values: { maxLength: 120 },
  secretsSet: [],
  version: 0,
  ...over,
});

const PLUGIN = { id: 'com.example.seo', name: 'SEO helper' };

function fakeClient(initial: PluginSettingsView) {
  let current = initial;
  return {
    getPluginSettings: vi.fn(async () => current),
    setPluginSettings: vi.fn(
      async (_id: string, input: { values: Record<string, unknown>; expectedVersion: number }) => {
        const secretsSet = new Set(current.secretsSet);
        const values: Record<string, string | number | boolean> = { ...current.values };
        for (const [k, v] of Object.entries(input.values)) {
          const field = current.fields.find((f) => f.key === k);
          if (field?.secret) v === null ? secretsSet.delete(k) : secretsSet.add(k);
          else if (v === null) delete values[k];
          else values[k] = v as string | number | boolean;
        }
        current = {
          ...current,
          values,
          secretsSet: [...secretsSet],
          version: current.version + 1,
        };
        return current;
      },
    ),
  } as unknown as ManagementClient & {
    getPluginSettings: ReturnType<typeof vi.fn>;
    setPluginSettings: ReturnType<typeof vi.fn>;
  };
}

const unprocessable = (issues: { field: string; message: string }[]) =>
  new ApiError(422, 'PATCH → 422', {
    error: { code: 'validation_failed', message: 'Invalid', issues },
  });

const open = (client: ManagementClient, onOpenChange = vi.fn()) =>
  render(
    <ToastProvider>
      <PluginSettingsSheet client={client} plugin={PLUGIN} onOpenChange={onOpenChange} />
    </ToastProvider>,
  );

describe('leaving during a save', () => {
  it('holds rather than offer to discard what has been sent', async () => {
    const client = fakeClient(view());
    let finish: (v: PluginSettingsView) => void = () => {};
    client.setPluginSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    open(client, onOpenChange);
    const sheet = await screen.findByRole('dialog');
    const [input] = await within(sheet).findAllByRole('textbox');
    fireEvent.change(input as HTMLElement, { target: { value: 'changed' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save settings' }));
    await within(sheet).findByRole('button', { name: 'Saving…' });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(within(sheet).getByRole('status').textContent).toContain('Still saving');
    await act(async () => finish(view({ version: 2 })));
  });
});

describe('settings patch', () => {
  it('sends nothing for an untouched form, and never a secret it was not given', () => {
    const v = view({ secretsSet: ['apiKey'], values: { maxLength: 120, strict: false } });
    expect(settingsPatch(v, settingsDraft(v))).toEqual({});
  });

  it('sends only what changed, typed, and null for what was emptied', () => {
    const v = view({ values: { maxLength: 80, site: 'Acme', tone: 'formal' } });
    const draft = {
      ...settingsDraft(v),
      site: '',
      maxLength: ' 64 ',
      strict: true,
      tone: 'formal',
      apiKey: { action: 'replace' as const, value: 'sk_new' },
    };
    expect(settingsPatch(v, draft)).toEqual({
      apiKey: 'sk_new',
      site: null,
      maxLength: 64,
      strict: true,
    });
  });

  it('sends a number that does not parse as typed, for the server to refuse', () => {
    const v = view();
    expect(settingsPatch(v, { ...settingsDraft(v), maxLength: '12abc' })).toEqual({
      maxLength: '12abc',
    });
  });

  it('clears a secret only when one is set, and ignores an empty replacement', () => {
    const unset = view();
    expect(settingsPatch(unset, { ...settingsDraft(unset), apiKey: { action: 'clear' } })).toEqual(
      {},
    );
    expect(
      settingsPatch(unset, { ...settingsDraft(unset), apiKey: { action: 'replace', value: '' } }),
    ).toEqual({});
    const set = view({ secretsSet: ['apiKey'] });
    expect(settingsPatch(set, { ...settingsDraft(set), apiKey: { action: 'clear' } })).toEqual({
      apiKey: null,
    });
  });

  it('maps both issue spellings to the setting, and the rest to the form', () => {
    const err = unprocessable([
      { field: 'maxLength', message: 'must be a number' },
      { field: 'values.site', message: 'Too long' },
      { field: 'nope', message: 'The plugin declares no such setting' },
    ]);
    expect(settingsIssues(FIELDS, err)).toEqual({
      byKey: { maxLength: 'must be a number', site: 'Too long' },
      form: ['The plugin declares no such setting'],
    });
    expect(settingsIssues(FIELDS, new ApiError(409, 'conflict'))).toEqual({ byKey: {}, form: [] });
  });
});

describe('PluginSettingsSheet', () => {
  it('draws a control per declared field, each named by its label', async () => {
    open(fakeClient(view({ values: { maxLength: 120, tone: 'casual', strict: true } })));
    expect(await screen.findByLabelText('Site name')).toHaveProperty('value', '');
    expect(screen.getByLabelText('Max length')).toHaveProperty('value', '120');
    expect(screen.getByRole('switch', { name: 'Strict mode' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    const tone = screen.getByRole('combobox', { name: 'Tone' });
    expect(tone).toHaveProperty('value', 'casual');
    expect(
      within(tone)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['', 'formal', 'casual']);
    // The description and the default are the field's hint, read with it.
    expect(screen.getByLabelText('Site name').getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Empty uses the default, 120.')).toBeTruthy();
  });

  it('shows a secret as set or not set, with no value anywhere on the page', async () => {
    const { container } = open(fakeClient(view({ secretsSet: ['apiKey'] })));
    const group = await screen.findByRole('group', { name: /API key/ });
    expect(within(group).getByText('Set')).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Replace API key' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Clear API key' })).toBeTruthy();
    expect(container.ownerDocument.querySelector('input[type="password"]')).toBeNull();
  });

  it('replaces a secret through an empty password input, sending only that key', async () => {
    const client = fakeClient(view({ secretsSet: ['apiKey'], version: 3 }));
    open(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Replace API key' }));
    const input = screen.getByLabelText(/API key/, { selector: 'input' }) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    expect(input.autocomplete).toBe('new-password');
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: 'sk_rotated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(client.setPluginSettings).toHaveBeenCalledWith('com.example.seo', {
        values: { apiKey: 'sk_rotated' },
        expectedVersion: 3,
      }),
    );
  });

  it('clears a secret, and Undo takes the decision back', async () => {
    const client = fakeClient(view({ secretsSet: ['apiKey'] }));
    open(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear API key' }));
    expect(screen.getByText('Cleared on save')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep API key' }));
    expect(screen.getByText('Set')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty('disabled', true);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Replace API key' })),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear API key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(client.setPluginSettings).toHaveBeenCalledWith('com.example.seo', {
        values: { apiKey: null },
        expectedVersion: 0,
      }),
    );
  });

  it('saves a changed value and closes', async () => {
    const client = fakeClient(view());
    const onOpenChange = vi.fn();
    open(client, onOpenChange);
    fireEvent.change(await screen.findByLabelText('Site name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Strict mode' }));
    fireEvent.change(screen.getByLabelText('Tone'), { target: { value: 'formal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(client.setPluginSettings).toHaveBeenCalledWith('com.example.seo', {
      values: { site: 'Acme', strict: true, tone: 'formal' },
      expectedVersion: 0,
    });
    expect(await screen.findByText('SEO helper: settings saved')).toBeTruthy();
  });

  it('puts a 422 beside its field, marks it invalid and moves focus there', async () => {
    const client = fakeClient(view());
    client.setPluginSettings.mockRejectedValueOnce(
      unprocessable([{ field: 'maxLength', message: 'must be a number' }]),
    );
    const onOpenChange = vi.fn();
    open(client, onOpenChange);
    fireEvent.change(await screen.findByLabelText('Max length'), { target: { value: 'lots' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    const input = screen.getByLabelText('Max length');
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    const error = screen.getByText('must be a number');
    expect(input.getAttribute('aria-describedby')).toContain(error.id);
    expect(document.activeElement).toBe(input);
    expect(onOpenChange).not.toHaveBeenCalled();
    // Editing the field takes the refusal away.
    fireEvent.change(input, { target: { value: '40' } });
    expect(screen.queryByText('must be a number')).toBeNull();
  });

  it('puts a required secret’s refusal on its Set button', async () => {
    const client = fakeClient(view());
    client.setPluginSettings.mockRejectedValueOnce(
      unprocessable([{ field: 'apiKey', message: 'API key is required' }]),
    );
    open(client);
    fireEvent.change(await screen.findByLabelText('Site name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    const set = await screen.findByRole('button', { name: 'Set API key' });
    await waitFor(() => expect(set.getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText('API key is required')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(set));
  });

  it('offers a reload when someone else saved first', async () => {
    const client = fakeClient(view());
    client.setPluginSettings.mockRejectedValueOnce(
      new ApiError(409, 'conflict', { error: { code: 'conflict', message: 'changed' } }),
    );
    open(client);
    fireEvent.change(await screen.findByLabelText('Site name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('These settings changed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload settings' }));
    await waitFor(() => expect(client.getPluginSettings).toHaveBeenCalledTimes(2));
  });

  it('says a save with no answer may have landed, however the answer was lost', async () => {
    const client = fakeClient(view());
    client.setPluginSettings.mockRejectedValueOnce(new ApiError(503, 'unavailable'));
    open(client);
    fireEvent.change(await screen.findByLabelText('Site name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect((await screen.findByRole('alert')).textContent).toContain('didn’t confirm');
    expect(screen.queryByText('The settings weren’t saved')).toBeNull();
  });

  it('doesn’t blame someone else for a conflict its own lost save may have caused', async () => {
    const client = fakeClient(view());
    client.setPluginSettings
      .mockRejectedValueOnce(new RequestTimeoutError(true))
      .mockRejectedValueOnce(
        new ApiError(409, 'conflict', { error: { code: 'conflict', message: 'changed' } }),
      );
    open(client);
    fireEvent.change(await screen.findByLabelText('Site name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('These settings changed')).toBeTruthy();
    expect(screen.queryByText(/Someone saved/)).toBeNull();
    expect(screen.getByText(/your own save that didn’t confirm/)).toBeTruthy();
  });

  it('a refused retry doesn’t say the settings weren’t saved, and the question hedges', async () => {
    const client = fakeClient(view());
    client.setPluginSettings
      .mockRejectedValueOnce(new RequestTimeoutError(true))
      .mockRejectedValueOnce(new ApiError(400, 'bad'));
    open(client);
    fireEvent.change(await screen.findByLabelText('Site name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('This try was refused');
    expect(screen.queryByText('The settings weren’t saved')).toBeNull();
    // The form tells the sheet its save is over in an effect: until then leaving only waits.
    const ask = await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      return screen.getByRole('alertdialog', { name: /Discard/ });
    });
    expect(ask.textContent).toContain('may have gone through');
  });

  it('says a role without space:admin can’t, in place of a form', async () => {
    const client = fakeClient(view());
    client.getPluginSettings.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
    open(client);
    expect(await screen.findByText('Your role can’t manage plugin settings')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });

  it('says so when a plugin declares no settings', async () => {
    open(fakeClient(view({ fields: [], values: {} })));
    expect(await screen.findByText(/declares no settings/)).toBeTruthy();
  });
});
