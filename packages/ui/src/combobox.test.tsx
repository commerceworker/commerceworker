import { baseResources } from '@commerceworker/i18n';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Combobox } from './combobox';

const enUi = (baseResources.en as { ui: Record<string, string> }).ui;

/** Reads a shipped `ui` string, so a renamed or missing key fails here. */
function uiString(key: string): string {
  const value = enUi[key];
  if (!value) throw new Error(`Missing ui string: ${key}`);
  return value;
}

async function makeI18n(): Promise<I18nInstance> {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['ui'],
    defaultNS: 'ui',
    resources: baseResources,
    interpolation: { escapeValue: false },
  });
  return i18n;
}

afterEach(() => {
  cleanup();
});

describe('Combobox', () => {
  it('calls onValueChange when an option is chosen', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Combobox
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ]}
        value=""
        onValueChange={onValueChange}
        placeholder="Pick…"
      />,
    );

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Beta' }));

    expect(onValueChange).toHaveBeenCalledWith('b');
  });

  it('shows selected label when value matches an option', () => {
    render(
      <Combobox options={[{ value: 'x', label: 'Chosen' }]} value="x" onValueChange={vi.fn()} />,
    );

    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Chosen');
  });

  /**
   * The trigger renders a bare chevron. Without a name it reaches assistive
   * technology as an unlabelled button, on every call site of this primitive.
   * ComboboxClear is named too, but the composed Combobox never renders it —
   * only callers composing the primitives directly reach that one.
   */
  it('names the icon-only trigger', async () => {
    const i18n = await makeI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <Combobox options={[{ value: 'a', label: 'Alpha' }]} value="" onValueChange={vi.fn()} />
      </I18nextProvider>,
    );

    expect(screen.getByRole('button', { name: uiString('comboboxTrigger') })).toBeTruthy();
  });

  it('gives every rendered control an accessible name', async () => {
    const i18n = await makeI18n();
    render(
      <I18nextProvider i18n={i18n}>
        <Combobox options={[{ value: 'a', label: 'Alpha' }]} value="a" onValueChange={vi.fn()} />
      </I18nextProvider>,
    );

    for (const button of screen.getAllByRole('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '';
      expect(name).not.toBe('');
    }
  });
});
