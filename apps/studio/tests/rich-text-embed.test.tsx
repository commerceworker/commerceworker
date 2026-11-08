// @vitest-environment jsdom
// External media in the rich-text editor: a provider URL pasted on an empty line, or given to the
// toolbar's embed row, goes in at once as a card (never the provider's player), and the api's
// resolve fills in its title and author. A provider that doesn't answer leaves the bare node,
// which is still a document the domain accepts.
import type { ContentType, EmbedData, RichTextDocument } from '@commerceworker/domain';
import { validateRichText } from '@commerceworker/domain';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryPreview } from '~/cms/components/EntryPreview';
import { RichTextEditor } from '~/cms/components/RichTextEditor';

const resolveEmbed = vi.fn<(url: string) => Promise<{ embed: EmbedData; resolved: boolean }>>();

vi.mock('~/cms/lib/client-context', () => ({
  useOptionalClient: () => ({ client: { resolveEmbed } }),
}));

const PICKERS = { entries: [], assets: [] };
const VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const RESOLVED: EmbedData = {
  url: VIDEO,
  provider: 'youtube',
  kind: 'video',
  title: 'Never Gonna Give You Up',
  authorName: 'Rick Astley',
  thumbnail: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', width: 480, height: 360 },
  width: 200,
  height: 113,
  aspectRatio: 1.7699,
};

function mount(value?: unknown) {
  const onChange = vi.fn<(doc: RichTextDocument | undefined) => void>();
  const view = render(<RichTextEditor value={value} pickers={PICKERS} onChange={onChange} />);
  const last = () => onChange.mock.lastCall?.[0];
  return { onChange, last, view };
}

/** Pastes plain text into the editor, as a browser's paste event carries it. */
async function paste(text: string) {
  const editable = screen.getByRole('textbox');
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/plain' ? text : ''),
      types: ['text/plain'],
    },
  });
  await act(async () => {
    editable.dispatchEvent(event);
  });
}

beforeEach(() => {
  resolveEmbed.mockReset();
});
afterEach(cleanup);

describe('rich-text external embeds', () => {
  it('turns a provider URL pasted on an empty line into an embed, then fills its metadata', async () => {
    resolveEmbed.mockResolvedValue({ embed: RESOLVED, resolved: true });
    const { last } = mount();

    await paste(VIDEO);

    expect(resolveEmbed).toHaveBeenCalledWith(VIDEO);
    await waitFor(() => expect(last()?.content[0]?.data).toEqual(RESOLVED));
    expect(last()?.content[0]).toEqual({ nodeType: 'embed', data: RESOLVED, content: [] });
    expect(validateRichText(last())).toEqual([]);
    // A card, not a player: no frame of the provider's is ever loaded.
    const card = await screen.findByTestId('embed-external');
    expect(card.textContent).toContain('Never Gonna Give You Up');
    expect(card.textContent).toContain('YouTube · Rick Astley');
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open on YouTube' }).getAttribute('rel')).toBe(
      'noopener noreferrer',
    );
  });

  it('keeps the bare embed, still valid, when the provider does not answer', async () => {
    resolveEmbed.mockRejectedValue(new Error('422'));
    const { last } = mount();

    await paste('https://vimeo.com/76979871');

    await waitFor(() => expect(resolveEmbed).toHaveBeenCalled());
    // The cursor's empty paragraph after the card rides along, as after any inserted block.
    expect(last()?.content[0]).toEqual({
      nodeType: 'embed',
      data: { url: 'https://vimeo.com/76979871', provider: 'vimeo', kind: 'video' },
      content: [],
    });
    expect(validateRichText(last())).toEqual([]);
    expect(screen.getByTestId('embed-external').textContent).toContain(
      'https://vimeo.com/76979871',
    );
  });

  it('leaves a URL from a provider that is not allowed as pasted text', async () => {
    const { last } = mount();
    await paste('https://example.com/videos/1');
    expect(resolveEmbed).not.toHaveBeenCalled();
    expect(screen.queryByTestId('embed-external')).toBeNull();
    expect(JSON.stringify(last() ?? {})).not.toContain('"embed"');
  });

  it('inserts an embed from the toolbar row, which only accepts an allowed URL', async () => {
    resolveEmbed.mockResolvedValue({ embed: RESOLVED, resolved: true });
    const { last } = mount();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Embed media' }));
    });
    const field = screen.getByRole('textbox', { name: 'Media URL' });
    const button = screen.getByRole('button', { name: 'Embed' }) as HTMLButtonElement;
    fireEvent.change(field, { target: { value: 'http://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(field, { target: { value: VIDEO } });
    expect(button.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(last()?.content[0]?.data).toEqual(RESOLVED));
    expect(screen.queryByRole('textbox', { name: 'Media URL' })).toBeNull();
  });

  it('shows a stored embed as a card when the editor opens', () => {
    mount({ nodeType: 'document', content: [{ nodeType: 'embed', data: RESOLVED, content: [] }] });
    expect(screen.getByTestId('embed-external').textContent).toContain('Never Gonna Give You Up');
  });
});

describe('previewing external embeds', () => {
  const ARTICLE: ContentType = {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    version: 1,
    status: 'published',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
      {
        apiId: 'body',
        name: 'Body',
        type: 'RichText',
        localized: false,
        required: false,
        position: 1,
      },
    ],
  };
  const preview = (data: Record<string, unknown>) =>
    render(
      <EntryPreview
        contentType={ARTICLE}
        fields={{
          title: { 'en-US': 'Post' },
          body: {
            'en-US': { nodeType: 'document', content: [{ nodeType: 'embed', data, content: [] }] },
          },
        }}
        locale="en-US"
        localeConfig={{ defaultLocale: 'en-US', locales: ['en-US'] }}
        pickers={{ entries: [], assets: [] }}
      />,
    );

  it('draws an embed as a card that links out to its page in a new tab', () => {
    preview({ ...RESOLVED });
    const link = screen.getByRole('link', { name: 'Open on YouTube' });
    expect(link.getAttribute('href')).toBe(VIDEO);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText('Never Gonna Give You Up')).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('gives an embed the domain would refuse no link at all', () => {
    preview({ url: 'javascript:alert(1)', provider: 'youtube' });
    expect(screen.queryByRole('link')).toBeNull();
  });
});
