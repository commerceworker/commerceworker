import { describe, expect, it } from 'vitest';
import {
  excerpt,
  type RichTextDocument,
  type RichTextNode,
  safeLinkUri,
  toHtml,
  toMarkdown,
  toPlainText,
} from '../src/index.js';

const t = (value: string, ...marks: string[]): RichTextNode => ({
  nodeType: 'text',
  value,
  marks: marks.map((type) => ({ type })),
});
const p = (...content: RichTextNode[]): RichTextNode => ({ nodeType: 'paragraph', content });
const doc = (...content: RichTextNode[]): RichTextDocument => ({ nodeType: 'document', content });
const link = (uri: string, ...content: RichTextNode[]): RichTextNode => ({
  nodeType: 'hyperlink',
  data: { uri },
  content,
});

describe('toHtml', () => {
  it('escapes text and applies marks', () => {
    expect(toHtml(doc(p(t('<b>&"', 'bold', 'italic'))))).toBe(
      '<p><em><strong>&lt;b&gt;&amp;&quot;</strong></em></p>',
    );
  });

  it('renders headings, lists, quotes, code, rules and tables', () => {
    const html = toHtml(
      doc(
        { nodeType: 'heading-2', content: [t('Title')] },
        { nodeType: 'unordered-list', content: [{ nodeType: 'list-item', content: [p(t('a'))] }] },
        { nodeType: 'blockquote', content: [p(t('q'))] },
        { nodeType: 'code-block', content: [t('x < y')] },
        { nodeType: 'hr' },
        {
          nodeType: 'table',
          content: [
            {
              nodeType: 'table-row',
              content: [{ nodeType: 'table-header-cell', content: [p(t('h'))] }],
            },
            { nodeType: 'table-row', content: [{ nodeType: 'table-cell', content: [p(t('c'))] }] },
          ],
        },
      ),
    );
    expect(html).toBe(
      '<h2>Title</h2><ul><li><p>a</p></li></ul><blockquote><p>q</p></blockquote><pre><code>x &lt; y</code></pre><hr><table><tr><th><p>h</p></th></tr><tr><td><p>c</p></td></tr></table>',
    );
  });

  it('only emits safe link URLs, read the way browsers read them', () => {
    for (const bad of [
      'javascript:alert(1)',
      'java\tscript:alert(1)',
      ' JAVASCRIPT:x',
      'javascript&colon;x',
      'data:text/html,x',
      'vbscript:x',
    ]) {
      expect(toHtml(doc(p(link(bad, t('x')))))).toBe('<p>x</p>');
      expect(safeLinkUri(bad)).toBeUndefined();
    }
    expect(toHtml(doc(p(link('https://a.example/?q="1"', t('x')))))).toBe(
      '<p><a href="https://a.example/?q=&quot;1&quot;">x</a></p>',
    );
    expect(safeLinkUri('/about')).toBe('/about');
    expect(safeLinkUri('mailto:a@b.example')).toBe('mailto:a@b.example');
  });

  it('links entries through entryHref, and renders their text without one', () => {
    const node: RichTextNode = {
      nodeType: 'entry-hyperlink',
      data: { target: { id: 'e1', contentType: 'page', fields: { slug: 'about' } } },
      content: [t('About')],
    };
    expect(toHtml(doc(p(node)))).toBe('<p>About</p>');
    expect(toHtml(doc(p(node)), { entryHref: (e) => `/${e.fields?.slug}` })).toBe(
      '<p><a href="/about">About</a></p>',
    );
  });

  it('renders embedded assets responsively and leaves embedded entries to the app', () => {
    const asset = {
      id: 'a1',
      url: 'https://media.example/a1/o/a.jpg',
      altText: 'A "cat"',
      width: 2400,
      height: 1200,
      srcset: [
        { width: 640, url: 'https://media.example/a1/w640/a.jpg' },
        { width: 1280, url: 'https://media.example/a1/w1280/a.jpg' },
      ],
    };
    expect(
      toHtml(doc({ nodeType: 'embedded-asset-block', data: { target: asset } }), {
        imageSizes: '50vw',
      }),
    ).toBe(
      '<figure><img src="https://media.example/a1/o/a.jpg" srcset="https://media.example/a1/w640/a.jpg 640w, https://media.example/a1/w1280/a.jpg 1280w" sizes="50vw" width="2400" height="1200" alt="A &quot;cat&quot;" loading="lazy" decoding="async"></figure>',
    );
    const entry = {
      nodeType: 'embedded-entry-block',
      data: { target: { id: 'e1', contentType: 'cta', fields: {} } },
    };
    expect(toHtml(doc(entry))).toBe('');
    expect(
      toHtml(doc(entry), {
        renderEntry: (e, { inline }) => `<aside>${e.contentType}:${inline}</aside>`,
      }),
    ).toBe('<aside>cta:false</aside>');
    // A stub (Delivery couldn't embed the target) renders nothing rather than a broken image.
    expect(
      toHtml(
        doc({
          nodeType: 'embedded-asset-block',
          data: { target: { id: 'a2', linkType: 'Asset' } },
        }),
      ),
    ).toBe('');
  });

  it('renders third-party embeds as a safe link unless the app renders them', () => {
    expect(
      toHtml(
        doc({
          nodeType: 'embed',
          data: { url: 'https://www.youtube.com/watch?v=x', title: 'Demo' },
        }),
      ),
    ).toBe('<p><a href="https://www.youtube.com/watch?v=x">Demo</a></p>');
  });

  it('lets an app override nodes and marks, falling back to the default', () => {
    // A site rule: a paragraph holding only a bold link is a button.
    const html = toHtml(doc(p(link('/go', t('Go', 'bold'))), p(t('plain'))), {
      nodes: {
        paragraph: (n, next) => {
          const only = n.content?.length === 1 ? n.content[0] : undefined;
          return only?.nodeType === 'hyperlink' ? `<p class="cta">${next()}</p>` : undefined;
        },
      },
      marks: { bold: (h) => `<b>${h}</b>` },
    });
    expect(html).toBe('<p class="cta"><a href="/go"><b>Go</b></a></p><p>plain</p>');
  });

  it('renders unknown nodes as their children and ignores bad input', () => {
    expect(toHtml(doc({ nodeType: 'future-thing', content: [t('kept')] }))).toBe('kept');
    expect(toHtml(null)).toBe('');
    expect(toHtml({ nodeType: 'paragraph' } as unknown as RichTextDocument)).toBe('');
  });
});

describe('toMarkdown', () => {
  it('renders the same document as CommonMark, escaping text', () => {
    const md = toMarkdown(
      doc(
        { nodeType: 'heading-2', content: [t('Why')] },
        p(t('Use '), t('edge', 'bold'), t(' *now*'), t(' code', 'code')),
        {
          nodeType: 'unordered-list',
          content: [
            { nodeType: 'list-item', content: [p(t('Fast'))] },
            { nodeType: 'list-item', content: [p(t('Cheap'))] },
          ],
        },
        p(link('https://x.example/a b)', t('link'))),
        { nodeType: 'code-block', content: [t('a ``` b')] },
      ),
    );
    expect(md).toBe(
      '## Why\n\nUse **edge** \\*now\\*` code`\n\n- Fast\n- Cheap\n\n[link](https://x.example/a%20b%29)\n\n````\na ``` b\n````',
    );
  });

  it('drops unsafe links, and uses entryHref for entries', () => {
    expect(toMarkdown(doc(p(link('javascript:x', t('x')))))).toBe('x');
    const node: RichTextNode = {
      nodeType: 'entry-hyperlink',
      data: { target: { id: 'e', fields: { slug: 's' } } },
      content: [t('S')],
    };
    expect(toMarkdown(doc(p(node)), { entryHref: () => 'https://site.example/s' })).toBe(
      '[S](https://site.example/s)',
    );
  });

  it('renders tables with escaped cells', () => {
    const cell = (s: string): RichTextNode => ({ nodeType: 'table-cell', content: [p(t(s))] });
    const md = toMarkdown(
      doc({
        nodeType: 'table',
        content: [
          { nodeType: 'table-row', content: [cell('h|1')] },
          { nodeType: 'table-row', content: [cell('v')] },
        ],
      }),
    );
    expect(md).toBe('| h\\|1 |\n| --- |\n| v |');
  });
});

describe('toPlainText and excerpt', () => {
  it('returns text with blocks on their own lines', () => {
    expect(toPlainText(doc(p(t('One '), t('two', 'bold')), p(t('Three'))))).toBe('One two\nThree');
  });

  it('excerpts the first paragraph on a word boundary', () => {
    expect(excerpt(doc(p(t('')), p(t('word '.repeat(50)))), 30)).toMatch(/^word( word)*…$/);
    expect(excerpt(doc(p(t('word '.repeat(50)))), 30).length).toBeLessThanOrEqual(30);
  });
});
