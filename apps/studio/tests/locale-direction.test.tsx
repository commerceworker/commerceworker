// @vitest-environment jsdom
// A locale's text direction in the editor: its values are written in it (`dir` and `lang` on the
// inputs holding its words), while labels and the field's chrome stay the admin's. A locale
// Delivery doesn't serve says so on its tab.
import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EntryForm } from '~/cms/components/EntryForm';
import { EntryPreview } from '~/cms/components/EntryPreview';

afterEach(cleanup);

const field = (over: Partial<FieldDefinition>): FieldDefinition => ({
  apiId: 'x',
  name: 'X',
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
  ...over,
});

const NOTE: ContentType = {
  apiId: 'note',
  name: 'Note',
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'title', name: 'Title', localized: true }),
    field({ apiId: 'code', name: 'Code', position: 1 }),
  ],
};

const ARTICLE: ContentType = {
  ...NOTE,
  apiId: 'article',
  fields: [
    field({ apiId: 'title', name: 'Title', localized: true }),
    field({ apiId: 'summary', name: 'Summary', type: 'Text', localized: true, position: 1 }),
    field({ apiId: 'body', name: 'Body', type: 'RichText', localized: true, position: 2 }),
    field({ apiId: 'rank', name: 'Rank', type: 'Integer', localized: true, position: 3 }),
  ],
};

describe('EntryForm text direction', () => {
  it('writes each locale in its direction, and the shared fields in the default’s', () => {
    render(
      <EntryForm
        contentType={NOTE}
        initial={{ title: { en: 'Hello', ar: 'مرحبا' }, code: { en: 'A1' } }}
        locales={['en', 'ar']}
        defaultLocale="en"
        directions={{ en: 'ltr', ar: 'rtl' }}
        pickers={{ entries: [], assets: [] }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const dirOf = (value: string) =>
      screen.getByDisplayValue(value).closest('[dir]')?.getAttribute('dir');
    expect(dirOf('Hello')).toBe('ltr');
    expect(dirOf('A1')).toBe('ltr');
    expect(screen.getByDisplayValue('Hello').getAttribute('lang')).toBe('en');
    fireEvent.click(screen.getByRole('button', { name: 'ar' }));
    const arabic = screen.getByDisplayValue('مرحبا');
    expect(arabic.getAttribute('dir')).toBe('rtl');
    expect(arabic.getAttribute('lang')).toBe('ar');
    // On the input alone: the label and the field's chrome are the admin's, not the value's.
    expect(arabic.parentElement?.closest('[dir]')).toBeNull();
    expect(screen.getByText('Title').closest('[dir]')).toBeNull();
  });

  it('puts the direction on text and rich text content only, not on figures or the toolbar', () => {
    const { container } = render(
      <EntryForm
        contentType={ARTICLE}
        initial={{ title: { ar: 'مرحبا' }, summary: { ar: 'ملخص' }, rank: { ar: 3 } }}
        locales={['ar']}
        defaultLocale="ar"
        directions={{ ar: 'rtl' }}
        pickers={{ entries: [], assets: [] }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByDisplayValue('ملخص').getAttribute('dir')).toBe('rtl');
    expect(screen.getByDisplayValue('3').hasAttribute('dir')).toBe(false);
    const body = container.querySelector('[contenteditable="true"]') as HTMLElement;
    expect(body.getAttribute('dir')).toBe('rtl');
    expect(body.getAttribute('lang')).toBe('ar');
    // The editor's frame and toolbar read the admin's way.
    expect(container.querySelector('#field-body')?.closest('[dir]')).toBeNull();
  });

  it('says on its tab that Delivery doesn’t serve a locale, in words', () => {
    render(
      <EntryForm
        contentType={NOTE}
        initial={{ title: { en: 'Hello' } }}
        locales={['en', 'ar']}
        defaultLocale="en"
        delivered={{ en: true, ar: false }}
        pickers={{ entries: [], assets: [] }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'ar Not delivered' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'en (default)' })).toBeTruthy();
  });

  it('previews the draft in the form’s locale and its direction, captions the admin’s', () => {
    render(
      <EntryPreview
        contentType={NOTE}
        fields={{ title: { ar: 'مرحبا' }, code: { ar: 'A1' } }}
        locale="ar"
        localeConfig={{ defaultLocale: 'ar', locales: ['ar'] }}
        direction="rtl"
        pickers={{ entries: [], assets: [] }}
      />,
    );
    const title = screen.getByRole('heading', { name: 'مرحبا' });
    expect(title.getAttribute('dir')).toBe('rtl');
    expect(title.getAttribute('lang')).toBe('ar');
    expect(screen.getByText('Code').closest('[dir]')).toBeNull();
  });

  it('sets no direction while the space config hasn’t said', () => {
    render(
      <EntryForm
        contentType={NOTE}
        initial={{ title: { en: 'Hello' } }}
        locales={['en']}
        defaultLocale="en"
        pickers={{ entries: [], assets: [] }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByDisplayValue('Hello').closest('[dir]')).toBeNull();
  });
});
