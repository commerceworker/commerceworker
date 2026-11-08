// @vitest-environment jsdom
import type { ContentType, FieldDefinition } from '@commerceworker/domain';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntryForm } from '~/cms/components/EntryForm';

// jsdom has no layout, so it has no scrollIntoView; every real browser does.
Element.prototype.scrollIntoView ??= () => {};

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
  displayField: 'title',
  version: 1,
  status: 'published',
  fields: [
    field({ apiId: 'title', name: 'Title' }),
    field({ apiId: 'summary', name: 'Summary', type: 'Text', position: 1, localized: true }),
  ],
};

function renderForm(focusField?: { apiId: string; locale?: string }) {
  render(
    <EntryForm
      contentType={ARTICLE}
      initial={{}}
      locales={['en-US', 'de-DE']}
      defaultLocale="en-US"
      pickers={{ entries: [], assets: [] }}
      focusField={focusField}
      onSave={vi.fn()}
      onCancel={() => {}}
    />,
  );
}

describe('arriving from an inline-edit link', () => {
  it('focuses the field the link came from', () => {
    // The point of clicking a heading on a previewed page is to land on that
    // heading's field, not at the top of a form with twenty others.
    renderForm({ apiId: 'summary', locale: 'en-US' });
    expect(document.activeElement).toBe(screen.getByLabelText(/^Summary/));
  });

  it('opens on the locale that was being previewed', () => {
    renderForm({ apiId: 'summary', locale: 'de-DE' });
    // A German page's heading must not open the English field: the edit would
    // land in the wrong locale and look like it worked.
    expect(screen.getByLabelText(/^Summary/)).toBe(document.activeElement);
    // The field's own label says which locale it is editing.
    expect(document.getElementById('field-summary-label')?.textContent).toContain('de-DE');
  });

  it('ignores a locale the space does not have', () => {
    renderForm({ apiId: 'title', locale: 'fr-FR' });
    expect(screen.getByLabelText(/^Title/)).toBe(document.activeElement);
  });

  it('leaves focus alone without a link', () => {
    renderForm();
    expect(document.activeElement).toBe(document.body);
  });
});
