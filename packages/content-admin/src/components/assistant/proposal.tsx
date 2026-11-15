/**
 * What a change the model proposed would do, read from the system before the person confirms it:
 * a draft save as the field diff from what the draft holds now (`diffEntryFields`, the domain's
 * own diff), a new entry by its fields, a batch by the entries it names, a tagging by its tags'
 * names, a release by its title, a block patch as the field diff its dry run answers (the api's
 * own checks, `checkEntryBlocks`, nothing written). The proposal's input is the
 * exact call that runs on Confirm, so it is what is shown; anything a model wrote around it (its
 * prose) never reaches here.
 */

import { type ContentType, diffEntryFields, type EntryFields } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { Collapsible, CollapsibleContent } from '@commerceworker/ui/collapsible';
import { getToolName } from 'ai';
import { useEffect, useId, useState } from 'react';
import type { ManagementClient } from '../../lib/management';
import { entryRef, fetchEntriesById } from '../dashboard/entry-titles';
import {
  ChangedFields,
  changedCount,
  FieldReview,
  ReviewFailed,
  type ReviewField,
  reviewFields,
} from '../entries/EntryReview';
import { type BlockRefusal, BlockRefused, readBlockPatch } from './block-proposal';
import type { Part } from './parts';

/** What a proposal is, as far as reviewing it goes. */
export type Proposal =
  | { readonly kind: 'save'; readonly entryId: string; readonly fields: EntryFields }
  | { readonly kind: 'create'; readonly contentType: string; readonly fields: EntryFields }
  | { readonly kind: 'entries'; readonly ids: readonly string[] }
  | { readonly kind: 'entry'; readonly entryId: string }
  | {
      readonly kind: 'tags';
      readonly entryId: string;
      readonly tagIds: readonly string[];
      readonly newTags: readonly string[];
      /** The tags become exactly these (`entries_set_metadata`), rather than being added. */
      readonly replace: boolean;
      readonly concepts: number;
    }
  | {
      readonly kind: 'release';
      readonly releaseId: string;
      readonly entryId: string;
      readonly unpublish: boolean;
    }
  | {
      readonly kind: 'blocks';
      /** Empty, or the version missing, when the call doesn't say: the card then can't confirm. */
      readonly entryId: string;
      readonly expectedVersion?: number;
      readonly ops: readonly unknown[];
    };

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const isFields = (v: unknown): v is EntryFields =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The tools whose single entry a card names by reading it (the publish card reads its own). */
const ONE_ENTRY = new Set([
  'entries_unpublish',
  'entries_trash',
  'entries_purge',
  'entries_restore',
  'entries_duplicate',
  'entries_restore_version',
  'schedule_action',
  'comments_add',
]);

/** What there is to review in a call, or null when it names nothing that can be read. */
export function proposalOf(part: Part): Proposal | null {
  const name = getToolName(part);
  const input = (part.input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'entries_update': {
      const entryId = str(input.id);
      return entryId && isFields(input.fields)
        ? { kind: 'save', entryId, fields: input.fields }
        : null;
    }
    case 'entries_create': {
      const contentType = str(input.contentType);
      return contentType && isFields(input.fields)
        ? { kind: 'create', contentType, fields: input.fields }
        : null;
    }
    case 'bulk_job_start':
    case 'entries_bulk_action': {
      const ids = strings(input.entryIds ?? input.ids);
      return ids.length ? { kind: 'entries', ids } : null;
    }
    case 'entries_set_metadata':
    case 'entry_apply_tags': {
      const entryId = str(input.entryId ?? input.id);
      if (!entryId) return null;
      const replace = name === 'entries_set_metadata';
      return {
        kind: 'tags',
        entryId,
        tagIds: strings(replace ? input.tags : input.tagIds),
        newTags: strings(input.newTags),
        replace,
        concepts: strings(input.concepts).length,
      };
    }
    case 'entry_blocks_patch': {
      // Always a proposal, however malformed: a card that can't show what changes stays held.
      const version = input.expectedVersion;
      return {
        kind: 'blocks',
        entryId: str(input.id) ?? '',
        ...(typeof version === 'number' ? { expectedVersion: version } : {}),
        ops: Array.isArray(input.ops) ? input.ops : [],
      };
    }
    case 'releases_add_entry': {
      const releaseId = str(input.releaseId);
      const entryId = str(input.entryId);
      return releaseId && entryId
        ? { kind: 'release', releaseId, entryId, unpublish: input.action === 'unpublish' }
        : null;
    }
    default: {
      const entryId = ONE_ENTRY.has(name) ? str(input.id ?? input.entryId) : undefined;
      return entryId ? { kind: 'entry', entryId } : null;
    }
  }
}

/** A batch names this many of its entries; the rest are counted. */
export const NAMED_MAX = 5;

export type ProposalReview =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly retry?: () => void }
  | {
      readonly status: 'ready';
      /** The entry the call is about, by its title. */
      readonly title?: string;
      /** A save's or a new entry's fields, as a person reads them. */
      readonly fields?: readonly ReviewField[];
      /** A batch's first entries by title, and how many more it holds. */
      readonly entries?: { readonly titles: readonly string[]; readonly more: number };
      readonly tags?: { readonly names: readonly string[]; readonly created: readonly string[] };
      readonly release?: string;
      /** A block patch's steps, in order, each naming its blocks and where they go. */
      readonly steps?: readonly string[];
    }
  /** Read, and it can't be confirmed as it stands: the card says why, and Confirm stays off. */
  | { readonly status: 'refused'; readonly title?: string; readonly refusal: BlockRefusal };

type Ready = Extract<ProposalReview, { status: 'ready' }>;
type Read = Ready | Extract<ProposalReview, { status: 'refused' }>;

async function readProposal(client: ManagementClient, p: Proposal, locale: string): Promise<Read> {
  const types = await client.listContentTypes();
  const titleOf = async (id: string) => {
    const entry = await client.getEntry(id);
    return { entry, title: entryRef(entry, types, locale).title };
  };
  switch (p.kind) {
    case 'save': {
      // A save writes the whole new version: a field it leaves out is gone from the draft.
      const { entry, title } = await titleOf(p.entryId);
      const type = types.find((t) => t.apiId === entry.contentType);
      const changes = diffEntryFields(entry.fields as EntryFields, p.fields, type, {
        structureOnly: true,
      });
      return { status: 'ready', title, fields: reviewFields(changes, locale) };
    }
    case 'create': {
      const type: ContentType | undefined = types.find((t) => t.apiId === p.contentType);
      const changes = diffEntryFields({}, p.fields, type, { structureOnly: true });
      const named = type?.displayField ? p.fields[type.displayField] : undefined;
      const title =
        named && typeof named === 'object'
          ? (str((named as Record<string, unknown>)[locale]) ??
            Object.values(named).map(str).find(Boolean))
          : undefined;
      return {
        status: 'ready',
        ...(title ? { title } : {}),
        fields: reviewFields(changes, locale),
      };
    }
    case 'entries': {
      const shown = p.ids.slice(0, NAMED_MAX);
      const found = await fetchEntriesById(client, shown);
      const byId = new Map(found.map((e) => [e.id, entryRef(e, types, locale).title]));
      // One that can't be read (gone, or not this person's to read) is still counted.
      const titles = shown.flatMap((id) => {
        const t = byId.get(id);
        return t ? [t] : [];
      });
      return { status: 'ready', entries: { titles, more: p.ids.length - titles.length } };
    }
    case 'entry':
      return { status: 'ready', title: (await titleOf(p.entryId)).title };
    case 'tags': {
      const [{ title }, tags] = await Promise.all([titleOf(p.entryId), client.listTags()]);
      const byId = new Map(tags.map((t) => [t.id, t.name]));
      return {
        status: 'ready',
        title,
        tags: {
          names: p.tagIds.map((id) => byId.get(id) ?? 'A tag you can’t see'),
          created: p.newTags,
        },
      };
    }
    case 'release': {
      const [{ title }, release] = await Promise.all([
        titleOf(p.entryId),
        client.getRelease(p.releaseId),
      ]);
      return { status: 'ready', title, release: release.release.title };
    }
    case 'blocks':
      return readBlockPatch(client, p, types, locale);
  }
}

const LOADING: ProposalReview = { status: 'loading' };
const IDLE: ProposalReview = { status: 'idle' };

/** Reads what `proposal` would do; a read only, and with no proposal nothing at all. */
export function useProposalReview(
  client: ManagementClient | undefined,
  proposal: Proposal | null,
  locale: string,
): ProposalReview {
  const [review, setReview] = useState(LOADING);
  const [attempt, setAttempt] = useState(0);
  // The proposal is a fresh object each render; its content is what identifies it.
  const key = proposal ? JSON.stringify(proposal) : null;
  useEffect(() => {
    setReview(LOADING);
    if (!key || !client) return;
    let live = true;
    readProposal(client, JSON.parse(key) as Proposal, locale).then(
      (r) => {
        if (live) setReview(r);
      },
      () => {
        if (live) setReview({ status: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [client, key, locale, attempt]);
  if (!proposal) return IDLE;
  return review.status === 'failed'
    ? { status: 'failed', retry: () => setAttempt((n) => n + 1) }
    : review;
}

const note = (text: string) => <p className="text-muted-foreground text-xs">{text}</p>;

const fieldsChange = (n: number, create: boolean) =>
  create
    ? `${n} ${n === 1 ? 'field' : 'fields'}:`
    : `${n} ${n === 1 ? 'field changes' : 'fields change'} in the draft:`;

/**
 * What a model's proposal would do, for its card: the system's reading of the call that runs on
 * Confirm. Each way it can't say that says what would let the person confirm.
 */
export function ProposalDetail({
  proposal,
  review,
  place,
  onRetry,
}: {
  proposal: Proposal;
  review: ProposalReview;
  place?: 'elsewhere' | 'unknown' | undefined;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (place === 'unknown')
    return note(
      'Coworker can’t tell where this runs, so it can’t show what changes. Choose Not now, then ask again.',
    );
  if (place === 'elsewhere')
    return note(
      'This was asked in another space or environment. Switch back to see what changes and confirm.',
    );
  if (review.status === 'loading')
    return <div className="min-h-12">{note('Reading what this changes…')}</div>;
  if (review.status === 'failed')
    return <ReviewFailed onRetry={onRetry} next="Try again to see what changes and confirm." />;
  if (review.status === 'refused') return <BlockRefused refusal={review.refusal} />;
  if (review.status !== 'ready') return null;

  if (review.entries) {
    const { titles, more } = review.entries;
    return (
      <ul aria-label="Entries" className="space-y-0.5 text-ui">
        {titles.map((t, i) => (
          // Titles needn't be unique; their order is the call's.
          <li key={`${i}:${t}`} className="truncate">
            {t}
          </li>
        ))}
        {more > 0 ? (
          <li className="text-muted-foreground text-xs">
            {titles.length ? `and ${more} more` : `${more} ${more === 1 ? 'entry' : 'entries'}`}
          </li>
        ) : null}
      </ul>
    );
  }
  if (review.tags) {
    const { names, created } = review.tags;
    const replace = proposal.kind === 'tags' && proposal.replace;
    const concepts = proposal.kind === 'tags' ? proposal.concepts : 0;
    return (
      <div className="space-y-1 text-ui">
        {names.length || replace ? (
          <p>
            <span className="text-muted-foreground">{replace ? 'Tags become: ' : 'Adds: '}</span>
            {names.length ? names.join(', ') : 'no tags'}
          </p>
        ) : null}
        {created.length ? (
          <p>
            <span className="text-muted-foreground">New tags: </span>
            {created.join(', ')}
          </p>
        ) : null}
        {concepts ? note(`And ${concepts} ${concepts === 1 ? 'concept' : 'concepts'}.`) : null}
      </div>
    );
  }
  if (review.release !== undefined) {
    const unpublish = proposal.kind === 'release' && proposal.unpublish;
    return (
      <p className="text-ui">
        <span className="text-muted-foreground">
          {unpublish ? 'Unpublishes with ' : 'Publishes with '}
        </span>
        {review.release}
      </p>
    );
  }
  if (review.fields) {
    const create = proposal.kind === 'create';
    const blocks = proposal.kind === 'blocks';
    const n = changedCount(review.fields);
    if (n === 0) return note('The draft already holds these values; saving changes nothing.');
    return (
      <Collapsible open={open} onOpenChange={setOpen} className="space-y-1">
        {review.steps?.length ? (
          <ol aria-label="Steps" className="list-decimal space-y-0.5 ps-5 text-ui">
            {review.steps.map((s, i) => (
              // Steps needn't be unique; their order is the call's.
              <li key={`${i}:${s}`} className="break-words">
                {s}
              </li>
            ))}
          </ol>
        ) : null}
        {note(
          // The colon introduces the list below it; open, the list steps aside, and so does it.
          (blocks
            ? `${n} ${n === 1 ? 'change' : 'changes'} in the draft:`
            : fieldsChange(n, create)
          ).replace(/:$/, open ? '.' : ':'),
        )}
        {/* Open, the review below names each change itself: the list would say it twice. */}
        {open ? null : <ChangedFields fields={review.fields} />}
        <Button
          variant="link"
          size="xs"
          className="px-0"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide changes' : 'Review changes'}
        </Button>
        <CollapsibleContent id={id}>
          <FieldReview
            fields={create ? review.fields.filter((f) => f.kind !== 'unchanged') : review.fields}
            labels={create ? { after: 'Value' } : { before: 'Now', after: 'After saving' }}
          />
        </CollapsibleContent>
      </Collapsible>
    );
  }
  return null;
}
