/**
 * A hand-written space export (the JSON "space export" format), for the importer's tests. Every
 * name, id and URL in it is invented. It is built to exercise what goes wrong in real migrations:
 *
 * - three locales, one falling back to another (`fr-FR` → `de-DE` → `en-US`);
 * - a content type id that is not a legal apiId here (`landing-page`), a field type with no
 *   equivalent (`ResourceLink`), validations with and without one;
 * - references forward through the file and in a cycle (`post-hello` ⇄ `post-second`);
 * - rich text with headings, marks, lists, a table, a hyperlink, an entry hyperlink, embedded
 *   entries and assets, an embedded entry the export doesn't carry, and a resource node with no
 *   equivalent;
 * - published, changed (a newer draft on a published version), archived and draft entries;
 * - an entry missing a required field, one depending on it through a required link, and one
 *   repeating another's unique slug;
 * - assets with a file per locale, a document, and an upload never processed (no URL);
 * - tags, and editor interfaces with help text.
 *
 * A function, so each test gets its own copy to change.
 */
export function spaceExportFixture(): Record<string, unknown> {
  const link = (linkType: 'Entry' | 'Asset', id: string) => ({
    sys: { type: 'Link', linkType, id },
  });
  const text = (value: string, marks: string[] = []) => ({
    nodeType: 'text',
    value,
    marks: marks.map((type) => ({ type })),
    data: {},
  });
  const paragraph = (...content: unknown[]) => ({ nodeType: 'paragraph', data: {}, content });
  const cell = (nodeType: string, value: string) => ({
    nodeType,
    data: {},
    content: [paragraph(text(value))],
  });
  const published = (id: string, contentType: string, version = 2) => ({
    id,
    type: 'Entry',
    contentType: { sys: { type: 'Link', linkType: 'ContentType', id: contentType } },
    version,
    publishedVersion: version - 1,
    publishedAt: '2026-03-02T09:00:00.000Z',
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-02T09:00:00.000Z',
  });
  const draft = (id: string, contentType: string) => ({
    id,
    type: 'Entry',
    contentType: { sys: { type: 'Link', linkType: 'ContentType', id: contentType } },
    version: 1,
    createdAt: '2026-03-01T09:00:00.000Z',
    updatedAt: '2026-03-01T09:00:00.000Z',
  });

  return {
    locales: [
      { code: 'en-US', name: 'English (United States)', default: true, fallbackCode: null },
      { code: 'de-DE', name: 'German (Germany)', default: false, fallbackCode: 'en-US' },
      { code: 'fr-FR', name: 'French (France)', default: false, fallbackCode: 'de-DE' },
    ],
    tags: [
      { sys: { id: 'featured', type: 'Tag', visibility: 'public' }, name: 'Featured' },
      { sys: { id: 'engineering', type: 'Tag', visibility: 'private' }, name: 'Engineering' },
    ],
    contentTypes: [
      {
        sys: { id: 'author', type: 'ContentType', version: 3, publishedVersion: 2 },
        name: 'Author',
        displayField: 'name',
        fields: [
          {
            id: 'name',
            name: 'Name',
            type: 'Symbol',
            localized: false,
            required: true,
            validations: [{ unique: true }],
          },
          {
            id: 'bio',
            name: 'Bio',
            type: 'Text',
            localized: true,
            required: false,
            validations: [{ size: { max: 500 } }],
          },
          {
            id: 'avatar',
            name: 'Avatar',
            type: 'Link',
            linkType: 'Asset',
            localized: false,
            required: false,
            validations: [{ linkMimetypeGroup: ['image'] }, { assetFileSize: { max: 2097152 } }],
          },
          { id: 'location', name: 'Location', type: 'Location', localized: false, required: false },
        ],
      },
      {
        sys: { id: 'category', type: 'ContentType', version: 2, publishedVersion: 1 },
        name: 'Category',
        displayField: 'title',
        fields: [
          { id: 'title', name: 'Title', type: 'Symbol', localized: true, required: true },
          {
            id: 'slug',
            name: 'Slug',
            type: 'Symbol',
            localized: false,
            required: true,
            validations: [
              { unique: true },
              {
                regexp: { pattern: '^[a-z0-9-]+$' },
                message: 'Lowercase letters, digits and hyphens',
              },
            ],
          },
        ],
      },
      {
        sys: { id: 'blogPost', type: 'ContentType', version: 9, publishedVersion: 8 },
        name: 'Blog post',
        displayField: 'title',
        fields: [
          {
            id: 'title',
            name: 'Title',
            type: 'Symbol',
            localized: true,
            required: true,
            validations: [{ size: { min: 3, max: 120 } }],
          },
          {
            id: 'slug',
            name: 'Slug',
            type: 'Symbol',
            localized: false,
            required: true,
            validations: [{ unique: true }],
          },
          {
            id: 'body',
            name: 'Body',
            type: 'RichText',
            localized: true,
            required: false,
            validations: [
              { enabledMarks: ['bold', 'italic', 'code'] },
              { enabledNodeTypes: ['heading-2', 'table', 'embedded-entry-block'] },
            ],
          },
          {
            id: 'author',
            name: 'Author',
            type: 'Link',
            linkType: 'Entry',
            localized: false,
            required: false,
            validations: [{ linkContentType: ['author'] }],
          },
          {
            id: 'categories',
            name: 'Categories',
            type: 'Array',
            localized: false,
            required: false,
            items: {
              type: 'Link',
              linkType: 'Entry',
              validations: [{ linkContentType: ['category'] }],
            },
            validations: [{ size: { max: 3 } }],
          },
          {
            id: 'related',
            name: 'Related posts',
            type: 'Array',
            localized: false,
            required: false,
            items: { type: 'Link', linkType: 'Entry', validations: [] },
          },
          {
            id: 'keywords',
            name: 'Keywords',
            type: 'Array',
            localized: false,
            required: false,
            items: { type: 'Symbol', validations: [{ in: ['cms', 'migration', 'edge'] }] },
          },
          {
            id: 'publishDate',
            name: 'Publish date',
            type: 'Date',
            localized: false,
            required: false,
            validations: [{ dateRange: { min: '2020-01-01' } }],
          },
          {
            id: 'readingMinutes',
            name: 'Reading minutes',
            type: 'Integer',
            localized: false,
            required: false,
            validations: [{ range: { min: 1, max: 90 } }],
          },
          {
            id: 'featured',
            name: 'Featured',
            type: 'Boolean',
            localized: false,
            required: false,
            defaultValue: { 'en-US': false },
          },
          { id: 'seo', name: 'SEO', type: 'Object', localized: true, required: false },
          {
            id: 'heroImage',
            name: 'Hero image',
            type: 'Link',
            linkType: 'Asset',
            localized: false,
            required: false,
          },
          {
            id: 'sponsor',
            name: 'Sponsor',
            type: 'ResourceLink',
            localized: false,
            required: false,
            allowedResources: [],
          },
          {
            id: 'legacyBody',
            name: 'Legacy body',
            type: 'Text',
            localized: false,
            required: false,
            deleted: true,
          },
        ],
      },
      {
        sys: { id: 'landing-page', type: 'ContentType', version: 2, publishedVersion: 1 },
        name: 'Landing page',
        displayField: 'headline',
        fields: [
          { id: 'headline', name: 'Headline', type: 'Symbol', localized: false, required: true },
          {
            id: 'featuredPost',
            name: 'Featured post',
            type: 'Link',
            linkType: 'Entry',
            localized: false,
            required: true,
            validations: [{ linkContentType: ['blogPost'] }],
          },
        ],
      },
    ],
    editorInterfaces: [
      {
        sys: {
          id: 'default',
          contentType: { sys: { id: 'blogPost', type: 'Link', linkType: 'ContentType' } },
        },
        controls: [
          {
            fieldId: 'title',
            widgetId: 'singleLine',
            settings: { helpText: 'Keep it under 60 characters.' },
          },
          {
            fieldId: 'slug',
            widgetId: 'slugEditor',
            settings: { helpText: 'Generated from the title.' },
          },
          { fieldId: 'body', widgetId: 'richTextEditor' },
        ],
      },
    ],
    entries: [
      // Forward reference: links post-second, which comes later in the file, and the cycle back.
      {
        sys: published('post-hello', 'blogPost'),
        metadata: { tags: [{ sys: { type: 'Link', linkType: 'Tag', id: 'featured' } }] },
        fields: {
          title: { 'en-US': 'Hello, edge', 'de-DE': 'Hallo, Edge' },
          slug: { 'en-US': 'hello-edge' },
          author: { 'en-US': link('Entry', 'author-ada') },
          categories: { 'en-US': [link('Entry', 'cat-news'), link('Entry', 'cat-guides')] },
          related: { 'en-US': [link('Entry', 'post-second')] },
          keywords: { 'en-US': ['cms', 'edge'] },
          publishDate: { 'en-US': '2026-03-02T09:00:00.000Z' },
          readingMinutes: { 'en-US': 4 },
          featured: { 'en-US': true },
          seo: { 'en-US': { description: 'Running content at the edge', noindex: false } },
          heroImage: { 'en-US': link('Asset', 'asset-hero') },
          sponsor: {
            'en-US': {
              sys: { type: 'ResourceLink', linkType: 'Product', urn: 'urn:example:product:42' },
            },
          },
          body: {
            'en-US': {
              nodeType: 'document',
              data: {},
              content: [
                { nodeType: 'heading-2', data: {}, content: [text('Why the edge')] },
                paragraph(
                  text('Content is '),
                  text('structured', ['bold']),
                  text(', not '),
                  text('markup', ['italic', 'code']),
                  text('. Read the '),
                  {
                    nodeType: 'hyperlink',
                    data: { uri: 'https://example.com/guide' },
                    content: [text('guide')],
                  },
                  text(' or the '),
                  {
                    nodeType: 'entry-hyperlink',
                    data: { target: link('Entry', 'post-second') },
                    content: [text('follow-up')],
                  },
                  text('.'),
                ),
                {
                  nodeType: 'embedded-asset-block',
                  data: { target: link('Asset', 'asset-hero') },
                  content: [],
                },
                {
                  nodeType: 'unordered-list',
                  data: {},
                  content: [
                    { nodeType: 'list-item', data: {}, content: [paragraph(text('Typed fields'))] },
                    {
                      nodeType: 'list-item',
                      data: {},
                      content: [paragraph(text('Document trees'))],
                    },
                  ],
                },
                {
                  nodeType: 'table',
                  data: {},
                  content: [
                    {
                      nodeType: 'table-row',
                      data: {},
                      content: [
                        cell('table-header-cell', 'Region'),
                        cell('table-header-cell', 'Latency'),
                      ],
                    },
                    {
                      nodeType: 'table-row',
                      data: {},
                      content: [cell('table-cell', 'EU'), cell('table-cell', '12 ms')],
                    },
                  ],
                },
                {
                  nodeType: 'embedded-entry-block',
                  data: { target: link('Entry', 'author-ada') },
                  content: [],
                },
                // The export doesn't carry this entry: dropped, and reported.
                paragraph(text('See '), {
                  nodeType: 'embedded-entry-inline',
                  data: { target: link('Entry', 'post-gone') },
                  content: [],
                }),
                // A node type this platform has no equivalent for.
                {
                  nodeType: 'embedded-resource-block',
                  data: { target: { sys: { type: 'ResourceLink', urn: 'urn:example:video:7' } } },
                  content: [],
                },
                { nodeType: 'hr', data: {}, content: [] },
                paragraph(text('Thanks for reading.')),
              ],
            },
            'de-DE': {
              nodeType: 'document',
              data: {},
              content: [paragraph(text('Inhalt ist strukturiert.'))],
            },
          },
        },
      },
      // Changed: published at version 2, edited since (version 5). Links back (the cycle), and to
      // an author the export doesn't carry.
      {
        sys: { ...published('post-second', 'blogPost'), version: 5, publishedVersion: 2 },
        fields: {
          title: { 'en-US': 'The second post', 'fr-FR': 'Le deuxième article' },
          slug: { 'en-US': 'second-post' },
          author: { 'en-US': link('Entry', 'author-missing') },
          related: { 'en-US': [link('Entry', 'post-hello')] },
          body: {
            'en-US': {
              nodeType: 'document',
              data: {},
              content: [
                paragraph(
                  text('Back to '),
                  {
                    nodeType: 'entry-hyperlink',
                    data: { target: link('Entry', 'post-hello') },
                    content: [text('the first')],
                  },
                  text(', or '),
                  {
                    nodeType: 'asset-hyperlink',
                    data: { target: link('Asset', 'asset-doc') },
                    content: [text('the PDF')],
                  },
                  text('.'),
                ),
              ],
            },
          },
        },
      },
      {
        sys: published('author-ada', 'author'),
        fields: {
          name: { 'en-US': 'Ada Example' },
          bio: { 'en-US': 'Writes about edges.', 'de-DE': 'Schreibt über Kanten.' },
          avatar: { 'en-US': link('Asset', 'asset-avatar') },
          location: { 'en-US': { lat: 52.52, lon: 13.405 } },
        },
      },
      { sys: draft('author-grace', 'author'), fields: { name: { 'en-US': 'Grace Sample' } } },
      {
        sys: published('cat-news', 'category'),
        metadata: { tags: [{ sys: { type: 'Link', linkType: 'Tag', id: 'engineering' } }] },
        fields: { title: { 'en-US': 'News', 'de-DE': 'Neuigkeiten' }, slug: { 'en-US': 'news' } },
      },
      {
        sys: published('cat-guides', 'category'),
        fields: { title: { 'en-US': 'Guides' }, slug: { 'en-US': 'guides' } },
      },
      // Archived in the source.
      {
        sys: {
          ...draft('cat-old', 'category'),
          archivedVersion: 3,
          archivedAt: '2026-02-01T00:00:00.000Z',
        },
        fields: { title: { 'en-US': 'Old' }, slug: { 'en-US': 'old' } },
      },
      // Missing its required title: not imported.
      { sys: draft('post-untitled', 'blogPost'), fields: { slug: { 'en-US': 'untitled' } } },
      // Repeats post-hello's unique slug: not imported.
      {
        sys: draft('post-copy', 'blogPost'),
        fields: { title: { 'en-US': 'Hello again' }, slug: { 'en-US': 'hello-edge' } },
      },
      // Valid, under a renamed content type.
      {
        sys: published('landing-home', 'landing-page'),
        fields: {
          headline: { 'en-US': 'Welcome' },
          featuredPost: { 'en-US': link('Entry', 'post-hello') },
        },
      },
      // Its required link points at post-untitled, which is not imported: so neither is this one.
      {
        sys: draft('landing-broken', 'landing-page'),
        fields: {
          headline: { 'en-US': 'Broken' },
          featuredPost: { 'en-US': link('Entry', 'post-untitled') },
        },
      },
    ],
    assets: [
      {
        sys: { id: 'asset-hero', type: 'Asset', version: 3, publishedVersion: 2 },
        fields: {
          title: { 'en-US': 'Edge map', 'de-DE': 'Edge-Karte' },
          description: { 'en-US': 'Points of presence on a map' },
          file: {
            'en-US': {
              url: '//assets.example.com/space-a/asset-hero/edge-map.png',
              fileName: 'edge-map.png',
              contentType: 'image/png',
              details: { size: 2048, image: { width: 1200, height: 630 } },
            },
            'de-DE': {
              url: '//assets.example.com/space-a/asset-hero/edge-karte.png',
              fileName: 'edge-karte.png',
              contentType: 'image/png',
              details: { size: 2050, image: { width: 1200, height: 630 } },
            },
          },
        },
      },
      {
        sys: { id: 'asset-avatar', type: 'Asset', version: 2, publishedVersion: 1 },
        fields: {
          title: { 'en-US': 'Ada' },
          file: {
            'en-US': {
              url: 'https://assets.example.com/space-a/asset-avatar/ada.jpg',
              fileName: 'ada.jpg',
              contentType: 'image/jpeg',
              details: { size: 1024, image: { width: 256, height: 256 } },
            },
          },
        },
      },
      {
        sys: { id: 'asset-doc', type: 'Asset', version: 1 },
        fields: {
          title: { 'en-US': 'Whitepaper' },
          file: {
            'en-US': {
              url: '//assets.example.com/space-a/asset-doc/whitepaper.pdf',
              fileName: 'whitepaper.pdf',
              contentType: 'application/pdf',
              details: { size: 4096 },
            },
          },
        },
      },
      {
        sys: { id: 'asset-unprocessed', type: 'Asset', version: 1 },
        fields: {
          title: { 'en-US': 'Never processed' },
          file: {
            'en-US': {
              upload: 'https://upload.example.com/pending/123',
              fileName: 'raw.tiff',
              contentType: 'image/tiff',
            },
          },
        },
      },
    ],
  };
}
