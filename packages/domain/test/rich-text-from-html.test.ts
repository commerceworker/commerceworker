import { describe, expect, it } from 'vitest';
import {
  type RichTextNode,
  richTextFromHtml,
  richTextToPlainText,
  validateRichText,
} from '../src/index';

/** The tree without the bookkeeping, so a test reads as the structure it pins. */
function shape(node: RichTextNode): unknown {
  if (node.nodeType === 'text') {
    const marks = (node.marks ?? []).map((m) => m.type);
    return marks.length ? { text: node.value, marks } : node.value;
  }
  if (node.nodeType === 'embed') return { embed: node.data?.url, provider: node.data?.provider };
  const uri = node.data?.uri;
  return {
    [node.nodeType]: (node.content ?? []).map(shape),
    ...(typeof uri === 'string' ? { uri } : {}),
  };
}
const read = (html: string) => richTextFromHtml(html).content.map(shape);

describe('reading HTML as rich text', () => {
  it('maps paragraphs and headings', () => {
    expect(read('<h2>Title</h2><p>Body</p>')).toEqual([
      { 'heading-2': ['Title'] },
      { paragraph: ['Body'] },
    ]);
  });

  it('carries inline formatting as marks, nesting included', () => {
    expect(read('<p>a <strong>b <em>c</em></strong></p>')).toEqual([
      {
        paragraph: [
          'a ',
          { text: 'b ', marks: ['bold'] },
          { text: 'c', marks: ['bold', 'italic'] },
        ],
      },
    ]);
  });

  it('turns links into hyperlinks', () => {
    expect(read('<p>See <a href="https://x.test/a?b=1&amp;c=2">this</a></p>')).toEqual([
      { paragraph: ['See ', { hyperlink: ['this'], uri: 'https://x.test/a?b=1&c=2' }] },
    ]);
  });

  it('maps lists, and closes list items the source left open', () => {
    expect(read('<ul><li>one<li>two</ul><ol><li>three</li></ol>')).toEqual([
      {
        'unordered-list': [
          { 'list-item': [{ paragraph: ['one'] }] },
          { 'list-item': [{ paragraph: ['two'] }] },
        ],
      },
      { 'ordered-list': [{ 'list-item': [{ paragraph: ['three'] }] }] },
    ]);
  });

  it('keeps preformatted text exactly', () => {
    expect(read('<pre><code>if (a) {\n  b();\n}</code></pre>')).toEqual([
      { 'code-block': ['if (a) {\n  b();\n}'] },
    ]);
  });

  it('maps quotes and rules', () => {
    expect(read('<blockquote>Said.</blockquote><hr>')).toEqual([
      { blockquote: [{ paragraph: ['Said.'] }] },
      { hr: [] },
    ]);
  });

  it('ignores the block comments the WordPress editor writes', () => {
    const gutenberg =
      '<!-- wp:paragraph -->\n<p>One</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:paragraph -->\n<p>Two</p>\n<!-- /wp:paragraph -->';
    expect(read(gutenberg)).toEqual([{ paragraph: ['One'] }, { paragraph: ['Two'] }]);
  });

  it('reads blank-line-separated text as paragraphs, as WordPress renders it', () => {
    // The classic editor stores paragraphs with no tags at all.
    expect(read('First para\nsame para\n\nSecond <em>para</em>')).toEqual([
      { paragraph: ['First para', { 'hard-break': [] }, 'same para'] },
      { paragraph: ['Second ', { text: 'para', marks: ['italic'] }] },
    ]);
  });

  it('reads plain text as a paragraph', () => {
    expect(read('Just words.')).toEqual([{ paragraph: ['Just words.'] }]);
  });

  it('keeps an image as a link to it, rather than losing it', () => {
    // There is no asset to point an embed at yet; a link is visible and fixable.
    expect(
      read(
        '<figure><img src="https://x.test/cat.jpg" alt="A cat"><figcaption>Cat</figcaption></figure>',
      ),
    ).toEqual([
      { paragraph: [{ hyperlink: ['A cat'], uri: 'https://x.test/cat.jpg' }] },
      { paragraph: ['Cat'] },
    ]);
  });

  it('keeps the text of elements it does not know', () => {
    expect(read('<p><span class="x">kept</span> <mark>too</mark></p>')).toEqual([
      { paragraph: ['kept', ' ', 'too'] },
    ]);
  });

  it('drops scripts and styles with what is inside them', () => {
    expect(
      read('<p>a</p><script>alert(1)</script><style>p{}</style><SCRIPT>x</SCRIPT><p>b</p>'),
    ).toEqual([{ paragraph: ['a'] }, { paragraph: ['b'] }]);
  });

  it('decodes entities, and leaves an unknown one visible', () => {
    expect(read('<p>&ldquo;Hi&rdquo; &mdash; &#8217;&#x41; &bogus;</p>')).toEqual([
      { paragraph: ['“Hi” — ’A &bogus;'] },
    ]);
  });

  it('reads a "<" that starts no tag as text', () => {
    expect(read('<p>a < b</p>')).toEqual([{ paragraph: ['a < b'] }]);
  });

  it('survives nesting deep enough to overflow a naive reader', () => {
    const deep = `${'<div>'.repeat(100_000)}deep${'</div>'.repeat(100_000)}`;
    expect(richTextToPlainText(richTextFromHtml(deep))).toBe('deep');
  });

  it('keeps the text of a link whose scheme is not safe, but not the link', () => {
    // Imported HTML is someone else's; a hostile export must not become stored
    // script links that delivery clients render.
    const hostile =
      '<p><a href="javascript:alert(1)">a</a> <a href=" JaVa\tScRiPt:x">b</a> ' +
      '<a href="data:text/html,x">c</a> <a href="vbscript:x">d</a> <img src="javascript:x" alt="e"></p>';
    expect(read(hostile)).toEqual([{ paragraph: ['a', ' ', 'b', ' ', 'c', ' ', 'd', ' ', 'e'] }]);
  });

  it('keeps links with safe or no scheme', () => {
    const links = [
      'https://x.test',
      'mailto:a@x.test',
      'tel:+1555',
      '/relative',
      '#top',
      'page.html',
    ];
    const html = links.map((uri) => `<a href="${uri}">l</a>`).join(' ');
    const [paragraph] = richTextFromHtml(`<p>${html}</p>`).content;
    const uris = (paragraph?.content ?? [])
      .filter((n) => n.nodeType === 'hyperlink')
      .map((n) => n.data?.uri);
    expect(uris).toEqual(links);
  });

  it('reads an image inside a link as one link, not a link within a link', () => {
    // WordPress writes a linked thumbnail this way on nearly every gallery post.
    expect(
      read(
        '<p><a href="https://x.test/full.jpg"><img src="https://x.test/t.jpg" alt="Cat"></a></p>',
      ),
    ).toEqual([{ paragraph: [{ hyperlink: ['Cat'], uri: 'https://x.test/full.jpg' }] }]);
    expect(
      read('<p><a href="https://x.test/a">one <a href="https://x.test/b">two</a></a></p>'),
    ).toEqual([{ paragraph: [{ hyperlink: ['one ', 'two'], uri: 'https://x.test/a' }] }]);
  });

  it('refuses a scheme hidden behind an entity it does not decode', () => {
    // `&colon;` is a colon to a careless renderer; here it is not a link at all.
    expect(read('<p><a href="javascript&colon;alert(1)">x</a></p>')).toEqual([
      { paragraph: ['x'] },
    ]);
  });

  it('opens a link whose unquoted href ends in a slash', () => {
    expect(read('<p><a href=/about/>About</a> more</p>')).toEqual([
      { paragraph: [{ hyperlink: ['About'], uri: '/about/' }, ' more'] },
    ]);
  });

  it('keeps a video given by its source element as a link', () => {
    expect(read('<video controls><source src="https://x.test/v.mp4"></video>')).toEqual([
      { paragraph: [{ hyperlink: ['https://x.test/v.mp4'], uri: 'https://x.test/v.mp4' }] },
    ]);
  });

  it('drops a link with nothing in it', () => {
    expect(read('<p>a<a href="https://x.test"></a></p>')).toEqual([{ paragraph: ['a'] }]);
  });

  it('closes an open paragraph when the next one starts', () => {
    expect(read('<p>a<p>b')).toEqual([{ paragraph: ['a'] }, { paragraph: ['b'] }]);
  });

  it('closes open list items without escaping a nested list', () => {
    expect(read('<ul><li>a<ul><li>b<li>c</ul><li>d</ul>')).toEqual([
      {
        'unordered-list': [
          {
            'list-item': [
              { paragraph: ['a'] },
              {
                'unordered-list': [
                  { 'list-item': [{ paragraph: ['b'] }] },
                  { 'list-item': [{ paragraph: ['c'] }] },
                ],
              },
            ],
          },
          { 'list-item': [{ paragraph: ['d'] }] },
        ],
      },
    ]);
  });

  it('maps a table to rows of header and body cells, wrapping cell text in paragraphs', () => {
    expect(
      read(
        '<table><thead><tr><th>Plan</th><th>Price</th></tr></thead>' +
          '<tbody><tr><td>Starter</td><td><strong>$0</strong></td></tr></tbody>' +
          '<tfoot><tr><td>Total</td><td>$0</td></tr></tfoot></table>',
      ),
    ).toEqual([
      {
        table: [
          {
            'table-row': [
              { 'table-header-cell': [{ paragraph: ['Plan'] }] },
              { 'table-header-cell': [{ paragraph: ['Price'] }] },
            ],
          },
          {
            'table-row': [
              { 'table-cell': [{ paragraph: ['Starter'] }] },
              { 'table-cell': [{ paragraph: [{ text: '$0', marks: ['bold'] }] }] },
            ],
          },
          {
            'table-row': [
              { 'table-cell': [{ paragraph: ['Total'] }] },
              { 'table-cell': [{ paragraph: ['$0'] }] },
            ],
          },
        ],
      },
    ]);
  });

  it('reads a table whose rows, cells and sections are never closed', () => {
    // Legal HTML, and what older exports write: each part closes its open sibling.
    expect(read('<table><tbody><tr><td>a<td>b<tr><th>c<td><p>d</table><p>after')).toEqual([
      {
        table: [
          {
            'table-row': [
              { 'table-cell': [{ paragraph: ['a'] }] },
              { 'table-cell': [{ paragraph: ['b'] }] },
            ],
          },
          {
            'table-row': [
              { 'table-header-cell': [{ paragraph: ['c'] }] },
              { 'table-cell': [{ paragraph: ['d'] }] },
            ],
          },
        ],
      },
      { paragraph: ['after'] },
    ]);
  });

  it('keeps a table nested in a cell inside that cell', () => {
    expect(
      read(
        '<table><tr><td>outer<table><tr><td>inner</td></tr></table></td><td>next</td></tr></table>',
      ),
    ).toEqual([
      {
        table: [
          {
            'table-row': [
              {
                'table-cell': [
                  { paragraph: ['outer'] },
                  { table: [{ 'table-row': [{ 'table-cell': [{ paragraph: ['inner'] }] }] }] },
                ],
              },
              { 'table-cell': [{ paragraph: ['next'] }] },
            ],
          },
        ],
      },
    ]);
  });

  it('keeps a caption and stray text before the table, and gives an empty cell a paragraph', () => {
    const doc = richTextFromHtml(
      '<table><caption>Prices</caption>loose<colgroup><col></colgroup><tr><td></td><td colspan="2" rowspan=1>x</td></tr></table>',
    );
    expect(doc.content.map(shape)).toEqual([
      { paragraph: ['Prices'] },
      { paragraph: ['loose'] },
      {
        table: [
          {
            'table-row': [
              { 'table-cell': [{ paragraph: [''] }] },
              { 'table-cell': [{ paragraph: ['x'] }] },
            ],
          },
        ],
      },
    ]);
    // Only a real span is kept, as the editor's merged-cell attributes.
    const cells = doc.content[2]?.content?.[0]?.content;
    expect(cells?.map((c) => c.data)).toEqual([{}, { colspan: 2 }]);
  });

  it('reads a table with no cells, or past the bounds, as its text', () => {
    expect(read('<table><caption>Only a caption</caption></table>')).toEqual([
      { paragraph: ['Only a caption'] },
    ]);
    const wide = `<table><tr>${'<td>c</td>'.repeat(51)}</tr></table>`;
    const content = richTextFromHtml(wide).content;
    expect(content.some((n) => n.nodeType === 'table')).toBe(false);
    expect(richTextToPlainText(richTextFromHtml(wide))).toContain('c');
  });

  it('produces documents the field validator accepts', () => {
    const messy =
      '<h1>T</h1><p>a<p>b<ul><li>c</ul></p><table><tr><td>d</td></tr></table><img src=x.png>\n\ne' +
      '<table><caption>c</caption><tr><th>h<td><td colspan=99>x<tr></table>';
    expect(validateRichText(richTextFromHtml(messy))).toEqual([]);
  });

  it('produces an empty document from nothing', () => {
    expect(richTextFromHtml('')).toEqual({ nodeType: 'document', data: {}, content: [] });
    expect(richTextFromHtml('  <p> </p> ').content).toEqual([]);
  });
});

describe('reading provider embeds as embed nodes', () => {
  const youtube = { embed: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', provider: 'youtube' };

  it('reads a provider player iframe as an embed of its page, discarding the player', () => {
    expect(
      read(
        '<iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?si=x" allowfullscreen></iframe>',
      ),
    ).toEqual([youtube]);
    expect(read('<iframe src="//player.vimeo.com/video/76979871?h=abc"></iframe>')).toEqual([
      { embed: 'https://vimeo.com/76979871', provider: 'vimeo' },
    ]);
    expect(
      read('<iframe src="https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC"></iframe>'),
    ).toEqual([
      { embed: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', provider: 'spotify' },
    ]);
    expect(
      read(
        '<iframe src="https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fforss%2Fflickermood&auto_play=false"></iframe>',
      ),
    ).toEqual([{ embed: 'https://soundcloud.com/forss/flickermood', provider: 'soundcloud' }]);
    expect(
      read('<iframe src="https://mastodon.social/@Gargron/109554287435185383/embed"></iframe>'),
    ).toEqual([
      { embed: 'https://mastodon.social/@Gargron/109554287435185383', provider: 'mastodon' },
    ]);
  });

  it('lifts a player out of the paragraph it sits in, keeping the text around it', () => {
    expect(
      read('<p>Before <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe> after</p>'),
    ).toEqual([{ paragraph: ['Before'] }, youtube, { paragraph: ['after'] }]);
  });

  it('keeps an iframe from a provider that is not allowed as a link to it', () => {
    expect(read('<iframe src="https://evil.example/player/1"></iframe>')).toEqual([
      {
        paragraph: [
          { hyperlink: ['https://evil.example/player/1'], uri: 'https://evil.example/player/1' },
        ],
      },
    ]);
  });

  it("reads a provider's post blockquote as an embed of the post", () => {
    expect(
      read(
        '<blockquote class="twitter-tweet"><p lang="en">just setting up my <a href="https://twitter.com/hashtag/x">#x</a></p>&mdash; jack (@jack) <a href="https://twitter.com/jack/status/20?ref_src=twsrc">March 21, 2006</a></blockquote><script async src="https://platform.twitter.com/widgets.js"></script>',
      ),
    ).toEqual([{ embed: 'https://twitter.com/jack/status/20?ref_src=twsrc', provider: 'x' }]);
    expect(
      read(
        '<blockquote class="bluesky-embed" data-bluesky-uri="at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l"><p>Hello</p></blockquote>',
      ),
    ).toEqual([
      {
        embed: 'https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3l6oveex3ii2l',
        provider: 'bluesky',
      },
    ]);
  });

  it('keeps an ordinary blockquote, or a post quote with no post link, as a quote', () => {
    expect(read('<blockquote class="twitter-tweet"><p>No link</p></blockquote>')).toEqual([
      { blockquote: [{ paragraph: ['No link'] }] },
    ]);
  });

  it('reads a WordPress embed block, keeping its caption as prose', () => {
    const wxr = `<!-- wp:embed {"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","type":"video","providerNameSlug":"youtube"} -->
<figure class="wp-block-embed is-type-video is-provider-youtube wp-block-embed-youtube"><div class="wp-block-embed__wrapper">
https://www.youtube.com/watch?v=dQw4w9WgXcQ
</div><figcaption class="wp-element-caption">The video</figcaption></figure>
<!-- /wp:embed -->`;
    expect(read(wxr)).toEqual([youtube, { paragraph: ['The video'] }]);
  });

  it('reads a WordPress embed block for a provider that is not allowed as its text', () => {
    const html =
      '<figure class="wp-block-embed"><div class="wp-block-embed__wrapper">https://example.com/v/1</div></figure>';
    expect(read(html)).toEqual([{ paragraph: ['https://example.com/v/1'] }]);
  });

  it("reads a provider URL alone on its line, or in [embed], as WordPress's classic editor embeds it", () => {
    expect(
      read(
        'Intro\n\nhttp://youtu.be/dQw4w9WgXcQ\n\n[embed]https://vimeo.com/76979871[/embed]\n\nSee https://youtu.be/dQw4w9WgXcQ inline.',
      ),
    ).toEqual([
      { paragraph: ['Intro'] },
      { embed: 'https://youtu.be/dQw4w9WgXcQ', provider: 'youtube' },
      { embed: 'https://vimeo.com/76979871', provider: 'vimeo' },
      { paragraph: ['See https://youtu.be/dQw4w9WgXcQ inline.'] },
    ]);
    // Text before it in the same paragraph means it is part of a sentence.
    expect(read('<b>Watch</b> https://youtu.be/dQw4w9WgXcQ')).toEqual([
      { paragraph: [{ text: 'Watch', marks: ['bold'] }, ' https://youtu.be/dQw4w9WgXcQ'] },
    ]);
  });

  it('reads a long run of whitespace in linear time (no backtracking blow-up)', () => {
    const started = performance.now();
    expect(read(`${' '.repeat(200_000)}x`)).toEqual([{ paragraph: ['x'] }]);
    expect(read(`https://a${' '.repeat(200_000)}x`)).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('produces embeds the validator accepts, with nothing but url, provider and kind', () => {
    const value = richTextFromHtml(
      '<p><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="YouTube video player"></iframe></p>',
    );
    expect(validateRichText(value)).toEqual([]);
    expect(value.content).toEqual([
      {
        nodeType: 'embed',
        data: {
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          provider: 'youtube',
          kind: 'video',
        },
        content: [],
      },
    ]);
  });
});
