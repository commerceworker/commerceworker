import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance, type i18n as I18nInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageSwitcher } from './language-switcher';

const RESOURCES = {
  ui: {
    language: 'Language',
    languageName_en: 'English',
    languageName_es: 'Español',
  },
};

async function makeI18n(lng: string): Promise<I18nInstance> {
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng,
    fallbackLng: 'en',
    ns: ['ui'],
    defaultNS: 'ui',
    resources: { en: RESOURCES, es: RESOURCES },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

async function chooseSpanish() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Language' }));
  fireEvent.click(await screen.findByText('Español'));
}

describe('LanguageSwitcher', () => {
  afterEach(() => {
    // Vitest `globals` is off here, so RTL never registers its automatic cleanup.
    cleanup();
    vi.restoreAllMocks();
  });

  it('updates i18n language when Español is chosen', async () => {
    const i18n = await makeI18n('en');

    render(
      <I18nextProvider i18n={i18n}>
        <LanguageSwitcher />
      </I18nextProvider>,
    );

    await chooseSpanish();

    expect(i18n.language.startsWith('es')).toBe(true);
  });

  it('persists the choice to the locale cookie', async () => {
    const i18n = await makeI18n('en');

    render(
      <I18nextProvider i18n={i18n}>
        <LanguageSwitcher />
      </I18nextProvider>,
    );

    await chooseSpanish();

    expect(document.cookie).toContain('es');
  });

  it('navigates to the redirect path instead of switching in place', async () => {
    const i18n = await makeI18n('en');
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      pathname: '/catalog',
      search: '?page=2',
      hash: '#top',
      assign,
    } as unknown as Location);

    render(
      <I18nextProvider i18n={i18n}>
        <LanguageSwitcher redirectBasePath="/locale" />
      </I18nextProvider>,
    );

    await chooseSpanish();

    expect(assign).toHaveBeenCalledWith(
      `/locale?lng=es&next=${encodeURIComponent('/catalog?page=2#top')}`,
    );
    // The redirect owns the switch — no in-place language change.
    expect(i18n.language.startsWith('es')).toBe(false);
  });

  it('falls back to English when the active language is unsupported', async () => {
    const i18n = await makeI18n('zz');

    render(
      <I18nextProvider i18n={i18n}>
        <LanguageSwitcher />
      </I18nextProvider>,
    );

    // jest-dom matchers are not wired up in this package, so assert on textContent directly.
    expect(screen.getByRole('combobox', { name: 'Language' }).textContent).toContain('English');
  });
});
