import type { ImportSource, SourceReadResult, SourceRecord } from '@commerceworker/ports';
import { identify, MAX_PAYLOAD_BYTES, tooLarge } from './shared';
import { child, childText, parseXml, type XmlElement } from './xml';

/**
 * Reads a WordPress export (WXR — "Tools → Export" in the WordPress admin).
 *
 * A WXR file is RSS with a `wp:` namespace: one `<item>` per post, page,
 * attachment, menu item and revision, all in one list. A mapping targets one
 * content type, so the source picks one kind of item (`postType`, default
 * `post`) and *names* everything else it passed over — an export where the
 * pages silently did not come across is the failure this guards against.
 *
 * Values are flattened to plain fields (`title`, `slug`, `content`, …) so the
 * mapping screen can offer them like any spreadsheet column. `content` is the
 * post's HTML exactly as stored; mapped to a RichText field, the pipeline
 * converts it.
 */

export interface WxrSourceOptions {
  /**
   * Which `wp:post_type` to read: `post` (the default), `page`, `attachment`,
   * a custom post type, or several at once.
   */
  readonly postType?: string | readonly string[];
  /**
   * Which `wp:status` values to read. Defaults to every status except
   * `auto-draft` (an editor that was opened and abandoned) and `trash`.
   */
  readonly statuses?: readonly string[];
  /** Field holding each record's identity. Defaults to `id`, the WordPress post id. */
  readonly identityField?: string;
}

/** Statuses that are never content anyone meant to keep. */
const SKIPPED_BY_DEFAULT = new Set(['auto-draft', 'trash']);

/**
 * Meta keys WordPress writes for its own bookkeeping.
 *
 * Other underscore keys are kept: plugins store real content that way (an SEO
 * plugin's description, say), and the import report lists unmapped fields, so
 * an operator sees them and chooses. These ones are never anyone's content.
 */
const INTERNAL_META = new Set([
  '_edit_lock',
  '_edit_last',
  '_encloseme',
  '_pingme',
  '_thumbnail_id',
  '_wp_attached_file',
  '_wp_attachment_metadata',
  '_wp_desired_post_slug',
  '_wp_old_date',
  '_wp_old_slug',
  '_wp_page_template',
  '_wp_trash_meta_status',
  '_wp_trash_meta_time',
]);

/** Fields every record carries, in the order a mapping screen offers them. */
const BASE_FIELDS = [
  'id',
  'title',
  'slug',
  'content',
  'excerpt',
  'status',
  'date',
  'modified',
  'author',
  'authorName',
  'link',
  'parentId',
  'menuOrder',
  'sticky',
  'categories',
  'tags',
  'featuredImage',
] as const;

export function createWxrImportSource(): ImportSource {
  return {
    id: 'wxr',
    name: 'WordPress (WXR)',
    async read(payload, options): Promise<SourceReadResult> {
      if (tooLarge(payload)) throw new Error(`Payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
      const opts = readOptions(options);

      const root = parseXml(payload);
      const channel = root.name === 'rss' ? child(root, 'channel') : undefined;
      // An RSS feed is not an export: it has no post ids or statuses, so
      // importing one would "work" and produce entries nobody could re-run.
      if (!channel || !child(channel, 'wp:wxr_version')) {
        throw new Error('Not a WordPress export: expected <rss><channel> with a <wp:wxr_version>');
      }

      const items = channel.children.filter((c) => c.name === 'item');
      const authors = authorNames(channel);
      // Attachments are indexed whatever is being read: a post's featured image
      // is an attachment id, and the URL is what is useful outside WordPress.
      const attachmentUrls = new Map<string, string>();
      for (const item of items) {
        if (childText(item, 'wp:post_type') === 'attachment') {
          const url = childText(item, 'wp:attachment_url');
          if (url) attachmentUrls.set(childText(item, 'wp:post_id'), url);
        }
      }

      const fields: string[] = [...BASE_FIELDS];
      if (opts.postTypes.has('attachment')) fields.push('attachmentUrl');
      const seenField = new Set(fields);
      const addField = (name: string) => {
        if (!seenField.has(name)) {
          seenField.add(name);
          fields.push(name);
        }
      };

      const records: SourceRecord[] = [];
      const passedOverTypes = new Map<string, number>();
      const passedOverStatuses = new Map<string, number>();
      let comments = 0;
      let missingImages = 0;

      for (const item of items) {
        const type = childText(item, 'wp:post_type') || 'post';
        if (!opts.postTypes.has(type)) {
          passedOverTypes.set(type, (passedOverTypes.get(type) ?? 0) + 1);
          continue;
        }
        const status = childText(item, 'wp:status');
        if (opts.statuses ? !opts.statuses.has(status) : SKIPPED_BY_DEFAULT.has(status)) {
          passedOverStatuses.set(status, (passedOverStatuses.get(status) ?? 0) + 1);
          continue;
        }
        comments += item.children.filter((c) => c.name === 'wp:comment').length;

        const values = itemValues(item, type, authors, attachmentUrls);
        if (values.featuredImage === undefined) {
          missingImages += 1;
          values.featuredImage = '';
        }
        for (const key of Object.keys(values)) addField(key);
        records.push({
          externalId: identify(values, records.length, opts.identityField),
          values,
          kind: type,
        });
      }

      const warnings: string[] = [];
      if (passedOverTypes.size > 0) {
        warnings.push(
          `Not read (other post types): ${describeCounts(passedOverTypes)}. ` +
            'Set the postType source option to import them.',
        );
      }
      if (passedOverStatuses.size > 0) {
        warnings.push(`Not read (status): ${describeCounts(passedOverStatuses)}`);
      }
      if (missingImages > 0) {
        // An export filtered to one post type leaves the media library out.
        warnings.push(
          `${missingImages} featured image(s) point at attachments not in this export; they are left empty`,
        );
      }
      if (comments > 0) {
        warnings.push(`${comments} comment(s) are in the export; comments are not imported`);
      }
      return { records, fields, warnings };
    },
  };
}

function readOptions(options: Readonly<Record<string, unknown>> | undefined): {
  postTypes: ReadonlySet<string>;
  statuses?: ReadonlySet<string>;
  identityField?: string;
} {
  const opts = (options ?? {}) as Record<string, unknown>;
  // Options arrive as JSON from an API body, so their shape is checked rather
  // than trusted — a mistyped option should fail loudly, not read nothing.
  const list = (name: string, value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;
    const items = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(items) || items.some((v) => typeof v !== 'string' || !v)) {
      throw new Error(`Source option "${name}" must be a string or a list of strings`);
    }
    return items as string[];
  };
  const postTypes = list('postType', opts.postType) ?? ['post'];
  const statuses = list('statuses', opts.statuses);
  if (opts.identityField !== undefined && typeof opts.identityField !== 'string') {
    throw new Error('Source option "identityField" must be a string');
  }
  const identityField = opts.identityField as string | undefined;
  return {
    postTypes: new Set(postTypes),
    ...(statuses ? { statuses: new Set(statuses) } : {}),
    ...(identityField ? { identityField } : {}),
  };
}

/** `wp:author_login` → display name, so an import can carry a person rather than a login. */
function authorNames(channel: XmlElement): Map<string, string> {
  const names = new Map<string, string>();
  for (const author of channel.children) {
    if (author.name !== 'wp:author') continue;
    const login = childText(author, 'wp:author_login');
    const display = childText(author, 'wp:author_display_name');
    if (login) names.set(login, display || login);
  }
  return names;
}

function itemValues(
  item: XmlElement,
  type: string,
  authors: ReadonlyMap<string, string>,
  attachmentUrls: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const author = childText(item, 'dc:creator');
  const parentId = childText(item, 'wp:post_parent');
  const values: Record<string, unknown> = {
    id: childText(item, 'wp:post_id'),
    title: childText(item, 'title'),
    slug: childText(item, 'wp:post_name'),
    content: childText(item, 'content:encoded'),
    excerpt: childText(item, 'excerpt:encoded'),
    status: childText(item, 'wp:status'),
    date: toIsoDate(childText(item, 'wp:post_date_gmt'), childText(item, 'wp:post_date')),
    modified: toIsoDate(
      childText(item, 'wp:post_modified_gmt'),
      childText(item, 'wp:post_modified'),
    ),
    author,
    authorName: authors.get(author) ?? author,
    link: childText(item, 'link'),
    // WordPress spells "no parent" as 0; here it is simply absent.
    parentId: parentId === '0' ? '' : parentId,
    menuOrder: childText(item, 'wp:menu_order'),
    sticky: childText(item, 'wp:is_sticky'),
    categories: [] as string[],
    tags: [] as string[],
    featuredImage: '',
  };
  if (type === 'attachment') values.attachmentUrl = childText(item, 'wp:attachment_url');

  for (const term of item.children) {
    if (term.name !== 'category') continue;
    const domain = term.attributes.domain ?? 'category';
    const name = term.text.trim();
    if (!name) continue;
    const key =
      domain === 'category' ? 'categories' : domain === 'post_tag' ? 'tags' : `terms.${domain}`;
    const list = (values[key] as string[] | undefined) ?? [];
    list.push(name);
    values[key] = list;
  }

  for (const meta of item.children) {
    if (meta.name !== 'wp:postmeta') continue;
    const key = childText(meta, 'wp:meta_key');
    const value = childText(meta, 'wp:meta_value');
    if (key === '_thumbnail_id') {
      // Undefined marks an image that is set but cannot be resolved, which the
      // caller counts — an empty field nobody was told about is the failure.
      values.featuredImage = attachmentUrls.get(value);
      continue;
    }
    if (!key || INTERNAL_META.has(key)) continue;
    values[`meta.${key}`] = value;
  }

  return values;
}

/**
 * WordPress dates are `YYYY-MM-DD HH:MM:SS`. The GMT one is the real instant;
 * an unscheduled draft has it zeroed, so the site-local one is the fallback —
 * written without an offset, because WordPress never recorded one.
 */
function toIsoDate(gmt: string, local: string): string {
  const usable = (d: string) =>
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d) && !d.startsWith('0000');
  if (usable(gmt)) return `${gmt.replace(' ', 'T')}Z`;
  if (usable(local)) return local.replace(' ', 'T');
  return '';
}

function describeCounts(counts: ReadonlyMap<string, number>): string {
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name || '(none)'} (${count})`)
    .join(', ');
}
