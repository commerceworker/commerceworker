/**
 * How the assistant's messages read: prose; each read as a quiet line (what it is doing while the
 * reply streams, then that it's done); each edit as a line in the words of what happened, linking
 * to the entry it changed; and anything waiting for the person as a confirm card, saying who asked
 * for it and what it would change. A declined card is neutral (the person chose it), never a
 * failure, and reads in the past tense ("Not published"), so it still makes sense later.
 */

import { Link, useNavigate } from '@commerceworker/content-admin/router';
import {
  Confirmation,
  ConfirmationActions,
} from '@commerceworker/content-admin/shared/ai-elements/confirmation';
import {
  MessageAction,
  MessageResponse,
} from '@commerceworker/content-admin/shared/ai-elements/message';
import { Mark } from '@commerceworker/content-admin/shared/mark';
import { ASSISTANT_TOOLS, isAssistantTool } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@commerceworker/ui/card';
import { Collapsible, CollapsibleContent } from '@commerceworker/ui/collapsible';
import { ComposeLoader } from '@commerceworker/ui/compose-loader';
import { cn } from '@commerceworker/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { type DynamicToolUIPart, getToolName, type ToolUIPart } from 'ai';
import {
  ArrowUpRight,
  Ban,
  Check,
  CircleAlert,
  Copy,
  type LucideIcon,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAssistantIfAny } from '../../lib/assistant';
import { metaOf } from '../../lib/assistant-client';
import { useClient } from '../../lib/client-context';
import type { Connection, SpaceStarterInfo } from '../../lib/management';
import {
  ChangedFields,
  type EntryReview,
  FIRST_PUBLISH,
  FieldReview,
  fieldsGoLive,
  HiddenChanges,
  NO_CHANGES,
  ReviewFailed,
  ReviewHold,
  type ReviewTarget,
  useEntryReview,
  useHandFocus,
} from '../entries/EntryReview';
import { DEFAULT_STARTERS } from '../layout/CreateSpaceDialog';
import { refusalHold } from './block-proposal';
import { ProposalDetail, proposalOf, useProposalReview } from './proposal';

export type Part = ToolUIPart | DynamicToolUIPart;

// ── Prose ──────────────────────────────────────────────────────────────────

/** Markdown from the model. Links inside the admin navigate in place; the panel stays open. */
export function Prose({ text, streaming }: { text: string; streaming?: boolean }) {
  const navigate = useNavigate();
  return (
    <MessageResponse
      className="cw-prose"
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      controls={false}
      components={{
        a: ({ href, children }) => {
          const internal =
            typeof href === 'string' && href.startsWith('/') && !href.startsWith('//');
          return internal ? (
            <a
              href={href}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                navigate(href);
              }}
            >
              {children}
            </a>
          ) : (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </MessageResponse>
  );
}

// ── Lines ──────────────────────────────────────────────────────────────────

/** A tool's title, from the assistant's own list; an unknown tool by its name. */
export const toolTitle = (name: string) =>
  isAssistantTool(name) ? ASSISTANT_TOOLS[name].title : name;

/** Whether a tool changes something (its settled call reads as an edit line, not a read). */
export const isWrite = (name: string) => isAssistantTool(name) && ASSISTANT_TOOLS[name].write;

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * The editor of the entry an edit changed, when its output names one: an entry (`id` and
 * `contentTypeApiId`, as publish returns), or a view of one (`entry`, as save and duplicate do).
 */
export function entryHref(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  const e = (o.entry && typeof o.entry === 'object' ? o.entry : o) as Record<string, unknown>;
  const id = str(e.id);
  const type = str(e.contentTypeApiId);
  return id && type ? `/content/${encodeURIComponent(type)}/${encodeURIComponent(id)}` : null;
}

const entriesCount = (n: number) => `${n} ${n === 1 ? 'entry' : 'entries'}`;

/** What a bulk job does, as a person would say it: `bulk_job_start`'s `action` over `entryIds`. */
const BULK_JOB_ABOUT: Record<string, (n: string) => string> = {
  publish: (n) => `Publish ${n}`,
  unpublish: (n) => `Unpublish ${n}`,
  trash: (n) => `Move ${n} to the trash`,
  restore: (n) => `Restore ${n} from the trash`,
  purge: (n) => `Permanently delete ${n}`,
};

/** A batch's action, when the call is one: a bulk job's, or a bulk publish or unpublish. */
function bulkJobAction(part: Part): string | undefined {
  const name = getToolName(part);
  if (name !== 'bulk_job_start' && name !== 'entries_bulk_action') return undefined;
  const action = (part.input as { action?: unknown } | undefined)?.action;
  return typeof action === 'string' ? action : undefined;
}

/**
 * What a card or line is about when the page didn't say: how many entries, for a batch, and for a
 * bulk job what it does to them, so a model's proposal to delete 500 entries says so.
 */
export function aboutOf(part: Part): string | undefined {
  const about = metaOf(part).about;
  if (about) return about;
  const input = part.input as { ids?: unknown; entryIds?: unknown } | undefined;
  const action = bulkJobAction(part);
  const batch = input?.entryIds ?? input?.ids;
  if (action !== undefined && Array.isArray(batch)) {
    const n = entriesCount(batch.length);
    return BULK_JOB_ABOUT[action]?.(n) ?? `${action}: ${n}`;
  }
  if (Array.isArray(input?.ids)) return entriesCount(input.ids.length);
  return undefined;
}

/**
 * When something happened, as a line's margin note says it: the time today, else the day. Read in
 * the person's own locale and clock.
 */
export function whenLabel(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now).toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The moment a line or card is from, in its margin: quiet, tabular, and a real `<time>`. */
function When({ at }: { at: number | undefined }) {
  if (!at) return null;
  return (
    <time
      dateTime={new Date(at).toISOString()}
      className="ml-auto shrink-0 pl-2 font-normal text-muted-foreground text-xs tabular-nums"
    >
      {whenLabel(at)}
    </time>
  );
}

function Line({
  icon: Icon,
  tone = 'muted',
  href,
  at,
  children,
}: {
  icon: LucideIcon;
  tone?: 'muted' | 'ink' | 'bad' | 'running';
  href?: string | null;
  /** When it happened (ms), for an edit's line. */
  at?: number | undefined;
  children: React.ReactNode;
}) {
  const line = (
    <span
      className={cn(
        'flex min-w-0 items-start gap-2 text-ui leading-snug',
        tone === 'ink' && 'font-medium text-foreground',
        tone === 'muted' && 'text-muted-foreground',
        tone === 'running' && 'text-muted-foreground',
        tone === 'bad' && 'text-bad',
      )}
    >
      {/* A tool still running shows the model at work in place of its icon. */}
      {tone === 'running' ? (
        <ComposeLoader className="mt-0.5 size-3.5 text-ai" />
      ) : (
        <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0">
        {children}
        {tone === 'running' ? <span className="sr-only"> (running)</span> : null}
      </span>
    </span>
  );
  if (!at) return href ? <LineLink href={href}>{line}</LineLink> : line;
  // The time sits outside the link: it says when, it isn't where the link goes.
  return (
    <span className="flex min-w-0 items-start">
      {href ? <LineLink href={href}>{line}</LineLink> : line}
      <When at={at} />
    </span>
  );
}

function LineLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link to={href} className="hit-area w-fit min-w-0 hover:underline">
      {children}
    </Link>
  );
}

/** How many things a read's result holds, when it says: a list, a page of `items`, a `count`. */
function resultCount(output: unknown): number | undefined {
  if (Array.isArray(output)) return output.length;
  if (!output || typeof output !== 'object') return undefined;
  const o = output as Record<string, unknown>;
  if (Array.isArray(o.items)) return typeof o.total === 'number' ? o.total : o.items.length;
  if (typeof o.count === 'number') return o.count;
  return undefined;
}

/**
 * A tool the assistant read with: what it is doing while the turn streams, then that it did. A read
 * that failed, or that the reply left unfinished, says so in `bad`, with why.
 */
export function ReadLine({ part, streaming }: { part: Part; streaming: boolean }) {
  const name = getToolName(part);
  const title = toolTitle(name);
  const unfinished = part.state === 'input-streaming' || part.state === 'input-available';
  if (unfinished && streaming)
    return (
      <Line icon={Search} tone="running">
        {title}
      </Line>
    );
  if (unfinished || part.state === 'output-error')
    return (
      <Line icon={CircleAlert} tone="bad">
        {title} {unfinished ? 'stopped' : 'failed'}
        {part.state === 'output-error' && part.errorText ? (
          <span className="block text-muted-foreground text-xs">{part.errorText}</span>
        ) : null}
      </Line>
    );
  // Done, in the past tense so it can't read as still running, with what it found when it says.
  const n = part.state === 'output-available' ? resultCount(part.output) : undefined;
  return (
    <Line icon={Search}>
      {isAssistantTool(name) ? ASSISTANT_TOOLS[name].done : name}
      {n === undefined ? '' : ` · ${n} ${n === 1 ? 'result' : 'results'}`}
    </Line>
  );
}

/**
 * An edit, settled: "Published · Spring launch notes", linking to the entry when its output names
 * one. A declined card says what stayed as it was ("Not published · Spring launch notes"); a failed
 * one says why. `at` is when it happened.
 */
export function EditLine({ part, at }: { part: Part; at?: number | undefined }) {
  const name = getToolName(part);
  const about = aboutOf(part);
  const info = isAssistantTool(name) ? ASSISTANT_TOOLS[name] : null;
  const declined =
    part.state === 'output-denied' ||
    (part.state === 'approval-responded' && part.approval?.approved === false);
  if (declined)
    return (
      <Line icon={Ban} at={at}>
        {info?.declined ?? `${info?.title ?? name}: left as it was`}
        {about ? ` · ${about}` : ''}
      </Line>
    );
  if (part.state === 'output-error')
    return (
      <Line icon={CircleAlert} tone="bad" at={at}>
        {info?.title ?? name} didn’t go through{about ? ` · ${about}` : ''}
        {part.errorText ? (
          <span className="block text-muted-foreground text-xs">{part.errorText}</span>
        ) : null}
      </Line>
    );
  if (part.state === 'output-available')
    return (
      <Line icon={ArrowUpRight} tone="ink" href={entryHref(part.output)} at={at}>
        {info?.done ?? name}
        {about ? (
          <>
            {' '}
            <span className="font-normal text-muted-foreground">· {about}</span>
          </>
        ) : null}
      </Line>
    );
  // Confirmed and running, or the model still writing its input.
  return (
    <Line icon={ArrowUpRight} tone="running">
      {info?.title ?? name}
      {about ? ` · ${about}` : ''}
    </Line>
  );
}

// ── Cards ──────────────────────────────────────────────────────────────────

/** Actions that remove something from the delivery API or for good: their confirm is `destructive`. */
const DESTRUCTIVE = new Set(['entries_trash', 'entries_purge', 'entries_unpublish']);
/** The bulk job actions that do the same to many entries at once. */
const DESTRUCTIVE_JOBS = new Set(['trash', 'purge', 'unpublish']);

export function isDestructive(part: Part): boolean {
  const action = bulkJobAction(part);
  return action !== undefined ? DESTRUCTIVE_JOBS.has(action) : DESTRUCTIVE.has(getToolName(part));
}

/** Where a turn's calls run, as the agent stamps it on the model's reply. */
export interface TurnScope {
  readonly spaceId?: unknown;
  readonly environmentId?: unknown;
}

/**
 * Whether a card runs where the panel reads from: `here`, `elsewhere` (another space or environment)
 * or `unknown`. A page's card says where in its input. A model's input says nothing that counts: its
 * turn's scope does. A card outlives a switch of space or environment, and an id can mean a
 * different entry there, so nothing is read for a card that isn't here.
 */
function placeOf(
  part: Part,
  conn: Connection,
  direct: boolean,
  turn: TurnScope | undefined,
): 'here' | 'elsewhere' | 'unknown' {
  const input = (part.input ?? {}) as Record<string, unknown>;
  const space = direct ? input.space : turn?.spaceId;
  const environment = direct ? input.environment : turn?.environmentId;
  // Nothing says where it runs (no scope stored, or a continuation from elsewhere left none).
  if (typeof space !== 'string' || typeof environment !== 'string') return 'unknown';
  return space === conn.space && environment === conn.environment ? 'here' : 'elsewhere';
}

/** Where a publish card's review reads from, or why it can't. */
function publishTarget(
  part: Part,
  conn: Connection,
  direct: boolean,
  turn: TurnScope | undefined,
): ReviewTarget | 'elsewhere' | 'unknown' | null {
  if (getToolName(part) !== 'entries_publish') return null;
  const input = (part.input ?? {}) as Record<string, unknown>;
  const { id, expectedVersion } = input;
  if (typeof id !== 'string') return 'unknown';
  const place = placeOf(part, conn, direct, turn);
  if (place !== 'here') return place;
  return {
    entryId: id,
    ...(typeof expectedVersion === 'number' ? { version: expectedVersion } : {}),
    ...(metaOf(part).about ? {} : { named: true }),
  };
}

/**
 * What a publish card will put live, from the system's own diff of the entry the call names. Nothing
 * here comes from the model: its text never reaches this card. Each way it can't show that says
 * what would let the person confirm: trying again, switching back, or asking again.
 */
function PublishReview({
  review,
  place,
  onRetry,
}: {
  review: EntryReview;
  /** Why the review wasn't read: the card runs somewhere else, or nothing says where. */
  place?: 'elsewhere' | 'unknown' | undefined;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const note = (text: string) => <p className="text-muted-foreground text-xs">{text}</p>;
  if (place === 'unknown')
    return note(
      'Coworker can’t tell where this runs, so it can’t show what goes live. Choose Not now, then ask again.',
    );
  if (place === 'elsewhere')
    return note(
      'This was asked in another space or environment. Switch back to see what goes live and confirm.',
    );
  // Held at about a short list's height, so Not now and Confirm don't move under the pointer.
  if (review.status === 'loading')
    return <div className="min-h-20">{note('Comparing with what’s live…')}</div>;
  if (review.status === 'first') return note(FIRST_PUBLISH);
  if (review.status === 'failed')
    return <ReviewFailed onRetry={onRetry} next="Try again to see what goes live and confirm." />;
  if (review.status !== 'ready') return null;
  const changed = review.fields.filter((f) => f.kind !== 'unchanged').length;
  const { hiddenChanges } = review;
  if (changed === 0)
    return hiddenChanges > 0 ? <HiddenChanges count={hiddenChanges} alone /> : note(NO_CHANGES);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-1">
      {note(fieldsGoLive(changed))}
      <ChangedFields fields={review.fields} />
      {hiddenChanges > 0 ? <HiddenChanges count={hiddenChanges} alone={false} /> : null}
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
        <FieldReview fields={review.fields} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Who asked for a card: the person, from the page (they just pressed for it), or Coworker, which
 * proposed it. Said on every card, so a proposal never passes for something the person did.
 */
function Source({ direct }: { direct: boolean }) {
  return (
    <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
      {direct ? (
        'You asked for this on the page'
      ) : (
        <>
          <Mark className="size-3 shrink-0 text-ai" />
          Coworker suggests this
        </>
      )}
    </p>
  );
}

/**
 * A call waiting for the person: a page's action, or anything the model proposed to change. One
 * press confirms it; Not now leaves everything as it was. A publish lists what will go live, and
 * can't be confirmed unless that has been read; a model's proposal shows what it would change,
 * read from the system (`ProposalDetail`), and is held the same way. Not now always can. Focus starts on the safe choice when the card came
 * from a page (the person just pressed for it) or the person is already in the conversation, never
 * pulled out of a field they are typing in. A card a newer, identical request replaced stops
 * asking, so only one button can do the thing.
 */
export function ActionCard({
  part,
  respond,
  actionKey,
  direct,
  replaced,
  turn,
  at,
}: {
  part: Part;
  respond: (part: Part, approved: boolean) => void;
  /** Unique in the conversation; a tool call id need not be. */
  actionKey: string;
  direct: boolean;
  replaced?: boolean;
  /** The scope of the turn a model's card came from. */
  turn?: TurnScope;
  /** When the card was made (ms). */
  at?: number | undefined;
}) {
  const name = getToolName(part);
  const titleId = useId();
  const safe = useRef<HTMLButtonElement>(null);
  const [sent, setSent] = useState(false);
  const asking = part.state === 'approval-requested' && !replaced;

  const { client, conn } = useClient();
  const target = useMemo(
    () => (asking ? publishTarget(part, conn, direct, turn) : null),
    [asking, part, conn, direct, turn],
  );
  const place = target === 'elsewhere' || target === 'unknown' ? target : undefined;
  const review = useEntryReview(
    client,
    target === 'elsewhere' || target === 'unknown' ? null : target,
    conn.locale,
  );
  // A model's proposal (other than a publish, read above) shows what it would change. A page's card
  // needs no reading: the page made it from what the person was looking at.
  const proposal = useMemo(
    () => (asking && !direct && target === null ? proposalOf(part) : null),
    [asking, direct, target, part],
  );
  const proposalPlace = useMemo(() => {
    if (!proposal) return undefined;
    const p = placeOf(part, conn, direct, turn);
    return p === 'here' ? undefined : p;
  }, [proposal, part, conn, direct, turn]);
  const proposed = useProposalReview(
    client,
    proposal && !proposalPlace ? proposal : null,
    conn.locale,
  );
  const reviewTitle =
    'title' in review && review.title
      ? review.title
      : proposed.status === 'ready' || proposed.status === 'refused'
        ? proposed.title
        : undefined;
  const about = aboutOf(part) ?? reviewTitle;
  // A card that can't show what it changes can't be confirmed from here, wherever it's pressed.
  const blocked = target
    ? place !== undefined || review.status === 'failed'
    : proposal
      ? proposalPlace !== undefined || proposed.status === 'failed' || proposed.status === 'refused'
      : false;
  const pending = target ? review.status === 'loading' : proposed.status === 'loading';
  const held = Boolean(target || proposal);
  const confirmOff = sent || blocked || (held && pending);
  const reasonId = useId();

  // The panel is inert until it opens, and focus can't land in it: a card that arrives first (a
  // cold open, whose message can beat the page's answer) waits for that, then asks once.
  const panelOpen = useAssistantIfAny()?.open ?? true;
  const offered = useRef(false);
  useEffect(() => {
    if (!asking || !panelOpen || offered.current) return;
    offered.current = true;
    const el = safe.current;
    const now = document.activeElement;
    const typing = now instanceof HTMLElement && now.matches('input, textarea, [contenteditable]');
    const inLog = !now || now === document.body || el?.closest('[role="log"]')?.contains(now);
    if (!((direct && !typing) || inLog)) return;
    el?.focus({ preventScroll: true });
    // Its buttons come into view with it: on a phone they could open under the composer's bars.
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el?.closest('.cw-confirm')
      ?.querySelector('[data-card-actions]')
      ?.scrollIntoView?.({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  }, [asking, direct, panelOpen]);

  // The buttons go when the card is answered, here or anywhere else. Focus that was on them stays
  // with what replaces them, which outlives both, so it never falls to the body.
  const holder = useRef<HTMLDivElement>(null);
  const focusWithin = useRef(false);
  useEffect(() => {
    if (!asking && focusWithin.current && document.activeElement === document.body)
      holder.current?.focus({ preventScroll: true });
  }, [asking]);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useHandFocus(confirmOff && !sent, confirmButton, safe, () => focusWithin.current);
  const answer = (approved: boolean) => {
    if (approved && confirmOff) return;
    holder.current?.focus({ preventScroll: true });
    setSent(true);
    respond(part, approved);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: it only notices focus; it is no control.
    <div
      ref={holder}
      tabIndex={-1}
      onFocus={() => {
        focusWithin.current = true;
      }}
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget))
          focusWithin.current = false;
      }}
    >
      {replaced && part.state === 'approval-requested' ? (
        <Line icon={Ban}>{toolTitle(name)}: replaced by the newer request below</Line>
      ) : !asking ? (
        <EditLine part={part} at={at} />
      ) : (
        <Confirmation
          approval={part.approval}
          state={part.state}
          aria-labelledby={titleId}
          data-action={actionKey}
          className="cw-confirm my-1 scroll-my-4"
        >
          {/* No `overflow-hidden`: it would clip the buttons' touch areas (`hit-area`). */}
          <Card size="sm" className="gap-3 overflow-visible pb-0 ring-wait/40">
            <CardHeader className="gap-1">
              <CardTitle className="flex min-w-0 items-baseline">
                <h3 id={titleId} className="min-w-0 font-semibold text-sm leading-snug">
                  {toolTitle(name)}
                </h3>
                <When at={at} />
              </CardTitle>
              <Source direct={direct} />
            </CardHeader>
            {about || target || proposal || name === 'space_create' ? (
              <CardContent className="space-y-2">
                {about ? <p className="break-words text-ui leading-snug">{about}</p> : null}
                {name === 'space_create' ? <SpaceProposal input={part.input} /> : null}
                {proposal ? (
                  <ProposalDetail
                    proposal={proposal}
                    review={proposed}
                    place={proposalPlace}
                    onRetry={() => {
                      safe.current?.focus({ preventScroll: true });
                      if (proposed.status === 'failed') proposed.retry?.();
                    }}
                  />
                ) : null}
                {target ? (
                  <PublishReview
                    review={review}
                    place={place}
                    onRetry={() => {
                      // The button goes with the failure; focus doesn't go with it.
                      safe.current?.focus({ preventScroll: true });
                      if (review.status === 'failed') review.retry?.();
                    }}
                  />
                ) : null}
              </CardContent>
            ) : null}
            <CardFooter
              data-card-actions
              className="flex-col items-stretch gap-2 rounded-b-2xl border-t bg-wait/10 pb-(--card-spacing) dark:bg-wait/5"
            >
              <p className="text-muted-foreground text-xs leading-snug">
                Nothing changes until you confirm, here or wherever else you’re signed in.
              </p>
              {target ? (
                <ReviewHold
                  id={reasonId}
                  verb="confirm"
                  pending={review.status === 'loading'}
                  blocked={blocked}
                />
              ) : proposal ? (
                <ReviewHold
                  id={reasonId}
                  verb="confirm"
                  pending={pending}
                  blocked={blocked}
                  shows="what changes"
                  reading="reading what changes"
                  why={
                    proposed.status === 'refused' && !proposalPlace
                      ? refusalHold(proposed.refusal)
                      : undefined
                  }
                />
              ) : null}
              <ConfirmationActions>
                <Button
                  ref={safe}
                  size="sm"
                  variant="ghost"
                  disabled={sent}
                  data-safe-choice
                  onClick={() => answer(false)}
                >
                  Not now
                </Button>
                <Button
                  size="sm"
                  variant={isDestructive(part) ? 'destructive' : 'default'}
                  ref={confirmButton}
                  disabled={confirmOff}
                  aria-describedby={held && confirmOff && !sent ? reasonId : undefined}
                  onClick={() => answer(true)}
                >
                  Confirm
                </Button>
              </ConfirmationActions>
            </CardFooter>
          </Card>
        </Confirmation>
      )}
    </div>
  );
}

/**
 * What a new space will be, from the input the call runs with (the agent holds it to that), never
 * from the model's words: its name, id, default locale and starter.
 */
function SpaceProposal({ input }: { input: unknown }) {
  const v = (input ?? {}) as Record<string, unknown>;
  // The deployment's own starters, named as the New space form names them.
  const { client } = useClient();
  const listed = useQuery({ queryKey: ['starters'], queryFn: () => client.listStarters() });
  const starters = listed.data?.length ? listed.data : DEFAULT_STARTERS;
  const text = (x: unknown) => (typeof x === 'string' && x ? x : '—');
  const starter = typeof v.starter === 'string' ? v.starter : 'empty';
  const list = (x: unknown) =>
    Array.isArray(x) && x.length ? x.filter((i) => typeof i === 'string').join(', ') : null;
  const locales = list(v.locales);
  const environments = list(v.environments);
  const rows: [string, string, boolean][] = [
    ['Name', text(v.name), false],
    ['Space ID', text(v.spaceId), true],
    ['Default locale', text(v.defaultLocale), true],
    ...(locales ? [['Locales', locales, true] as [string, string, boolean]] : []),
    ['Environments', environments ?? 'main', true],
    [
      'Starts with',
      starterLabel(
        starters.find((s) => s.id === starter),
        starter,
      ),
      false,
    ],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ui">
      {rows.map(([label, value, mono]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className={cn('min-w-0 break-words', mono && 'font-mono text-xs leading-5')}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const starterLabel = (s: SpaceStarterInfo | undefined, id: string) =>
  s ? (s.background ? `${s.title} (installs in the background)` : s.title) : id;

// ── Message actions ────────────────────────────────────────────────────────

/** Copies the text, then says so for a moment. */
export function CopyAction({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <MessageAction
      label={done ? 'Copied' : 'Copy'}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true));
      }}
    >
      {done ? <Check /> : <Copy />}
    </MessageAction>
  );
}

/**
 * What a failed turn says. The agent already words its own failures for the person; what reaches
 * here unworded is the connection's, which says nothing a person can act on.
 */
export function turnErrorText(message: string): string {
  if (!message.trim() || /fetch|network|websocket|socket|ECONN|timed? ?out/i.test(message))
    return 'The connection dropped before the reply finished. Try again.';
  return message;
}

/** A turn that failed: what went wrong, in a sentence, with the way to try again. */
export function TurnError({
  message,
  onRetry,
  onDismiss,
}: {
  message: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl bg-bad/10 px-3 py-2 text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-bad">Coworker couldn’t finish that reply.</p>
        <p className="break-words text-muted-foreground text-xs">{turnErrorText(message)}</p>
      </div>
      <Button size="xs" variant="outline" onClick={onRetry}>
        Try again
      </Button>
      <button
        type="button"
        onClick={onDismiss}
        className="hit-area grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
