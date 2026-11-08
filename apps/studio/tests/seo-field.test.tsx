// @vitest-environment jsdom
import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const ARTICLE: ContentType = {
  apiId: 'article',
  name: 'Article',
  displayField: 'name',
  urlPattern: '/blog/{slug}',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'name', name: 'Name' }),
    field({ apiId: 'seo', name: 'Search engines', type: 'Seo', position: 1 }),
  ],
};

function renderForm(initial = {}, onSave = vi.fn()) {
  render(
    <EntryForm
      contentType={ARTICLE}
      initial={initial}
      locales={['en-US']}
      defaultLocale="en-US"
      pickers={{ entries: [], assets: [{ id: 'img', label: 'Hero image' }] }}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
  return onSave;
}

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

describe('editing a Seo field', () => {
  it('has an input for each part, each described by what it is for', () => {
    renderForm();
    const title = screen.getByRole('textbox', { name: 'Title' });
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Canonical URL' })).toBeTruthy();
    const noindex = screen.getByRole('checkbox', { name: 'Hide from search engines' });
    const hint = (el: HTMLElement) =>
      document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent;
    expect(hint(title)).toBe('Search results show about 60 characters');
    expect(hint(noindex)).toBe('Leaves the page out of search results and the sitemap');
  });

  it('counts a title as it is typed', () => {
    renderForm();
    const title = screen.getByRole('textbox', { name: 'Title' });
    fireEvent.change(title, { target: { value: 'Hello | Blog' } });
    expect(screen.getByText('12 characters; search results show about 60')).toBeTruthy();
  });

  it('saves the parts as one object under the field', () => {
    const onSave = renderForm({ seo: { 'en-US': { description: 'Kept' } } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Hello' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide from search engines' }));
    save();
    expect(onSave.mock.calls[0]?.[0].seo).toEqual({
      'en-US': { title: 'Hello', description: 'Kept', noindex: true },
    });
  });

  it('shows a canonical URL the validator refuses, at the part', () => {
    const onSave = renderForm();
    fireEvent.change(screen.getByRole('textbox', { name: 'Canonical URL' }), {
      target: { value: 'javascript:alert(1)' },
    });
    save();
    expect(onSave).not.toHaveBeenCalled();
    const input = screen.getByRole('textbox', { name: 'Canonical URL' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = (input.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(described).toMatch(/absolute http\(s\) URL/);
  });
});

describe('previewing a Seo field', () => {
  it('lists its parts by name', () => {
    render(
      <EntryPreview
        contentType={ARTICLE}
        fields={{ seo: { 'en-US': { title: 'Hello | Blog', noindex: true } } }}
        locale="en-US"
        localeConfig={{ defaultLocale: 'en-US', locales: ['en-US'] }}
        pickers={{ entries: [], assets: [] }}
      />,
    );
    expect(screen.getByText('Hello | Blog')).toBeTruthy();
    expect(screen.getByText('Hide from search engines')).toBeTruthy();
  });
});
