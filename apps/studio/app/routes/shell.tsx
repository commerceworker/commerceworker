import { users } from '@commerceworker/store/auth';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@commerceworker/ui/dropdown-menu';
import { cn } from '@commerceworker/ui/lib/utils';
import { Segmented, SegmentedItem } from '@commerceworker/ui/segmented';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@commerceworker/ui/sheet';
import {
  SIDEBAR_COOKIE_NAME,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@commerceworker/ui/sidebar';
import { TooltipProvider } from '@commerceworker/ui/tooltip';
import { and, eq, isNull } from 'drizzle-orm';
import {
  ChevronsUpDown,
  Ellipsis,
  type LucideIcon,
  Monitor,
  Moon,
  Search,
  Sun,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  type ShouldRevalidateFunctionArgs,
  useLoaderData,
  useLocation,
  useMatches,
  useNavigate,
  useNavigation,
} from 'react-router';
import { Breadcrumbs } from '~/cms/components/layout/Breadcrumbs';
import { CommandPalette, openCommandPalette } from '~/cms/components/layout/CommandPalette';
import { OPEN_SHORTCUTS_EVENT } from '~/cms/components/layout/KeyboardShortcuts';
import { NewEntry } from '~/cms/components/layout/NewEntry';
import {
  DEFAULT_SETTINGS_SECTION,
  isAt as isUnder,
  type NAV as PAGES,
  SETTINGS_GROUPS,
  visibleNav,
} from '~/cms/components/layout/nav';
import { SpaceSwitcher } from '~/cms/components/layout/SpaceSwitcher';
import { approvalsCountLabel, usePendingApprovalsCount } from '~/cms/lib/approvals';
import { AssistantProvider, useAssistant } from '~/cms/lib/assistant';
import { useOptionalClient } from '~/cms/lib/client-context';
import { useFeatures } from '~/cms/lib/features';
import { useModKeyLabel, usePageShortcutGroups, useShortcutLabel } from '~/cms/lib/shortcuts';
import { CmsProviders } from '~/cms/providers';
import { Mark } from '~/components/mark';
import { authEnabled, requireUser } from '~/lib/auth.server';
import { useMedia } from '~/lib/device';
import { db } from '~/lib/env.server';
import { revalidateUnlessSearchOnly } from '~/lib/revalidate';
import { atLeast, type Principal, ROLE_LABELS } from '~/lib/roles';
import { pageShortcut } from '~/lib/shortcuts';
import { type ThemeChoice, useTheme } from '~/lib/theme';
import type { Route } from './+types/shell';

/** The sidebar as it was left (the `cw_sidebar_state` cookie), so the server draws its width. */
const sidebarOpenFrom = (request: Request) =>
  !new RegExp(`(?:^|;\\s*)${SIDEBAR_COOKIE_NAME}=false(?:;|$)`).test(
    request.headers.get('Cookie') ?? '',
  );

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  const sidebarOpen = sidebarOpenFrom(request);
  // Until their two-factor sign-in or own password is set, a person sees only their Account page.
  if (me.twoFactorDue || me.passwordChangeDue)
    return { auth: true, me, nav: false, admins: [], sidebarOpen };
  const [admins, auth] = await Promise.all([
    // Who to ask when a page needs a higher role: up to three active admins.
    atLeast(me.role, 'admin')
      ? []
      : db()
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
          .orderBy(users.name)
          .limit(3),
    authEnabled(),
  ]);
  return { auth, me, nav: true, admins, sidebarOpen };
}

/** Who is signed in doesn't change with a page's search: typing in a list skips this loader. */
export function shouldRevalidate(args: ShouldRevalidateFunctionArgs) {
  return revalidateUnlessSearchOnly(args);
}

/** A link in the shell; `match` overrides "this path or under it" for the page reading as current. */
type NavItem = {
  to: string;
  label: string;
  icon?: LucideIcon;
  end?: boolean;
  match?: (path: string) => boolean;
  /** Carries the Approvals count (nav.ts). */
  badge?: boolean;
};

const settingsPath = (id: string) => `/settings/${id}`;

/**
 * The sidebar's groups, in nav.ts's order: the day's work (no label), Build, Library, then
 * Settings as Settings' own section groups (Access, Automation, Extensions, Workspace), each opening
 * its first section and reading as current on any of them.
 */
function navGroups(pages: typeof PAGES): { title?: string; items: NavItem[] }[] {
  const of = (section?: string) =>
    pages
      .filter((p) => p.section === section)
      .map(({ to, label, icon, badge }) => ({ to, label, icon, badge }));
  const settings = SETTINGS_GROUPS.map((g, i) => ({
    to: settingsPath(g.sections[0]?.id ?? DEFAULT_SETTINGS_SECTION),
    label: g.label,
    icon: g.icon,
    // Its own sections only: the shell's `isAt` reads any /settings path as Settings as a whole,
    // which would mark every group current on every section.
    match: (path: string) =>
      (i === 0 && path === '/settings') ||
      g.sections.some((s) => isUnder(path, { to: settingsPath(s.id) })),
  }));
  return [
    { items: of(undefined) },
    { title: 'Build', items: of('Build') },
    { title: 'Library', items: of('Library') },
    { title: 'Settings', items: pages.some((p) => p.section === 'Settings') ? settings : [] },
  ].filter((g) => g.items.length > 0);
}

/**
 * The deployment's own pages, for admins: the sidebar's last group, and More's on a phone. Its
 * audit log (sign-ins, people, single sign-on) opens from People and sign-in, which reads as
 * current there: the one "Audit log" in the nav is the space's, under Settings › Workspace.
 */
const DEPLOYMENT: NavItem[] = [
  {
    to: '/team',
    label: 'People and sign-in',
    icon: UsersRound,
    match: (path) => isAt(path, { to: '/team' }) || isAt(path, { to: '/audit' }),
  },
];

/** Pages outside nav.ts, named for the header's breadcrumbs as their headers name them. */
const OUTSIDE_NAV = [
  { to: '/team', label: 'People and sign-in' },
  { to: '/audit', label: 'Audit log' },
  { to: '/account', label: 'Account' },
];

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'Match system', icon: Monitor },
];

type GoKey = { key: string; to: string; label: string };

/**
 * Go-to keys: G, then the page's letter (nav.ts), for the pages this deployment shows (a page
 * behind a feature that's off has no key). Settings opens on its first section.
 */
const goKeys = (pages: typeof PAGES): GoKey[] =>
  pages.map((p) => ({
    key: p.shortcutKey,
    to: p.section === 'Settings' ? settingsPath(DEFAULT_SETTINGS_SECTION) : p.to,
    label: p.label,
  }));

/** Whether `path` is the link's page or under it. Settings' sections all count as Settings. */
const isAt = (path: string, { to, end, match }: Pick<NavItem, 'to' | 'end' | 'match'>) => {
  if (match) return match(path);
  const base = to.startsWith('/settings/') ? '/settings' : to;
  return end ? path === base : path === base || path.startsWith(`${base}/`);
};

/**
 * G then a letter goes to a page; ? lists the shortcuts. Page shortcuts' rules apply (not while
 * typing or with a menu open), and the listener runs first, so a page's own keys never see the
 * letter that finished a G.
 */
function useGoKeys(go: GoKey[], onHelp: () => void) {
  const navigate = useNavigate();
  useEffect(() => {
    let armed = 0;
    const onKey = (e: KeyboardEvent) => {
      if (!pageShortcut(e)) {
        armed = 0;
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        armed = 0;
        onHelp();
        return;
      }
      const to = Date.now() - armed < 1500 ? go.find((g) => g.key === e.key) : undefined;
      if (to) {
        e.preventDefault();
        e.stopImmediatePropagation();
        armed = 0;
        navigate(to.to);
        return;
      }
      armed = e.key === 'g' ? Date.now() : 0;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [navigate, onHelp, go]);
}

/** Keys, joined by "then" for a sequence or "+" for a chord. */
function Keys({ keys, chord }: { keys: readonly string[]; chord?: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
      {keys.map((k, i) => (
        <span key={`${i}-${k}`} className="contents">
          {i ? (chord ? '+' : 'then') : null}
          <kbd className="min-w-6 rounded-md border px-1.5 py-0.5 text-center font-sans text-foreground text-xs">
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

/** Every keyboard shortcut, from ? or the account menu. */
function ShortcutsSheet({
  go,
  open,
  onOpenChange,
}: {
  go: GoKey[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const row = 'flex items-center justify-between gap-4 py-1.5 text-sm';
  // The page's own keys (J/K/X in a table, the editor's ⌘S), as the screen registers them.
  const pageGroups = usePageShortcutGroups();
  const mod = useModKeyLabel();
  const sidebar = useShortcutLabel('\\');
  const assistant = useShortcutLabel('J');
  const { enabled: assistantOn } = useAssistant();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" bodyClassName="gap-0">
        <div className="sticky top-0 z-10 border-b bg-popover px-4 pt-4 pb-3 pr-14">
          <SheetTitle>Keyboard shortcuts</SheetTitle>
          <SheetDescription className="text-xs">
            Single keys work outside fields, with no menu open.
          </SheetDescription>
        </div>
        <section className="px-4 pt-3 pb-2">
          <h3 className="caption mb-1">Everywhere</h3>
          <ul>
            {go.map((g) => (
              <li key={g.key} className={row}>
                {`Go to ${g.label}`}
                <Keys keys={['G', g.key.toUpperCase()]} />
              </li>
            ))}
            <li className={row}>
              Search and run commands
              <Keys keys={[mod, 'K']} chord />
            </li>
            {assistantOn ? (
              <li className={row}>
                Open or close Coworker
                <Keys keys={[assistant]} />
              </li>
            ) : null}
            <li className={`${row} max-md:hidden`}>
              Collapse or expand the sidebar
              <Keys keys={[sidebar]} />
            </li>
            <li className={row}>
              This list
              <Keys keys={['?']} />
            </li>
          </ul>
        </section>
        {pageGroups.map((g) => (
          <section key={g.id} className="border-t px-4 pt-3 pb-2">
            <h3 className="caption mb-1">{g.title}</h3>
            <ul>
              {g.items.map((it) => (
                <li key={it.label} className={row}>
                  {it.label}
                  <Keys keys={it.keys.map((k) => (k === 'Mod' ? mod : k))} chord={it.chord} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </SheetContent>
    </Sheet>
  );
}

/**
 * The Approvals count: a filled `wait` pill, the shell's one call for attention. Its number is
 * drawn for the eye; the link's name carries it for screen readers ("Approvals, 3 waiting").
 */
const COUNT =
  'min-w-4 rounded-full bg-wait px-1.5 text-center font-medium text-2xs text-background leading-4 tabular-nums';

/**
 * A page's name with what waits on it ("Approvals, 3 waiting"), as the link's `aria-label`: it
 * starts with the visible name, so a voice command still finds it. An sr-only span would be read
 * as a block, with a stray space before the comma.
 */
const waitingName = (label: string, count: number) =>
  count ? `${label}, ${approvalsCountLabel(count)} waiting` : undefined;

/** Colour changes named so they leave the focus outline alone. */
const tint = 'transition-[color,background-color,border-color]';

/** Where a navigation is heading (so the link you chose marks at once), else where you are. */
function useCurrentPath() {
  const { pathname } = useLocation();
  const navigation = useNavigation();
  return navigation.state === 'loading' && !navigation.formMethod
    ? navigation.location.pathname
    : pathname;
}

/** True once a navigation has taken longer than `after` ms; quick ones never flash a cue. */
function useSlowNavigation(after = 400) {
  const loading = useNavigation().state === 'loading';
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const t = window.setTimeout(() => setSlow(true), after);
    return () => window.clearTimeout(t);
  }, [loading, after]);
  return slow;
}

/** Under the top bar while a page is slow to arrive. */
function PendingBar() {
  return useSlowNavigation() ? (
    <div className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden" aria-hidden="true">
      <div className="cw-pending h-full w-2/5 bg-link" />
    </div>
  ) : null;
}

export default function Shell() {
  // A page that draws itself whole (setup's last step) gets the providers, not the frame.
  const bare = useMatches().some((m) => (m.handle as { bare?: boolean } | undefined)?.bare);
  return (
    <CmsProviders>
      <AssistantProvider>
        <TooltipProvider>{bare ? <Outlet /> : <ShellFrame />}</TooltipProvider>
      </AssistantProvider>
    </CmsProviders>
  );
}

/**
 * The assistant (with its markdown renderer) is a large chunk most page views never use: it loads
 * on first open, and is fetched ahead while the browser is idle so opening it stays instant.
 */
const loadPanel = () => import('~/cms/components/assistant/panel');
const AssistantPanel = lazy(() => loadPanel().then((m) => ({ default: m.AssistantPanel })));

/** Mounts the assistant panel once it has been opened, and preloads it when the page is idle. */
function LazyAssistantPanel() {
  // A page's edit goes through the assistant too, so it mounts the panel (closed) to send it.
  const { enabled, open, acts } = useAssistant();
  const [wanted, setWanted] = useState(open);
  useEffect(() => {
    if (open || acts.length) setWanted(true);
  }, [open, acts.length]);
  useEffect(() => {
    if (!enabled) return;
    const preload = () => void loadPanel();
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(preload, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(preload, 2000);
    return () => clearTimeout(t);
  }, [enabled]);
  return enabled && wanted ? (
    <Suspense fallback={null}>
      <AssistantPanel />
    </Suspense>
  ) : null;
}

/** Opens and closes the assistant, from the header or with ⌘J (Ctrl+J) anywhere. */
function AssistantToggle() {
  const { enabled, open, setOpen, focus } = useAssistant();
  const shortcut = useShortcutLabel('J');
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (open) setOpen(false);
        else focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, open, setOpen, focus]);
  if (!enabled) return null;
  return (
    <button
      type="button"
      onClick={() => (open ? setOpen(false) : focus())}
      aria-pressed={open}
      aria-keyshortcuts="Meta+J Control+J"
      title={open ? `Close Coworker (${shortcut})` : `Ask Coworker (${shortcut})`}
      className={cn(
        'hit-area flex h-8 items-center gap-2 rounded-4xl border px-3 text-ui',
        tint,
        open
          ? 'border-foreground/25 bg-accent font-medium text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {/* An agent at rest is the mark in the AI tone (DESIGN.md). */}
      <Mark className="size-4 text-ai" />
      {/* Named by its word (visible from sm), so a voice command can say it. */}
      <span className="max-sm:sr-only">Coworker</span>
    </button>
  );
}

/** Canvas pages, whose graph wants the width: the workflow editor. */
const canvasAt = (path: string) => /^\/workflows\/[^/]+$/.test(path);

function ShellFrame() {
  const slow = useSlowNavigation();
  const { auth, me, nav: showNav, sidebarOpen } = useLoaderData<typeof loader>();
  const features = useFeatures();
  const pages = useMemo(() => visibleNav(features), [features]);
  const go = useMemo(() => goKeys(pages), [pages]);
  const groups = showNav ? navGroups(pages) : [];
  const deployment = showNav && atLeast(me.role, 'admin') ? DEPLOYMENT : [];
  const path = useCurrentPath();
  const [shortcuts, setShortcuts] = useState(false);
  const openShortcuts = useCallback(() => setShortcuts(true), []);
  useGoKeys(go, openShortcuts);
  // The command palette's "Keyboard shortcuts" opens the same sheet.
  useEffect(() => {
    window.addEventListener(OPEN_SHORTCUTS_EVENT, openShortcuts);
    return () => window.removeEventListener(OPEN_SHORTCUTS_EVENT, openShortcuts);
  }, [openShortcuts]);
  // Below lg, on a canvas and beside the assistant's column below xl, the sidebar is a rail that
  // opens over the page. Asked as "narrow" so the server (which can't see the viewport) assumes
  // wide; CSS keeps it a rail below lg anyway.
  const narrow = useMedia('(max-width: 1023.98px)');
  const xl = useMedia('(min-width: 1280px)');
  const assistantOpen = useAssistant().open;
  // What waits on a decision, once the space is known and while Approvals is on.
  const ready = Boolean(useOptionalClient()?.ready);
  const pending = usePendingApprovalsCount(showNav && ready && pages.some((p) => p.badge)) ?? 0;
  const overlay = narrow || canvasAt(path) || (assistantOpen && !xl);
  return (
    <SidebarProvider
      defaultOpen={sidebarOpen}
      overlay={overlay}
      // The rail clears a phone's notch on its side.
      style={{ '--sidebar-width-icon': 'calc(3.25rem + var(--safe-left))' } as React.CSSProperties}
      className="min-h-dvh"
    >
      <ClosePeekOnNavigation />
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-card px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      {showNav ? (
        <AppSidebar
          groups={
            deployment.length ? [...groups, { title: 'Deployment', items: deployment }] : groups
          }
          path={path}
          pending={pending}
          onShortcuts={openShortcuts}
        />
      ) : null}
      <SidebarInset>
        {/* 3rem tall with its rule, under the status bar's inset: full-height pages subtract
            --shell-h (app.css). From md the sidebar holds the brand, the pages and the account, so
            this holds the scope and what acts on the page. */}
        <header className="sticky top-0 z-40 border-b bg-background pt-safe-0">
          <div className="flex h-[calc(3rem-1px)] items-center gap-3 px-safe-4 sm:px-safe-5 md:pl-5">
            <Link
              to="/dashboard"
              className={cn(
                'hit-area -mx-1.5 flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 font-semibold tracking-title text-base',
                showNav && 'md:hidden',
              )}
              aria-label="CommerceWorker overview"
            >
              <Mark className="size-5 text-brand" />
              <span>CommerceWorker</span>
            </Link>
            {/* Where you are, from md (below it the page's own title says so). */}
            {showNav ? <ShellCrumbs /> : null}
            {/* The space, environment and locale every CMS screen works in (on a phone, in More). */}
            {showNav ? (
              <div className="hidden min-w-0 lg:flex">
                <SpaceSwitcher />
              </div>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {showNav ? <ShellNewEntry path={path} covered={assistantOpen} /> : null}
              {showNav ? <SearchButton /> : null}
              {showNav ? <AssistantToggle /> : null}
              {/* Without the sidebar (two-factor still due), the account menu stays up here. */}
              {showNav ? null : (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`${shortWho(me)}, account menu`}
                    title={who(me)}
                    className={cn(
                      'hit-area hidden h-8 items-center gap-2 rounded-4xl border px-3 text-ui text-muted-foreground hover:bg-accent hover:text-foreground md:flex data-[state=open]:bg-accent data-[state=open]:text-foreground',
                      tint,
                    )}
                  >
                    <UserRound className="size-4" aria-hidden="true" />
                    <span className="max-w-40 truncate">{shortWho(me)}</span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <AccountItems me={me} auth={auth} onShortcuts={openShortcuts} />
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {/* Signing out is a POST; the account menu's item submits this. */}
              <form id="sign-out" method="post" action="/logout" hidden />
            </div>
          </div>
          <PendingBar />
        </header>
        {/* The page, and the assistant's column beside it from lg (a sheet over it below). */}
        <div className="flex min-h-0 flex-1">
          <main
            id="main"
            tabIndex={-1}
            aria-busy={slow || undefined}
            className={cn(
              'min-w-0 flex-1 pb-[var(--tabbar-h)] outline-none md:pb-0',
              // The floating New entry (2.75rem, 0.75rem above the tab bar) never covers the last
              // row's actions: the page scrolls clear of it.
              showNav && floatsNewEntry(path, assistantOpen) && 'pb-[calc(var(--tabbar-h)+4.5rem)]',
            )}
          >
            <Outlet />
          </main>
          {showNav ? <LazyAssistantPanel /> : null}
        </div>
      </SidebarInset>
      {showNav ? (
        <TabBar path={path} pages={pages} deployment={deployment} pending={pending} />
      ) : null}
      {showNav ? <ShortcutsSheet go={go} open={shortcuts} onOpenChange={setShortcuts} /> : null}
      {showNav ? <CommandPalette /> : null}
    </SidebarProvider>
  );
}

/** Rows a finger can hit: 44px on touch, the preset's 36px otherwise. */
const ROW = 'touch:h-11';

/**
 * Every page, from md, on shadcn's Sidebar (`@commerceworker/ui/sidebar`): the brand row on the
 * header's line, whose mark is the toggle (⌘\); the day's work; Build, Library, Settings and,
 * for admins, Deployment; the account at its foot.
 */
function AppSidebar({
  groups,
  path,
  pending,
  onShortcuts,
}: {
  groups: { title?: string; items: NavItem[] }[];
  path: string;
  /** Items waiting in Approvals (0 when none, or not yet known). */
  pending: number;
  onShortcuts: () => void;
}) {
  const { me, auth } = useLoaderData<typeof loader>();
  const { state } = useSidebar();
  const expanded = state === 'expanded';
  const shortcut = useShortcutLabel('\\');
  return (
    <Sidebar className="pl-(--safe-left)">
      {/* On the header's line: its height, its inset and its rule. */}
      <SidebarHeader className="h-(--shell-h) shrink-0 justify-end gap-0 border-sidebar-border border-b px-2 pt-safe-0 pb-0">
        <div className="flex h-[calc(3rem-1px)] items-center gap-2 px-0.5">
          <SidebarTrigger
            aria-label="Sidebar"
            aria-controls="sidebar-nav"
            aria-keyshortcuts="Meta+\ Control+\"
            title={`${expanded ? 'Collapse' : 'Expand'} the sidebar (${shortcut})`}
            className="hit-area"
          >
            <Mark className="size-5 text-brand" />
          </SidebarTrigger>
          <span className="truncate font-semibold text-base tracking-title transition-opacity duration-(--motion-instant) @max-[8rem]:opacity-0">
            CommerceWorker
          </span>
        </div>
      </SidebarHeader>
      <SidebarContent className="py-1">
        <nav id="sidebar-nav" aria-label="Main">
          {groups.map(({ title, items }) => {
            const id = title ? `sidebar-${title.toLowerCase().replace(/\W+/g, '-')}` : undefined;
            return (
              <SidebarGroup key={title ?? 'work'} className="py-1">
                {title ? <SidebarGroupLabel id={id}>{title}</SidebarGroupLabel> : null}
                <SidebarMenu aria-labelledby={id}>
                  {items.map((item) => {
                    const here = isAt(path, item);
                    const Icon = item.icon;
                    const count = item.badge ? pending : 0;
                    return (
                      <SidebarMenuItem key={item.to}>
                        <SidebarMenuButton
                          asChild
                          isActive={here}
                          tooltip={waitingName(item.label, count) ?? item.label}
                          className={ROW}
                        >
                          {/* A Link, not a NavLink: the shell decides what is current (`here`), and
                              a NavLink would drop that aria-current wherever its own `to` doesn't
                              match (a Settings group on any section but its first). */}
                          <Link
                            to={item.to}
                            aria-current={here ? 'page' : undefined}
                            aria-label={waitingName(item.label, count)}
                          >
                            {Icon ? (
                              <Icon
                                className={here ? 'text-brand' : 'text-muted-foreground'}
                                aria-hidden="true"
                              />
                            ) : null}
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                        {count ? (
                          <>
                            <SidebarMenuBadge aria-hidden="true">
                              <span data-approvals-count className={COUNT}>
                                {approvalsCountLabel(count)}
                              </span>
                            </SidebarMenuBadge>
                            {/* As a rail, a dot at the icon's corner, ringed in the row's own ground. */}
                            <span
                              aria-hidden="true"
                              data-approvals-dot
                              className={cn(
                                'pointer-events-none absolute top-[calc(50%-0.625rem)] left-[1.375rem] hidden size-2 rounded-full bg-wait ring-2 @max-[8rem]:block',
                                here
                                  ? 'ring-sidebar-accent'
                                  : 'ring-sidebar group-hover/menu-item:ring-sidebar-accent',
                              )}
                            />
                          </>
                        ) : null}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroup>
            );
          })}
        </nav>
      </SidebarContent>
      {/* Who is signed in, their account, the shortcuts, the theme, and signing in or out. */}
      <SidebarFooter className="border-sidebar-border border-t pb-safe-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <SidebarMenuButton asChild tooltip={shortWho(me)} className={ROW}>
                <DropdownMenuTrigger
                  aria-label={`${shortWho(me)}, account menu`}
                  title={expanded ? who(me) : undefined}
                >
                  <UserRound className="text-muted-foreground" aria-hidden="true" />
                  <ChevronsUpDown
                    className="absolute right-2.5 text-muted-foreground @max-[8rem]:hidden"
                    aria-hidden="true"
                  />
                  <span className="pr-5">{shortWho(me)}</span>
                </DropdownMenuTrigger>
              </SidebarMenuButton>
              <DropdownMenuContent
                side={expanded ? 'top' : 'right'}
                align={expanded ? 'start' : 'end'}
                className="w-56"
              >
                <AccountItems me={me} auth={auth} onShortcuts={onShortcuts} />
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** Closes the sidebar opened over the page when a navigation lands. */
function ClosePeekOnNavigation() {
  const { pathname } = useLocation();
  const { setPeek } = useSidebar();
  useEffect(() => setPeek(false), [pathname, setPeek]);
  return null;
}

/**
 * Phones: the main pages as tabs along the bottom, in thumb reach and clear of the home
 * indicator, and More for everything else.
 */
function TabBar({
  path,
  pages,
  deployment,
  pending,
}: {
  path: string;
  pages: typeof PAGES;
  deployment: NavItem[];
  pending: number;
}) {
  const { pathname } = useLocation();
  const [more, setMore] = useState(false);
  // A link in the sheet closes it by navigating; so does the back button (pathname is the trigger).
  useEffect(() => setMore(false), [pathname]);
  const tabs = pages.filter((p) => p.tab);
  const inTab = tabs.some((t) => isAt(path, t));
  const item = cn(
    'relative flex flex-col items-center justify-center gap-0.5 text-2xs short:gap-0',
    tint,
  );
  const state = (active: boolean) =>
    active
      ? 'font-medium text-foreground current-item [&>svg]:text-brand'
      : 'text-muted-foreground';
  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 h-[var(--tabbar-h)] border-t bg-background px-safe-0 pb-[var(--safe-bottom)] md:hidden"
      >
        <ul
          className="grid h-full"
          style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, 1fr)` }}
        >
          {tabs.map((t) => {
            const count = t.badge ? pending : 0;
            return (
              <li key={t.to} className="contents">
                <NavLink
                  to={t.to}
                  aria-label={waitingName(t.label, count)}
                  className={cn(item, state(isAt(path, t)))}
                >
                  <t.icon className="size-5" aria-hidden="true" />
                  <span className="short:sr-only">{t.label}</span>
                  {/* After the label in reading order, a space between (it is placed over the
                      icon, and a flex column draws no space): the tab's visible text is then
                      "Approvals 3", inside its name "Approvals, 3 waiting", so a voice command
                      naming what is on screen still finds it. */}
                  {count ? ' ' : null}
                  {count ? (
                    <span
                      aria-hidden="true"
                      data-approvals-count
                      className={cn(COUNT, 'absolute top-1 left-1/2 ml-1')}
                    >
                      {approvalsCountLabel(count)}
                    </span>
                  ) : null}
                </NavLink>
              </li>
            );
          })}
          <li className="contents">
            <button
              type="button"
              onClick={() => setMore(true)}
              aria-haspopup="dialog"
              aria-expanded={more}
              className={cn(item, state(more || !inTab))}
            >
              <Ellipsis className="size-5" aria-hidden="true" />
              <span className="short:sr-only">More</span>
            </button>
          </li>
        </ul>
      </nav>
      <Sheet open={more} onOpenChange={setMore}>
        <SheetContent side="bottom" className="md:hidden" bodyClassName="gap-0">
          <MoreMenu
            pages={pages
              .filter((p) => !p.tab)
              .map(({ to, label, section }) => ({
                to: section === 'Settings' ? settingsPath(DEFAULT_SETTINGS_SECTION) : to,
                label,
              }))}
            deployment={deployment}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The More sheet: the pages without a tab, the deployment's, then account, theme and sign-out. */
function MoreMenu({ pages, deployment }: { pages: NavItem[]; deployment: NavItem[] }) {
  const { me, auth } = useLoaderData<typeof loader>();
  const theme = useTheme();
  const row =
    'flex min-h-11 items-center justify-between gap-3 rounded-lg px-3 text-base not-aria-[current=page]:hover:bg-accent/60 aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:current-item relative';
  const heading = 'caption px-3 pt-2 pb-1';
  const list = (items: NavItem[]) => (
    <ul>
      {items.map(({ to, label, end }) => (
        <li key={to}>
          <NavLink to={to} end={end} className={row}>
            {label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <div className="border-b px-4 pt-4 pb-3 pr-14">
        <SheetTitle className="truncate">{who(me)}</SheetTitle>
        <SheetDescription className="text-xs">{ROLE_LABELS[me.role]}</SheetDescription>
      </div>
      <div className="border-b px-4 py-3">
        <h2 className="caption mb-2">Working in</h2>
        <SpaceSwitcher stacked />
      </div>
      <div className="max-h-[50dvh] overflow-y-auto p-2">
        <h2 className={heading}>Pages</h2>
        {list(pages)}
        {deployment.length ? (
          <>
            <h2 className={cn(heading, 'pt-3')}>Deployment</h2>
            {list(deployment)}
          </>
        ) : null}
      </div>
      <div className="border-t p-2">{list([{ to: '/account', label: 'Account' }])}</div>
      <fieldset className="border-t px-4 pt-3 pb-3">
        <legend className="caption float-left mb-2 w-full">Theme</legend>
        <Segmented
          aria-label="Theme"
          value={theme.choice}
          onValueChange={(v) => theme.setChoice(v as typeof theme.choice)}
          className="clear-left grid w-full"
        >
          {THEMES.map(({ value, label, icon: Icon }) => (
            <SegmentedItem key={value} value={value} className="min-h-10">
              <Icon aria-hidden="true" />
              {value === 'system' ? 'System' : label}
            </SegmentedItem>
          ))}
        </Segmented>
      </fieldset>
      {auth ? (
        <div className="border-t p-2">
          <form method="post" action="/logout">
            <button type="submit" className={cn(row, 'w-full text-left')}>
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}

/** How the signed-in person is named: their email, or open local development. */
const who = (me: Principal) => (me.kind === 'user' ? (me.email ?? me.name) : 'Sign-in is off');

/** The same, short enough for the account button. */
const shortWho = (me: Principal) =>
  me.kind === 'user' ? me.name : `${ROLE_LABELS[me.role]}, no sign-in`;

/** Who is signed in, their account, the keyboard shortcuts, the theme, and signing in or out. */
function AccountItems({
  me,
  auth,
  onShortcuts,
}: {
  me: Principal;
  auth: boolean;
  onShortcuts: () => void;
}) {
  const admin = atLeast(me.role, 'admin');
  const theme = useTheme();
  return (
    <>
      <DropdownMenuLabel className="font-normal">
        <span className="block truncate font-semibold text-foreground text-sm" title={who(me)}>
          {who(me)}
        </span>
        <span className="text-muted-foreground text-xs">{ROLE_LABELS[me.role]}</span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link to="/account">Account</Link>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onShortcuts} className="hidden justify-between fine:flex">
        Keyboard shortcuts
        <kbd className="font-normal font-sans text-2xs text-muted-foreground">?</kbd>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="caption">Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={theme.choice}
        onValueChange={(v) => theme.setChoice(v as ThemeChoice)}
      >
        {THEMES.map(({ value: v, label, icon: Icon }) => (
          <DropdownMenuRadioItem key={v} value={v}>
            <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {auth || admin ? <DropdownMenuSeparator /> : null}
      {auth ? (
        <DropdownMenuItem asChild>
          {/* The form sits outside the menu, which unmounts as it closes. */}
          <button type="submit" form="sign-out" className="w-full">
            Sign out
          </button>
        </DropdownMenuItem>
      ) : admin ? (
        <DropdownMenuItem asChild>
          <Link to="/team">Set up sign-in</Link>
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

/** ⌘K: every page, action, content type and entry (cms/components/layout/CommandPalette). */
function SearchButton() {
  const mod = useModKeyLabel();
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      title={`Search pages, entries and commands (${mod}K)`}
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        'hit-area flex h-8 items-center gap-2 rounded-4xl border px-3 text-muted-foreground text-ui hover:bg-accent hover:text-foreground',
        tint,
      )}
    >
      <Search className="size-4" aria-hidden="true" />
      {/* Named by its word (visible from sm), so a voice command can say it. */}
      <span className="max-sm:sr-only">Search</span>
    </button>
  );
}

/** The header's breadcrumbs, once a space is in scope (they name types and entries from it). */
function ShellCrumbs() {
  if (!useOptionalClient()?.ready) return null;
  return (
    <div className="hidden min-w-0 text-ui md:flex">
      <Breadcrumbs pages={OUTSIDE_NAV} />
    </div>
  );
}

/**
 * New entry, in the header once the space is known: an outline on Approvals and Workflows, where
 * starting an entry isn't the page's point (cms/components/layout/NewEntry).
 */
/**
 * Phones: New entry floats above the tab bar on Content's lists, where it's the page's next step
 * (not in the editor, which keeps its own actions there), and not over the assistant's sheet, where
 * it would sit on the send button. The page leaves room for it below its last row.
 */
const floatsNewEntry = (path: string, covered: boolean) =>
  !covered && /^\/content(\/[^/]+)?$/.test(path);

function ShellNewEntry({ path, covered }: { path: string; covered: boolean }) {
  if (!useOptionalClient()?.ready) return null;
  const quiet = path.startsWith('/approvals') || path.startsWith('/workflows');
  const float = floatsNewEntry(path, covered);
  return (
    <>
      <span className="hidden md:contents">
        <NewEntry look="header" quiet={quiet} />
      </span>
      {float ? <NewEntry look="float" /> : null}
    </>
  );
}
