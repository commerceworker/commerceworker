/**
 * The assistant panel: one conversation per person, beside every page. It talks to the person's own
 * AssistantAgent over the proxied socket (`useAgentChat`), so a reply keeps going if the tab sleeps
 * and picks up again when it wakes. The page in front supplies the context chip, and hands the
 * panel its edits (`act`), which it sends as they are, one tool call each.
 */

import { type UseAgentChatOptions, useAgentChat } from '@cloudflare/ai-chat/react';
import {
  ASSISTANT_TOOLS,
  type AssistantContext,
  isAssistantTool,
  SETUP_SCOPE,
} from '@commerceworker/domain';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@commerceworker/ui/alert-dialog';
import { Button } from '@commerceworker/ui/button';
import { ComposeLoader, composeSequences } from '@commerceworker/ui/compose-loader';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@commerceworker/ui/dropdown-menu';
import { cn } from '@commerceworker/ui/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { useAgent } from 'agents/react';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { ChevronDown, MoreHorizontal, Pencil, RotateCcw, X } from 'lucide-react';
import {
  Component,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from '~/components/ai-elements/conversation';
import {
  MessageAction,
  MessageActions,
  MessageContent,
  Message as MessageFrame,
} from '~/components/ai-elements/message';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '~/components/ai-elements/prompt-input';
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueList,
} from '~/components/ai-elements/queue';
import { Shimmer } from '~/components/ai-elements/shimmer';
import { Suggestion, Suggestions } from '~/components/ai-elements/suggestion';
import { Mark } from '~/components/mark';
import { useCan, useMe } from '~/lib/use-me';
import {
  type ActResult,
  AssistantUnavailable,
  contextLabel,
  type QueuedAct,
  useAssistant,
} from '../../lib/assistant';
import {
  type AgentCaller,
  agentAddress,
  chatBody,
  isDirectCall,
  sendAct,
  sendAnswer,
} from '../../lib/assistant-client';
import { useClient, useScopeState } from '../../lib/client-context';
import { coarse, useMedia, useVisualViewport, WIDE } from '../../lib/device';
import { useShortcutLabel } from '../../lib/shortcuts';
import { Empty } from '../page';
import {
  ActionCard,
  aboutOf,
  CopyAction,
  EditLine,
  isWrite,
  type Part,
  Prose,
  ReadLine,
  TurnError,
  type TurnScope,
  toolTitle,
} from './parts';

/**
 * Whether the socket to the agent is up. `down` until it opens again (it keeps retrying); `ended`
 * when the agent closed it because the person's sign-in has ended (it doesn't retry).
 */
type Link = 'connecting' | 'open' | 'down' | 'ended';

/** The agent's close code for a person whose sign-in has ended (packages/http/src/assistant). */
const SIGN_IN_ENDED = 4401;

/** How long a page's edit waits for the socket to open before the page makes it itself. */
export const LINK_TIMEOUT_MS = 5000;

type Agent = UseAgentChatOptions['agent'] & AgentCaller;

/**
 * The panel. On wide screens it takes a column beside the page (the page narrows; nothing is
 * covered); below that it is a sheet between the header and the tab bar, taking exactly the area
 * above an on-screen keyboard. Mounted on first open (or a page's first edit) only, so nobody
 * connects to an assistant they never used.
 *
 * Both slide, in 200ms with an exponential ease-out. The sheet slides in from the right edge, where
 * the button that opens it sits. The column moves only by transform: opening takes its 400px at
 * once (the page lays out one time) and slides its content in; closing slides the content out and
 * gives the width back once it has gone. Animating the width would lay the page out every frame.
 * Reduced motion shows and hides both at once.
 */
export function AssistantPanel() {
  const { open, setOpen } = useAssistant();
  const wide = useMedia(WIDE);
  // As a sheet, it keeps its composer above the on-screen keyboard.
  useVisualViewport(open && !wide);
  // As a column, it tells toasts (cms/lib/toast) to sit inside it, above the composer.
  const column = open && wide;
  useEffect(() => {
    if (!column) return;
    const root = document.documentElement;
    root.style.setProperty('--assistant-w', '400px');
    root.style.setProperty('--assistant-lift', '7.5rem');
    return () => {
      root.style.removeProperty('--assistant-w');
      root.style.removeProperty('--assistant-lift');
    };
  }, [column]);
  return (
    <aside
      aria-label="Coworker"
      inert={!open}
      className={cn(
        'z-30 overflow-hidden bg-card ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
        // Phones and tablets: a sheet over the page, between the header and the phone's tab bar.
        'fixed inset-x-0 top-[var(--shell-h)] bottom-[var(--tabbar-h)] transition-[opacity,translate] duration-200 md:left-(--sidebar-width-icon)',
        open ? 'opacity-100' : 'pointer-events-none translate-x-full opacity-0',
        // With the keyboard up, it takes exactly the visible area above it, over the bars.
        'in-data-keyboard:top-[var(--vvtop)] in-data-keyboard:bottom-auto in-data-keyboard:z-50 in-data-keyboard:h-[var(--vvh)]',
        // Wide screens: a column beside the page. Its width changes in one step, not per frame: at
        // once on opening, and on closing only after the content's 200ms slide out.
        'lg:sticky lg:inset-auto lg:top-[var(--shell-h)] lg:flex lg:h-[calc(100dvh-var(--shell-h))] lg:shrink-0 lg:translate-x-0 lg:justify-end lg:opacity-100 lg:transition-[width] lg:duration-0 lg:motion-reduce:transition-none',
        open ? 'lg:w-[400px]' : 'lg:w-0 lg:delay-200',
      )}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        // The sheet covers the page, so Escape closes it; the column stays and hands focus back.
        if (!window.matchMedia?.(WIDE).matches) setOpen(false);
        document.getElementById('main')?.focus({ preventScroll: true });
      }}
    >
      <div
        className={cn(
          'flex h-full flex-col lg:w-[400px] lg:shrink-0 lg:border-l',
          'lg:transition-[opacity,translate] lg:duration-200 lg:ease-[cubic-bezier(0.16,1,0.3,1)] lg:motion-reduce:transition-none',
          open ? 'lg:translate-x-0 lg:opacity-100' : 'lg:translate-x-full lg:opacity-0',
        )}
      >
        <Connected variant="panel" />
      </div>
    </aside>
  );
}

/** Where the conversation is drawn: the panel beside a page, or a page of its own (setup). */
type Variant = 'panel' | 'page';

/**
 * Coworker as a page's whole content, not a panel: setup's last step, where it sets up the
 * deployment's first space. `onCreated` follows the space it created.
 */
export function CoworkerConversation({ onCreated }: { onCreated?: (spaceId: string) => void }) {
  return <Connected variant="page" {...(onCreated ? { onCreated } : {})} />;
}

/**
 * The socket, and the edits pages hand over. It never suspends, so an edit is sent (or handed back
 * to its page) while the conversation is still loading, or when it can't load at all.
 */
function Connected({
  variant,
  onCreated,
}: {
  variant: Variant;
  onCreated?: (spaceId: string) => void;
}) {
  const me = useMe();
  const a = useAssistant();
  const [link, setLinkState] = useState<Link>('connecting');
  const linkRef = useRef<Link>('connecting');
  const watchers = useRef(new Set<() => void>());
  const setLink = useCallback((next: Link) => {
    linkRef.current = next;
    setLinkState(next);
    for (const w of [...watchers.current]) w();
  }, []);

  const socket = useRef<{ close: () => void } | null>(null);
  const agent = useAgent({
    ...agentAddress(me?.id ?? 'local'),
    onOpen: () => setLink('open'),
    onClose: (e: CloseEvent) => {
      // Reconnecting can't help a sign-in that has ended: stop, and ask for a reload.
      if (e?.code === SIGN_IN_ENDED) {
        setLink('ended');
        socket.current?.close();
      } else if (linkRef.current !== 'ended') setLink('down');
    },
    onError: () => {
      if (linkRef.current !== 'ended') setLink('down');
    },
  }) as Agent;
  socket.current = agent as unknown as { close: () => void };

  // Settles once the socket is open; rejects at once while it is down, and after LINK_TIMEOUT_MS
  // while it is still connecting. Either way nothing was sent.
  const whenOpen = useCallback(
    () =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          window.clearTimeout(timer);
          watchers.current.delete(check);
        };
        const check = () => {
          if (linkRef.current === 'open') {
            done();
            resolve();
          } else if (linkRef.current === 'down' || linkRef.current === 'ended') {
            done();
            reject(new AssistantUnavailable());
          }
        };
        const timer = window.setTimeout(() => {
          done();
          reject(new AssistantUnavailable());
        }, LINK_TIMEOUT_MS);
        watchers.current.add(check);
        check();
      }),
    [],
  );

  // Edits pages handed over: each is one tool call of its own, sent as the page built it.
  const latest = useRef({ a, agent });
  latest.current = { a, agent };
  useEffect(() => {
    if (!a.acts.length) return;
    for (const q of a.takeActs()) void deliver(q);
    async function deliver(q: QueuedAct) {
      try {
        await whenOpen();
      } catch (e) {
        q.reject(asError(e));
        return;
      }
      try {
        const r = await sendAct(latest.current.agent, q.tool, q.input, q.context, q.about);
        if ('waiting' in r) {
          // The card is in the conversation now: the page waits for its answer, here.
          latest.current.a.awaitAnswer(r.callId, q);
          latest.current.a.setOpen(true);
        } else q.resolve({ output: r.output });
      } catch (e) {
        q.reject(asError(e));
      }
    }
  }, [a.acts, a.takeActs, whenOpen]);

  return (
    <ConversationBoundary fallback={<PanelFrame note="unreachable" variant={variant} />}>
      <Suspense fallback={<PanelFrame note="opening" variant={variant} />}>
        <ChatView
          agent={agent}
          link={link}
          variant={variant}
          {...(onCreated ? { onCreated } : {})}
        />
      </Suspense>
    </ConversationBoundary>
  );
}

/** A conversation that couldn't load (its history, say) leaves the panel saying so, not a blank. */
class ConversationBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function PanelFrame({ note, variant }: { note: 'opening' | 'unreachable'; variant: Variant }) {
  return (
    <div className="flex h-full flex-col">
      {variant === 'panel' ? <PanelHeader /> : null}
      <div className="flex-1 px-4 py-6 text-muted-foreground text-sm">
        {note === 'opening' ? (
          <Shimmer>Opening your conversation</Shimmer>
        ) : (
          <p role="status">
            Can’t reach Coworker right now. Edits you make on the page still go through.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * What the next question is about. It sits in the composer, beside where the question is written
 * (and in thumb reach on a phone), not in the header.
 */
function ScopeChip() {
  const { page, scope, setScope } = useAssistant();
  const onPage = page.kind !== 'everything';
  const current = scope === 'everything' || !onPage ? 'Everything' : contextLabel(page);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="hit-area flex h-7 min-w-0 max-w-[70%] items-center gap-1 rounded-full border border-input px-2.5 text-muted-foreground text-xs hover:text-foreground touch:h-9 touch:px-3"
        aria-label={`Asking about: ${current}`}
      >
        <span className="truncate">{current}</span>
        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="caption">Ask about</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={onPage ? scope : 'everything'}
          onValueChange={(v) => setScope(v as 'page' | 'everything')}
        >
          <DropdownMenuRadioItem value="page" disabled={!onPage}>
            <span className="truncate">
              {page.kind === 'entry'
                ? `This entry: ${page.label}`
                : page.kind === 'content-type'
                  ? `These entries: ${page.label}`
                  : 'This page (nothing open)'}
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="everything">Everything</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PanelHeader({ onClear, canClear }: { onClear?: () => void; canClear?: boolean }) {
  const { setOpen } = useAssistant();
  const shortcut = useShortcutLabel('J');
  const [clearing, setClearing] = useState(false);
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <h2 className="font-semibold text-base tracking-title">Coworker</h2>
      <div className="ml-auto flex items-center">
        {onClear ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="hit-area grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Conversation options"
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem disabled={!canClear} onSelect={() => setClearing(true)}>
                New conversation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="hit-area grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Close Coworker (${shortcut})`}
          title={`Close (${shortcut})`}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
        {onClear ? (
          <AlertDialog open={clearing} onOpenChange={setClearing}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Start a new conversation?</AlertDialogTitle>
                <AlertDialogDescription>
                  This conversation is deleted; it was only yours. Changes you confirmed stay made
                  and stay in the audit log.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={onClear}>
                  New conversation
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
    </header>
  );
}

type Message = UIMessage;

/** A turn with no space to work in: a deployment admin setting up the first one. */
const SETUP_CONTEXT: AssistantContext = { scope: SETUP_SCOPE, page: { kind: 'everything' } };

function ChatView({
  agent,
  link,
  variant,
  onCreated,
}: {
  agent: Agent;
  link: Link;
  variant: Variant;
  onCreated?: (spaceId: string) => void;
}) {
  const a = useAssistant();
  // Every turn runs in one space, so with none yet (a fresh install) a deployment admin's turns set
  // one up (`SETUP_SCOPE`); anyone else can only wait to be added to one.
  const noSpace = useScopeState() === 'no-spaces';
  const admin = useCan('admin');
  const setup = useRef(false);
  setup.current = noSpace && admin;
  const chat = useAgentChat<unknown, Message>({
    agent,
    body: () => chatBody(setup.current ? SETUP_CONTEXT : a.readContext()),
  });
  const {
    messages,
    sendMessage,
    regenerate,
    status,
    stop,
    error,
    clearError,
    addToolApprovalResponse,
    clearHistory,
  } = chat;
  const busy = chat.isStreaming || chat.isRecovering || status === 'submitted';
  const ended = link === 'ended';
  const down = link === 'down' || ended;

  // A card a page made (`act`) is answered through the agent, with no model turn, and settles the
  // page waiting on it; a card the model proposed is answered as the AI SDK answers one.
  const latest = useRef(a);
  latest.current = a;
  const respond = useCallback(
    (part: Part, approved: boolean) => {
      if (!isDirectCall(part)) {
        if (part.approval) addToolApprovalResponse({ id: part.approval.id, approved });
        return;
      }
      const id = part.toolCallId;
      sendAnswer(agent, id, approved)
        .then((r) =>
          latest.current.answered(
            id,
            approved && r.done !== null ? { output: r.output } : { declined: true },
          ),
        )
        .catch((e: unknown) => latest.current.answered(id, asError(e)));
    },
    [addToolApprovalResponse, agent],
  );

  // A card answered somewhere else (another tab, the phone) settles the page waiting on it here.
  useEffect(() => {
    for (const m of messages)
      for (const p of m.parts) {
        if (!isToolUIPart(p) || !isDirectCall(p)) continue;
        const settled = settledAs(p);
        if (settled) latest.current.answered(p.toolCallId, settled);
      }
  }, [messages]);

  // ── Messages written while a reply is running wait here, editable, until it ends.
  const [held, setHeld] = useState<string[]>([]);
  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      if (busy) setHeld((h) => [...h, t]);
      else void sendMessage({ text: t });
    },
    [busy, sendMessage],
  );
  useEffect(() => {
    if (busy || !held.length) return;
    const [next, ...rest] = held;
    setHeld(rest);
    if (next) void sendMessage({ text: next });
  }, [busy, held, sendMessage]);

  // A question asked from a page.
  useEffect(() => {
    if (!a.pendingAsk) return;
    const t = a.takeAsk();
    if (t) send(t);
  }, [a.pendingAsk, a.takeAsk, send]);

  const last = messages.at(-1);
  const lastAssistant = messages.findLastIndex((m) => m.role === 'assistant');
  // Editing or answering again rewrites what came after; never across an action, which may already
  // have happened, or an edit a page made.
  const lastAction = messages.findLastIndex(hasAction);
  const edit = useCallback(
    (messageId: string, text: string) => {
      const t = text.trim();
      if (t && !busy) void sendMessage({ text: t, messageId });
    },
    [busy, sendMessage],
  );

  const thinking =
    status === 'submitted' || (busy && last?.role === 'user') || (busy && last?.parts.length === 0);
  const { pending, replaced } = waitingActions(messages);
  const announcement = useAnnouncement(messages, busy, pending);

  // The space this conversation created, once it has: the admin moves into it, and Coworker offers
  // what to try next there. One created before this view opened is history, not news.
  const created = createdSpace(messages);
  const seen = useRef(created?.callId);
  const { updateConn } = useClient();
  const queries = useQueryClient();
  const follow = useRef(onCreated);
  follow.current = onCreated;
  useEffect(() => {
    if (!created || seen.current === created.callId) return;
    seen.current = created.callId;
    // The new space must be on the list before switching to it, or the scope falls back to the
    // first space on the (stale) list.
    const { spaceId } = created;
    void queries.invalidateQueries({ queryKey: ['spaces'] }).then(() => {
      updateConn({ space: spaceId, environment: 'main' });
      follow.current?.(spaceId);
    });
  }, [created, updateConn, queries]);
  const nextFor = created && !noSpace && !busy && last === createdIn(messages) ? created : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {variant === 'panel' ? (
        <PanelHeader onClear={clearHistory} canClear={messages.length > 0 && !busy} />
      ) : null}
      {down ? (
        // Quiet: the page's own edits don't need the panel, so this is news, not an error.
        <p role="status" className="border-b px-4 py-2 text-muted-foreground text-xs">
          {ended
            ? 'Your sign-in has ended. Reload the page to sign in again.'
            : 'Can’t reach Coworker right now; trying again. Edits you make on the page still go through.'}
        </p>
      ) : null}
      {/* Not live: streamed text would be read out a fragment at a time. A finished reply, and an
          action that needs an answer, are announced once each instead (`useAnnouncement`). */}
      <Conversation aria-label="Conversation" className="cw-scroll min-h-0">
        <ConversationContent aria-live="off" className="gap-4 px-4 py-4">
          {messages.length === 0 ? (
            noSpace ? (
              <SetUpFirstSpace admin={admin} onAsk={send} mark={variant === 'panel'} />
            ) : (
              <FirstRun onAsk={send} />
            )
          ) : (
            messages.map((m, i) =>
              m.role === 'user' ? (
                <UserMessage
                  key={m.id}
                  m={m}
                  busy={busy}
                  onEdit={i > lastAction ? edit : undefined}
                />
              ) : (
                <AssistantMessage
                  key={m.id}
                  m={m}
                  streaming={busy && i === messages.length - 1}
                  respond={respond}
                  replaced={replaced}
                  // Only the latest reply can be asked again, and not while one is running.
                  onRegenerate={
                    i === lastAssistant &&
                    i === messages.length - 1 &&
                    i !== lastAction &&
                    !busy &&
                    !down
                      ? () => void regenerate()
                      : undefined
                  }
                />
              ),
            )
          )}
          {nextFor ? <NextSteps starter={nextFor.starter} onAsk={send} /> : null}
          {thinking ? (
            <div role="status" className="flex items-center gap-2 text-ui">
              <ComposeLoader icon={composeSequences.working} className="size-3.5 text-ai" />
              <Shimmer as="span">
                {chat.isRecovering ? 'Picking up where it left off' : 'Working on it'}
              </Shimmer>
            </div>
          ) : null}
          {error && !busy ? (
            <TurnError
              message={error.message}
              onRetry={() => {
                clearError();
                void regenerate();
              }}
              onDismiss={clearError}
            />
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      {/* On a page of its own the conversation is all there is, so its cards are in view. */}
      {pending.length && variant === 'panel' ? <WaitingBar pending={pending} /> : null}
      {held.length ? (
        <HeldMessages
          held={held}
          onChange={(i, text) => setHeld((h) => h.map((x, j) => (j === i ? text : x)))}
          onRemove={(i) => setHeld((h) => h.filter((_, j) => j !== i))}
        />
      ) : null}
      <Composer
        variant={variant}
        busy={busy}
        down={down}
        setup={noSpace ? (admin ? 'ask' : 'blocked') : null}
        onSend={send}
        onStop={() => void stop()}
      />
    </div>
  );
}

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

/** How a page's card ended, once it has: its output, declined, or why it failed. */
export function settledAs(p: Part): ActResult | Error | null {
  if (p.state === 'output-available') return { output: p.output };
  if (p.state === 'output-denied') return { declined: true };
  if (p.state === 'approval-responded' && p.approval?.approved === false) return { declined: true };
  if (p.state === 'output-error') return new Error(p.errorText || 'The change didn’t go through');
  return null;
}

const textOf = (m: Message) =>
  m.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();

/** Whether a message holds an action or a page's edit: the conversation never rewrites past it. */
const hasAction = (m: Message) =>
  m.parts.some(
    (p) =>
      isToolUIPart(p) && (isDirectCall(p) || p.approval !== undefined || isWrite(getToolName(p))),
  );

function UserMessage({
  m,
  busy,
  onEdit,
}: {
  m: Message;
  busy: boolean;
  onEdit?: (messageId: string, text: string) => void;
}) {
  const text = textOf(m);
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    const changed = draft.trim() && draft.trim() !== text;
    return (
      <MessageFrame from="user" className="max-w-full">
        <PromptInput
          aria-label="Edit your message"
          onSubmit={() => {
            if (!changed) return;
            onEdit?.(m.id, draft);
            setDraft(null);
          }}
        >
          <PromptInputTextarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setDraft(null);
              }
            }}
            sendOnEnter={(e) => !coarse() || e.metaKey || e.ctrlKey}
            aria-label="Edited message"
          />
          <PromptInputFooter className="justify-end">
            <Button type="button" size="xs" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={!changed || busy}>
              Send again
            </Button>
          </PromptInputFooter>
        </PromptInput>
        <p className="text-muted-foreground text-xs">
          Sending again replaces this message and the replies after it.
        </p>
      </MessageFrame>
    );
  }
  // The actions sit beside the bubble, so a question costs no extra line.
  return (
    <MessageFrame from="user" className="flex-row-reverse items-center gap-1">
      <MessageContent>{text}</MessageContent>
      <MessageActions>
        <CopyAction text={text} />
        {onEdit ? (
          <MessageAction label="Edit" disabled={busy} onClick={() => setDraft(text)}>
            <Pencil />
          </MessageAction>
        ) : null}
      </MessageActions>
    </MessageFrame>
  );
}

type Waiting = { key: string; name: string; input: unknown };

/**
 * Names one tool part in the conversation. Not its tool call id: a model may number its calls
 * afresh each turn, so the same id can turn up in several messages.
 */
const actionKey = (messageId: string, index: number) => `${messageId}:${index}`;

/**
 * The calls waiting for the person's answer, oldest first. The conversation is one per person and
 * live on every device they use, so the same request can be made twice. Only the newest of
 * identical requests asks; the older ones are `replaced`.
 */
function waitingActions(messages: Message[]) {
  const asking: Waiting[] = [];
  for (const m of messages)
    m.parts.forEach((p, i) => {
      if (isToolUIPart(p) && p.state === 'approval-requested')
        asking.push({ key: actionKey(m.id, i), name: getToolName(p), input: p.input });
    });
  const newest = new Map<string, string>();
  for (const w of asking) newest.set(`${w.name} ${JSON.stringify(w.input)}`, w.key);
  const live = new Set(newest.values());
  return {
    pending: asking.filter((w) => live.has(w.key)),
    replaced: new Set(
      asking.filter((w) => !live.has(w.key)).map((w) => w.key),
    ) as ReadonlySet<string>,
  };
}

/** An edit's settled line, as words: what happened, and to what. Null while it hasn't settled. */
function settledWords(p: Part): string | null {
  const name = getToolName(p);
  const info = isAssistantTool(name) ? ASSISTANT_TOOLS[name] : null;
  const about = aboutOf(p);
  const tail = about ? ` · ${about}` : '';
  if (p.state === 'output-available') return `${info?.done ?? name}${tail}`;
  if (p.state === 'output-error') return `${info?.title ?? name} didn’t go through${tail}`;
  if (p.state === 'output-denied' || (p.state === 'approval-responded' && !p.approval?.approved))
    return `${info?.declined ?? name}${tail}`;
  return null;
}

/**
 * What a screen reader hears: a reply once it has finished (not each streamed fragment), a card
 * once it starts waiting for an answer, and an edit once it has settled (a page's, or a card
 * answered here or elsewhere), so what changed is never only seen.
 */
function useAnnouncement(messages: Message[], busy: boolean, pending: Waiting[]) {
  const [said, setSaid] = useState('');
  const wasBusy = useRef(busy);
  const known = useRef<Set<string> | null>(null);
  const settled = useRef<Set<string> | null>(null);
  useEffect(() => {
    // As with cards, the first render only learns what had already happened.
    const before = settled.current;
    const now = new Set<string>();
    const fresh: string[] = [];
    for (const m of messages)
      m.parts.forEach((p, i) => {
        if (!isToolUIPart(p) || !(isWrite(getToolName(p)) || isDirectCall(p))) return;
        const words = settledWords(p);
        if (!words) return;
        const key = actionKey(m.id, i);
        now.add(key);
        if (before && !before.has(key)) fresh.push(words);
      });
    settled.current = now;
    if (fresh.length) setSaid(fresh.join('. '));
  }, [messages]);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const last = messages.at(-1);
      const text = last?.role === 'assistant' ? textOf(last) : '';
      if (text) setSaid(text.length > 300 ? `${text.slice(0, 300)}…` : text);
    }
    wasBusy.current = busy;
  }, [busy, messages]);
  useEffect(() => {
    // The first render only learns what is already waiting; it announces nothing.
    const before = known.current;
    known.current = new Set(pending.map((w) => w.key));
    const fresh = before ? pending.filter((w) => !before.has(w.key)) : [];
    if (fresh.length)
      setSaid(`Waiting for your answer: ${fresh.map((w) => toolTitle(w.name)).join(', ')}`);
  }, [pending]);
  return said;
}

/**
 * Whether the card `key` names is in view in the conversation. Starts as in view, so the bar
 * doesn't flash in and out as a card arrives at the bottom; where nothing can watch (no
 * IntersectionObserver), never, so the bar always shows.
 */
function useCardOnScreen(key: string | undefined) {
  const canWatch = typeof IntersectionObserver !== 'undefined';
  const [onScreen, setOnScreen] = useState(canWatch);
  useEffect(() => {
    if (!key || !canWatch) return;
    const card = document.querySelector(`[data-action="${CSS.escape(key)}"]`);
    if (!card) {
      setOnScreen(false);
      return;
    }
    const watch = new IntersectionObserver(
      ([e]) => setOnScreen(Boolean(e && e.intersectionRatio >= 0.5)),
      { threshold: [0, 0.5, 1] },
    );
    watch.observe(card);
    return () => watch.disconnect();
  }, [key, canWatch]);
  return onScreen;
}

/**
 * Pinned above the composer while a card waits for the person, so it can't scroll out of mind under
 * newer turns. The conversation goes on; pressing it brings the card back, focused on the safe
 * choice.
 */
function WaitingBar({ pending }: { pending: Waiting[] }) {
  const newest = pending.at(-1);
  const onScreen = useCardOnScreen(newest?.key);
  // While its card is in view the bar would only say it twice, and take room the card needs.
  if (!newest || (onScreen && pending.length === 1)) return null;
  const show = () => {
    const card = document.querySelector<HTMLElement>(`[data-action="${CSS.escape(newest.key)}"]`);
    if (!card) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
    card.querySelector<HTMLButtonElement>('[data-safe-choice]')?.focus({ preventScroll: true });
  };
  return (
    <button
      type="button"
      onClick={show}
      className="mx-3 mt-2 flex min-h-9 items-center gap-2 rounded-full border border-wait/30 bg-wait/10 px-3 text-left text-xs hover:bg-wait/15"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-wait" />
      <span className="min-w-0 flex-1 truncate">
        {pending.length === 1 ? (
          <>
            <span className="font-medium text-foreground">Waiting for you:</span>{' '}
            <span className="text-muted-foreground">{toolTitle(newest.name)}</span>
          </>
        ) : (
          <span className="font-medium text-foreground">
            {pending.length} changes waiting for you
          </span>
        )}
      </span>
      <span className="shrink-0 font-medium text-foreground">Show</span>
    </button>
  );
}

function AssistantMessage({
  m,
  streaming,
  respond,
  replaced,
  onRegenerate,
}: {
  m: Message;
  streaming: boolean;
  respond: (part: Part, approved: boolean) => void;
  replaced: ReadonlySet<string>;
  onRegenerate?: () => void;
}) {
  const lastText = m.parts.findLastIndex((p) => p.type === 'text');
  const text = textOf(m);
  const meta = m.metadata as { scope?: TurnScope; at?: unknown } | undefined;
  const turn = meta?.scope;
  // When the reply (or a page's edit) began: its edits and cards say so in their margin.
  const at = typeof meta?.at === 'number' ? meta.at : undefined;
  return (
    <MessageFrame from="assistant">
      <MessageContent className="space-y-2">
        {m.parts.map((p, i) => {
          const key = actionKey(m.id, i);
          if (p.type === 'text')
            return p.text.trim() ? (
              <Prose key={key} text={p.text} streaming={streaming && i === lastText} />
            ) : null;
          if (!isToolUIPart(p)) return null;
          const name = getToolName(p);
          if (p.approval !== undefined)
            return (
              <ActionCard
                key={key}
                part={p}
                respond={respond}
                actionKey={key}
                direct={isDirectCall(p)}
                replaced={replaced.has(key)}
                {...(turn ? { turn } : {})}
                at={at}
              />
            );
          if (isWrite(name) || isDirectCall(p)) return <EditLine key={key} part={p} at={at} />;
          return <ReadLine key={key} part={p} streaming={streaming} />;
        })}
      </MessageContent>
      {!streaming && (text || onRegenerate) ? (
        <MessageActions>
          {text ? <CopyAction text={text} /> : null}
          {onRegenerate ? (
            <MessageAction label="Answer again" onClick={onRegenerate}>
              <RotateCcw />
            </MessageAction>
          ) : null}
        </MessageActions>
      ) : null}
    </MessageFrame>
  );
}

// ── First run ──────────────────────────────────────────────────────────────

function FirstRun({ onAsk }: { onAsk: (text: string) => void }) {
  const { page, scope } = useAssistant();
  const kind = scope === 'everything' ? 'everything' : page.kind;
  const ideas =
    kind === 'entry'
      ? ['Summarize this entry', 'What changed since it was last published?', 'Suggest tags for it']
      : kind === 'content-type'
        ? ['Which of these are still drafts?', 'What fields does this content type have?']
        : ['What’s waiting to be published?', 'How do releases work?'];
  return (
    <Empty
      className="px-0 py-6"
      icon={<Mark className="text-ai" />}
      title="Ask about your content"
      action={
        <Suggestions className="items-center">
          {ideas.map((t) => (
            <Suggestion key={t} suggestion={t} onClick={onAsk} />
          ))}
        </Suggestions>
      }
    >
      Or have it make a change: it can do what your role allows, and shows you each change before it
      makes it. Edits you make on the page show here too, on every device you’re signed in on.
    </Empty>
  );
}

/**
 * First run with no space to work in, as on a fresh install. Coworker can't read or change anything
 * until there is one, so a deployment admin is asked what the first space will hold: Coworker
 * proposes a name and a starter, and nothing is created until they confirm the card. Anyone else is
 * told who can add them to one.
 */
function SetUpFirstSpace({
  admin,
  onAsk,
  mark,
}: {
  admin: boolean;
  onAsk: (text: string) => void;
  /** Its own mark; setup's page already carries one above it. */
  mark: boolean;
}) {
  const icon = mark ? <Mark className="text-ai" /> : undefined;
  if (!admin)
    return (
      <Empty className="px-0 py-6" icon={icon} title="You aren’t on a space yet.">
        Coworker works inside a space. Ask a deployment admin to add you to one.
      </Empty>
    );
  return (
    <Empty
      className="px-0 py-6"
      icon={icon}
      title="What will your first space hold?"
      action={
        <Suggestions className="items-center">
          {SETUP_IDEAS.map((t) => (
            <Suggestion key={t} suggestion={t} onClick={onAsk} />
          ))}
        </Suggestions>
      }
    >
      Say it in a few words. Coworker suggests a name and a starter, and nothing is created until
      you confirm.
    </Empty>
  );
}

const SETUP_IDEAS = ['A marketing site, with sample content', 'An empty space to model my own'];

/** What to try in a space just created, by what it started with. */
const NEXT_STEPS: Record<string, readonly string[]> = {
  empty: ['How do I model my first content type?', 'How do locales work?'],
  sample: ['What’s in this content model?', 'What’s waiting to be published?'],
};

/** Suggestions under the reply that created the space: never a tour, only a next question. */
function NextSteps({ starter, onAsk }: { starter: string; onAsk: (text: string) => void }) {
  const ideas = NEXT_STEPS[starter === 'empty' ? 'empty' : 'sample'] ?? [];
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">Try next</p>
      <Suggestions>
        {ideas.map((t) => (
          <Suggestion key={t} suggestion={t} onClick={onAsk} />
        ))}
      </Suggestions>
    </div>
  );
}

/** A space this conversation created: the confirmed `space_create` call, by the input it ran with. */
interface Created {
  readonly callId: string;
  readonly spaceId: string;
  readonly starter: string;
}

/** The message holding the latest created space, if any. */
function createdIn(messages: Message[]): Message | undefined {
  return messages.findLast((m) => m.parts.some(isCreated));
}

const isCreated = (p: Message['parts'][number]) =>
  isToolUIPart(p) && getToolName(p) === 'space_create' && p.state === 'output-available';

/**
 * The latest space this conversation created. Its input is what ran (the agent holds a call to the
 * input it was proposed with), so the id is read from there, not from the model's words.
 */
export function createdSpace(messages: Message[]): Created | null {
  const part = createdIn(messages)?.parts.findLast(isCreated);
  if (!part || !isToolUIPart(part)) return null;
  const input = (part.input ?? {}) as { spaceId?: unknown; starter?: unknown };
  if (typeof input.spaceId !== 'string') return null;
  return {
    callId: part.toolCallId,
    spaceId: input.spaceId,
    starter: typeof input.starter === 'string' ? input.starter : 'empty',
  };
}

// ── Composer ───────────────────────────────────────────────────────────────

function HeldMessages({
  held,
  onChange,
  onRemove,
}: {
  held: string[];
  onChange: (i: number, text: string) => void;
  onRemove: (i: number) => void;
}) {
  return (
    <Queue className="mx-3 mt-2">
      <p className="caption px-1">Sends when this reply finishes</p>
      <QueueList>
        {held.map((t, i) => (
          // Held messages have no ids of their own; their order is their identity.
          <QueueItem key={i}>
            <input
              value={t}
              onChange={(e) => onChange(i, e.target.value)}
              aria-label="Queued message"
              className="h-7 min-w-0 flex-1 rounded-xl bg-transparent px-2 text-ui focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <QueueItemActions>
              <QueueItemAction label="Remove queued message" onClick={() => onRemove(i)}>
                <X className="size-3.5" />
              </QueueItemAction>
            </QueueItemActions>
          </QueueItem>
        ))}
      </QueueList>
    </Queue>
  );
}

function Composer({
  variant,
  busy,
  down,
  setup,
  onSend,
  onStop,
}: {
  variant: Variant;
  busy: boolean;
  down: boolean;
  /**
   * No space to work in yet: a deployment admin is asked what it will hold (`ask`); anyone else
   * can't ask anything until they are added to one (`blocked`).
   */
  setup: 'ask' | 'blocked' | null;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const { focusToken } = useAssistant();
  const shortcut = useShortcutLabel('J');
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusToken) box.current?.focus();
  }, [focusToken]);
  return (
    <div className="shrink-0 p-3 in-data-keyboard:pb-2">
      <PromptInput
        aria-label="Message Coworker"
        onSubmit={() => {
          if (!text.trim() || down || setup === 'blocked') return;
          onSend(text);
          setText('');
        }}
      >
        <PromptInputTextarea
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          // On a touch screen Return is a new line and the button sends; ⌘/Ctrl+Enter always sends.
          sendOnEnter={(e) => !coarse() || e.metaKey || e.ctrlKey}
          disabled={setup === 'blocked'}
          placeholder={
            setup === 'blocked'
              ? 'Ask an admin to add you to a space'
              : setup === 'ask' && !busy
                ? 'A marketing site, a docs hub, a product catalog…'
                : busy
                  ? 'Next message, sent after this reply'
                  : 'Ask Coworker'
          }
          aria-label="Message Coworker"
        />
        <PromptInputFooter className="gap-1.5 pt-0">
          {/* With no space, there is nothing on the page to ask about. */}
          {setup ? null : <ScopeChip />}
          <span className="flex-1" />
          {/* While a reply runs, stop sits beside send, which holds the next message. */}
          {busy ? (
            <PromptInputSubmit status="streaming" onStop={onStop} className="touch:size-9" />
          ) : null}
          <PromptInputSubmit
            disabled={!text.trim() || down || setup === 'blocked'}
            className="touch:size-9"
          />
        </PromptInputFooter>
      </PromptInput>
      <p className="mt-1.5 hidden px-1 text-muted-foreground text-xs fine:block">
        Enter sends · Shift+Enter for a new line
        {variant === 'panel' ? ` · ${shortcut} opens and closes` : ''}
      </p>
    </div>
  );
}
