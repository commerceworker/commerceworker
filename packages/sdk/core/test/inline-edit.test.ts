// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminEditUrl,
  type ContentRef,
  createDeliveryClient,
  formatContentRef,
  parseContentRef,
} from '../src/index.js';
import { mountInlineEditor } from '../src/inline-edit.js';

const ref: ContentRef = {
  space: 's1',
  environment: 'main',
  entryId: 'e1',
  contentType: 'article',
  field: 'title',
  locale: 'en-US',
};

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'tok' };

describe('content refs', () => {
  it('round-trips', () => {
    expect(parseContentRef(formatContentRef(ref))).toEqual(ref);
  });

  it('survives a part containing the separator', () => {
    // Otherwise a crafted apiId shifts every following part by one and the ref
    // silently addresses a different field instead of failing.
    const odd = { ...ref, field: 'we|ird' };
    expect(parseContentRef(formatContentRef(odd))).toEqual(odd);
  });

  it('rejects anything that is not a ref', () => {
    expect(parseContentRef('')).toBeUndefined();
    expect(parseContentRef(null)).toBeUndefined();
    expect(parseContentRef('s1|main|e1')).toBeUndefined();
    expect(parseContentRef('s1|main|e1|article||en-US')).toBeUndefined();
  });

  it('builds an admin URL carrying the field, locale and scope', () => {
    const url = new URL(adminEditUrl('https://admin.test/', ref));
    expect(url.pathname).toBe('/content/article/e1');
    expect(url.searchParams.get('field')).toBe('title');
    expect(url.searchParams.get('locale')).toBe('en-US');
    expect(url.searchParams.get('space')).toBe('s1');
    expect(url.searchParams.get('env')).toBe('main');
  });
});

describe('editable()', () => {
  const entry = { id: 'e1', contentType: 'article' };

  it('emits nothing outside preview', () => {
    // The same component ships to production; edit metadata discloses entry
    // ids, field names, and that there is a CMS to go looking for.
    expect(createDeliveryClient(base).editable(entry, 'title')).toEqual({});
  });

  it('emits a ref in preview', () => {
    const client = createDeliveryClient({ ...base, preview: true, locale: 'en-US' });
    expect(parseContentRef(client.editable(entry, 'title')['data-cw-ref'])).toEqual(ref);
  });

  it('reads the preview API rather than delivery', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await createDeliveryClient({ ...base, preview: true, fetch: fetchImpl }).getEntry('e1');
    expect(seen[0]).toContain('/preview/s1/main/entries/e1');
  });
});

describe('the overlay', () => {
  let destroy: (() => void) | undefined;
  afterEach(() => {
    destroy?.();
    destroy = undefined;
    document.body.innerHTML = '';
  });

  const page = () => {
    document.body.innerHTML = `
      <a href="/next" id="link">
        <h1 id="heading" data-cw-ref="${formatContentRef(ref)}">Hello</h1>
      </a>
      <p id="plain">Not editable</p>`;
    return document.getElementById('heading') as HTMLElement;
  };

  it('refuses to mount with nowhere to send a click', () => {
    // An overlay that highlights and then does nothing reads as broken, not as
    // unconfigured.
    expect(() => mountInlineEditor({})).toThrow(/adminUrl or an onEdit/);
  });

  it('ignores clicks until editing is switched on', () => {
    page();
    const onEdit = vi.fn();
    const editor = mountInlineEditor({ onEdit });
    destroy = editor.destroy;
    document.getElementById('heading')?.click();
    // A previewed page is still a page: following its links has to keep working.
    expect(onEdit).not.toHaveBeenCalled();
    expect(editor.enabled).toBe(false);
  });

  it('opens the field that was clicked once switched on', () => {
    page();
    const onEdit = vi.fn();
    const editor = mountInlineEditor({ onEdit, defaultEnabled: true });
    destroy = editor.destroy;
    document.getElementById('heading')?.click();
    expect(onEdit).toHaveBeenCalledWith(ref);
  });

  it('claims the click, so the surrounding link does not also follow', () => {
    page();
    const followed = vi.fn((e: Event) => e.preventDefault());
    document.getElementById('link')?.addEventListener('click', followed);
    const editor = mountInlineEditor({ onEdit: vi.fn(), defaultEnabled: true });
    destroy = editor.destroy;
    document.getElementById('heading')?.click();
    expect(followed).not.toHaveBeenCalled();
  });

  it('leaves unmarked parts of the page alone', () => {
    page();
    const onEdit = vi.fn();
    const editor = mountInlineEditor({ onEdit, defaultEnabled: true });
    destroy = editor.destroy;
    document.getElementById('plain')?.click();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('names the field it is highlighting', () => {
    const heading = page();
    const editor = mountInlineEditor({ onEdit: vi.fn(), defaultEnabled: true });
    destroy = editor.destroy;
    heading.dispatchEvent(new Event('pointerover', { bubbles: true }));
    const outline = document.querySelector('.cw-ie-outline') as HTMLElement;
    expect(outline.hidden).toBe(false);
    expect(outline.textContent).toBe('title');
  });

  it('stops highlighting when switched back off', () => {
    const heading = page();
    const editor = mountInlineEditor({ onEdit: vi.fn(), defaultEnabled: true });
    destroy = editor.destroy;
    heading.dispatchEvent(new Event('pointerover', { bubbles: true }));
    editor.setEnabled(false);
    expect((document.querySelector('.cw-ie-outline') as HTMLElement).hidden).toBe(true);
  });

  it('offers a labelled toggle that reports its state', () => {
    page();
    const editor = mountInlineEditor({ onEdit: vi.fn() });
    destroy = editor.destroy;
    const toggle = document.querySelector('.cw-ie-toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click();
    expect(editor.enabled).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('takes itself off the page entirely', () => {
    page();
    const onEdit = vi.fn();
    mountInlineEditor({ onEdit, defaultEnabled: true }).destroy();
    document.getElementById('heading')?.click();
    // Listeners as well as nodes: an unmounted overlay that still swallows
    // clicks would break the page it was meant to help edit.
    expect(onEdit).not.toHaveBeenCalled();
    expect(document.querySelector('.cw-ie-outline')).toBeNull();
    expect(document.querySelector('.cw-ie-toggle')).toBeNull();
  });
});
