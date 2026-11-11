---

name: commerceworker admin
description: The editors' and developers' console. Ledger on a desktop, an iPad and an iPhone, in a tab or on the Home Screen.
colors:
paper: "oklch(1 0 0)"
ink: "oklch(0.145 0 0)"
primary: "oklch(0.205 0 0)"
primary-foreground: "oklch(0.985 0 0)"
muted: "oklch(0.97 0 0)"
muted-foreground: "oklch(0.52 0 0)"
rule: "oklch(0.922 0 0)"
input: "oklch(0.922 0 0)"
ring: "oklch(0.556 0 0)"
link: "oklch(0.47 0.105 235)"
destructive: "oklch(0.48 0.185 27.325)"
ok: "oklch(0.455 0.105 152)"
wait: "oklch(0.49 0.115 62)"
bad: "oklch(0.5 0.185 28)"
undo: "oklch(0.485 0.135 42)"
idle: "oklch(0.48 0 0)"
brand: "oklch(0.45 0.19 262)"
brand-foreground: "oklch(0.985 0 0)"
brand-subtle: "oklch(0.955 0.02 262)"
ai: "oklch(0.49 0.16 310)"
sidebar: "oklch(0.985 0 0)"
sidebar-accent: "oklch(0.945 0 0)"
paper-dark: "oklch(0.145 0 0)"
card-dark: "oklch(0.205 0 0)"
ink-dark: "oklch(0.985 0 0)"
muted-dark: "oklch(0.269 0 0)"
muted-foreground-dark: "oklch(0.708 0 0)"
link-dark: "oklch(0.76 0.1 238)"
brand-dark: "oklch(0.72 0.13 262)"
brand-subtle-dark: "oklch(0.27 0.06 262)"
ai-dark: "oklch(0.75 0.09 305)"
destructive-dark: "oklch(0.78 0.12 22.216)"
typography:
title:
fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
fontSize: "1.75rem"
fontWeight: 600
lineHeight: 1.25
letterSpacing: "-0.015em"
section-title:
fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
fontSize: "15px"
fontWeight: 600
lineHeight: 1.3
body:
fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
fontSize: "0.875rem"
fontWeight: 400
lineHeight: 1.43
ui:
fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
fontSize: "0.8125rem"
fontWeight: 400
caption:
fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif"
fontSize: "0.6875rem"
fontWeight: 500
lineHeight: 1.4
letterSpacing: "0.05em"
mono:
fontFamily: "IBM Plex Mono, ui-monospace, SF Mono, Menlo, monospace"
fontSize: "0.75rem"
fontWeight: 400
rounded:
sm: "0.375rem"
md: "0.5rem"
lg: "0.625rem"
xl: "0.875rem"
2xl: "1.125rem"
3xl: "1.375rem"
4xl: "1.625rem"
full: "9999px"
spacing:
gutter-phone: "1rem"
gutter: "1.5rem"
page-width: "87.5rem"
measure: "55ch"
components:
button-primary:
backgroundColor: "{colors.primary}"
textColor: "{colors.primary-foreground}"
rounded: "{rounded.4xl}"
height: "2.25rem"
padding: "0 0.75rem"
button-outline:
backgroundColor: "{colors.paper}"
textColor: "{colors.ink}"
rounded: "{rounded.4xl}"
height: "2.25rem"
padding: "0 0.75rem"
input:
textColor: "{colors.ink}"
rounded: "{rounded.4xl}"
height: "2.25rem"
padding: "0.25rem 0.75rem"
card:
backgroundColor: "{colors.paper}"
textColor: "{colors.ink}"
rounded: "{rounded.2xl}"
tile:
backgroundColor: "{colors.muted}"
rounded: "{rounded.xl}"
padding: "1rem"
status-badge:
rounded: "{rounded.full}"
padding: "0.125rem 0.5rem"
---

# Design System: CommerceWorker admin

## Overview

The console where editors write, review and publish content, and developers model it and wire it
up. Its visual system is **Ledger**: shadcn's base-maia preset (neutral greys, Inter, pill buttons
and fields) on Radix primitives in `packages/ui`, with status tokens (`ok`, `wait`, `bad`, `undo`,
`run`, `idle`, `ai`) that mean one thing each. The tokens live in `apps/studio/app/app.css`, mirrored
as data in `packages/design` (a test holds them together). This file is about how the admin is
laid out and operated across screens; PRODUCT.md holds the users, register and principles.

Paths below are under `apps/studio/app/`: the shell and sign-in pages in `routes/` and
`components/`, the CMS screens in `cms/routes/`, `cms/components/` and `cms/lib/`. Primitives
(`Table`, `Sidebar`, `Dialog`, …) are `@commerceworker/ui/*` from `packages/ui/src`.

## Colors

Neutral greys with no tint carry everything; colour is reserved for the brand cobalt, one sky blue and
status.

### Primary

- **Ink** (`primary`, near-black): primary buttons and the New entry button. The big fills stay
  ink, so the accent never shouts.

### Accent

- **Brand** (`brand`, cobalt, hue 262): CommerceWorker's accent, the colour of its mark. It marks where you
  are and what you chose: the mark (sidebar, top bar, sign-in); the current item, in one rule
  everywhere (the sidebar, a page's own list such as Settings sections, content types, asset
  folders and taxonomy schemes) is its accent fill, ink and 500, with its icon in brand when it has
  one (the phone's tab bar has no fill: its tab is ink 500 with a brand icon). No tick or stripe at
  its edge. Hover is a step lighter than the current fill and never lands on the current item, so
  a resting pointer never reads as a second current page (nor does an open menu's or a pressed
  row's fill); under forced colours, which override the fill, the item takes a hairline outline
  (`current-item`), except while focused, when the focus outline shows. The active tab's underline;
  focus (`ring` and the page-wide outline); checked checkboxes, switches and radio items and the
  chosen option card; the text selection and the caret. `brand-subtle` is its tint, for a chosen
  chip. Never a button fill, never a background wash. Its edge holds 3:1 and its words 4.5:1 on
  paper, cards, muted fills and the sidebar in both themes; on a brand fill, words are
  `brand-foreground`. Figures, measured by `packages/design/tests/accent.test.ts`:

  | Pair | Light | Dark |
  | --- | --- | --- |
  | `brand-foreground` on a `brand` fill | 7.45:1 | 7.91:1 |
  | `brand` words, and the `ring` edge, on paper | 7.78:1 | 7.91:1 |
  | `brand` on a card | 7.78:1 | 7.16:1 |
  | `brand` on muted, the worst ground | 7.13:1 | 6.04:1 |
  | `brand` on `sidebar-accent` | 6.62:1 | 6.04:1 |
  | `brand` words on `brand-subtle` | 6.82:1 | 6.05:1 |
  | muted words on `brand-subtle` | 4.83:1 | 5.84:1 |

  The hue is 262: 27 degrees (light) and 24 degrees (dark) from the link, 43 or more from `ai`
  and 110 or more from every status. The test holds each distance at 20 degrees or more, and the
  accent more saturated than the link.

### Secondary

- **Work blue** (`link`, sky, hue 235 light and 238 dark): links, live work (`run`) and the
  slow-page bar. Never a fill for a button. It sits apart from the cobalt `brand` so a link is never
  mistaken for a chosen or current thing.

### Destructive

- **Destructive** (`destructive`): the red of an act that removes something for good: the tinted
  pill that confirms it (an inline confirm, a destructive menu item), field errors. It is an
  action's colour, not a status (failed is `bad`). Set so the pill's words hold 4.5:1 on their own
  tint over a tile, at rest and on hover, in both themes, on paper and on a dark card (5.70:1 light,
  5.09:1 dark at rest); the preset's red read 3.76:1.

### Neutral

- **Paper** (`paper`): the page and the card. In dark the page is near-black and cards lift a step
  (`card-dark`).
- **Sidebar** (`sidebar`): half a step under the paper, so the page reads as the surface and the
  sidebar as its frame; the current page is `sidebar-accent`, a step deeper.
- **Muted** (`muted`): tiles, segmented tracks, hover fills.
- **Muted text** (`muted-foreground`): secondary text and captions. Set to hold 4.5:1 on paper,
  on muted and on a tile.
- **Rule** and **Input** (`rule`, `input`): hairlines, and the edge and faint fill of fields.
- **Ring** (`ring`): the brand, as the focus edge on fields and buttons and the page-wide focus
  outline; it holds 3:1 on paper and on muted fills.

### Status

Each CommerceWorker status maps to one token (`cms/lib/format.ts` `statusTone`), and every badge, dot
and chart series for a status reads it through `var()`, so it switches with the theme:

| Token             | Means                       | CommerceWorker statuses                                                            |
| ----------------- | --------------------------- | --------------------------------------------------------------------------------- |
| `ok`              | succeeded, live             | published, active, completed, delivered, enabled, merged                          |
| `wait`            | waits on a person           | changed (edited since publish), pending, in review, paused, unsaved changes       |
| `run` (work blue) | in progress or on a clock   | scheduled, running, queued, processing                                            |
| `idle`            | at rest, or ended otherwise | draft, open (release), archived, revoked, expired, disabled, cancelled            |
| `bad`             | failed                      | failed, error, rejected, removed                                                  |
| `undo`            | taken back                  | rolled back, reverted                                                             |
| `ai`              | a model's work              | proposed, suggested, generated, needs review, held (agent output awaiting review) |

### Named Rules

**The Green Means Done Rule.** `ok` is the only green, and it means "succeeded" or "live". No green
brand, no green button, no green decoration.

**The One Meaning Rule.** A status colour is never used decoratively. If it isn't a status, it is
grey. `ai` is the one status with a hue of its own, violet (310): a model's work reads as neither a
link nor a chosen thing. Cobalt means "CommerceWorker: here or chosen", and a status never relies on
a hue alone (an AI badge says so in words).

## Typography

**Body Font:** Inter Variable (with the system sans)
**Label/Mono Font:** IBM Plex Mono, for ids, API ids, keys, versions, URLs and code

**Character:** one quiet sans for everything, set small and dense for people who live in the tool,
with Plex Mono only where a value must be read character by character.

### Hierarchy

- **Title** (600, 1.75rem, 1.25, -0.015em, `tracking-title`): a page's h1. It wraps; it is never
  truncated (an entry's title included).
- **Section title** (600, 15px, 1.3, `section-title`): a card's heading, in sentence case.
- **Body** (400, 0.875rem): running text, rows, fields.
- **UI** (400, 0.8125rem, `text-ui`): the header's controls, segmented controls, compact controls.
- **Caption** (500, 0.6875rem: 11px, 0.05em, UPPERCASE, `caption`): field, column and fact labels,
  and the group labels in the sidebar, menus and sheets. The only uppercase in the product.
- **2xs** (0.6875rem, `text-2xs`): counts and key hints in the bars.

### Named Rules

**The Sentence Case Rule.** Titles, buttons and menu items are sentence case ("New entry", "Publish
selected"). Only captions are uppercase, and never in mono. Status words are humanized
("In review", "Rolled back").

**The Scale Lives In The Theme Rule.** Sizes come from the theme (`text-ui`, `text-2xs`,
Tailwind's steps), not hand-written pixel values, so they grow with the reader's text size.

**The Measure Rule.** Running text, a page's intro under its title (`PageHeader`) and helper lines
alike are held to `max-w-measure` (55ch), not a hand-written `max-w-[…ch]`.

## Screens and breakpoints

Tailwind's default breakpoints, read as devices:

| Width                     | Typically                 | What changes                                                                                                                                                                      |
| ------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| below `sm` (640px)        | iPhone upright            | Header shows the mark, and Search and Coworker as icons; the scope (space, environment, locale) opens from More; dialogs and form sheets come from the bottom                     |
| below `md` (768px)        | phones, either way up     | Bottom tab bar, no sidebar; tables stack into cards; the content-type list leaves the Content pages (their overview lists the types)                                              |
| `md` to `lg` (768–1023px) | iPad upright              | The sidebar is an icon rail beside the page and opens over it                                                                                                                     |
| `lg` and up (1024px)      | iPad on its side, desktop | The full sidebar (the reader can collapse it); the space, environment and locale switchers in the header; the entry editor's side pane beside the form; the assistant as a column |
| `xl` and up (1280px)      | desktop                   | The full sidebar and the assistant's column side by side                                                                                                                          |

Size and hint by what is pointing, not by width: `touch:` is a coarse pointer (a finger), `fine:` a
mouse or trackpad. `short:` is a phone on its side (landscape, under 32rem tall, under 64rem wide).

## The shell

`routes/shell.tsx` (with `routes/in-app.tsx` as the error boundary inside it); `cms/components/
layout/nav.ts` is the one source of the pages, their order, names, icons and G-letters.

- **Sidebar (from md):** shadcn's Sidebar (radix-maia), in
  `packages/ui/src/sidebar.tsx`. Full height on its own ground, with a rule. From the top: the brand
  row on the header's line, whose mark is the `SidebarTrigger` (named "Sidebar", ⌘\ or Ctrl+\);
  the day's work (Overview, Content, Approvals when on, Releases) with no label; then groups
  labelled as captions: **Build** (Workflows), **Library** (Assets, Taxonomy) and **Settings**
  (Access, Automation, Extensions, Workspace: Settings' own section groups, each opening its first
  section and reading as current on any of its sections); the account at its foot; `SidebarRail`
  on its edge (for a mouse; on touch the mark is the toggle). The page you're on is
  `sidebar-accent`, 500 and its icon in brand (the tab bar marks its tab with an ink label and a
  brand icon); hover, press and an open menu are `sidebar-accent` at 60%, never on the current row; with `aria-current`, marked as soon as it is chosen, not when its page arrives. Group
  labels are captions. On touch every row is 44px.
- **Expanded or a rail:** 16rem, or a 3.25rem rail of icons. The reader's choice is the
  `cw_sidebar_state` cookie. Below lg, and beside the assistant's column below xl, the sidebar stays a
  rail and its toggle opens it over the page (`peek`, `shadow-overlay`); Escape, a press outside it
  or a navigation closes it. As a rail, names go to screen readers and a tooltip, group labels keep
  their height as hairlines, and icons stay at the same x.
- **Header:** 3rem plus the status bar's inset (`--shell-h`), sticky, with a rule under it. Below
  md it starts with the mark (a link to Overview). From md it holds the breadcrumbs (where you are:
  an entry reads as its title, never its id), then what acts on the page: the scope, Search (⌘K),
  Coworker (the assistant, when on) and New entry.
- **Scope (CommerceWorker's):** every page works in a space, an environment (a branch) and a locale.
  From xl the three switchers sit in the header; below xl a pill names the environment (the space
  and locale in its accessible name and `title`) and opens them in a sheet; the phone's More sheet
  holds them too. It is never more than one press away.
- **New entry:** in the header's primary-action place. An entry needs a content type: on a content
  type's pages it links straight to that type's new entry; anywhere else it opens a menu of the
  space's content types. On a singleton's pages (a type with one entry only) it opens that entry
  (`/content/:typeId/entry`, which goes to its editor, or to a new one while it has none), and the
  palette offers "Open ‹type›" in place of New and Import entries; the entries page shows no
  Import. Ink, except on Approvals and Workflows, where it steps back to an outline.
  On a phone it is a floating pill (`shadow-float`) above the tab bar on Overview and the Content
  pages; main pads its foot so the last row clears it.
- **Account:** the sidebar's foot. Its menu holds who is signed in (the person, else the kind of
  key), Connection, Keyboard shortcuts (with a fine pointer), the theme (Light, Dark, Match system)
  and Sign out. Its accessible name is that name plus "account menu".
- **Shortcuts** are written for the device (⌘ on Apple, Ctrl elsewhere). G then a letter goes to a
  page (H Overview, C Content, A Approvals, R Releases, W Workflows, M Assets, T Taxonomy, S
  Settings); ? opens the list of every shortcut (a sheet, with whatever the page registers); ⌘K is
  the command palette; ⌘J Coworker when it is on; ⌘\ the sidebar. Single keys go through
  `plainKeyAllowed` (not with a modifier, while typing, or with a dialog, menu or inline confirm
  open) and run before a page's own keys.
- **Transitions** in the bars name their properties (`tint`), never `transition-colors`. The
  shared controls do too, and never animate opacity: a control enabled after a fetch is at full
  contrast in the frame it becomes enabled, not faded up from its disabled 50% (`transition-all`
  once did that, and axe caught an enabled outline button under 4.5:1 mid-fade).
- **One order everywhere:** the sidebar, the tab bar, More, the palette and the G-letters list pages
  in `NAV`'s order.
- **Tab bar (below md):** Overview, Content, Approvals (when on, with its count), Releases, and
  More: the day's work in thumb reach. 3.5rem plus the home indicator (`--tabbar-h`); in `short:`
  2.75rem with the labels for screen readers only. **More reads as the current page** while you're
  on one of its pages. More is a bottom sheet grouped like the sidebar (Pages, Settings), then the
  scope, the theme, the install hint and Sign out. It closes when a page is chosen.
- **Approvals count:** a filled `wait` pill, 99+ past two digits, in the sidebar and on the tab
  bar's Approvals tab (a `wait` dot on the rail): the shell's one call for attention. It counts
  the inbox's own two lists (`cms/lib/approvals.ts`), so deciding an item updates it; it also
  refreshes every minute while the tab is visible. The link's name carries it for screen readers
  ("Approvals, 3 waiting"); on the tab the pill follows the label in reading order, a space
  between (it is drawn over the icon), so the visible "Approvals 3" sits inside that name for
  voice control. Approvals is behind the `approvals` feature (`cms/lib/features.tsx`,
  on): off, it leaves the sidebar, the tab bar, the palette, the shortcuts list and its G-letter.
- **Main** pads its foot by `--tabbar-h` and lays every page in `Body` (the page width and
  gutters), except a canvas: the workflow editor is `bare`, full-bleed beside the rail, and draws
  its own frame and loading skeleton. Never hard-code the bar heights.
- **Coworker (the assistant):** named Coworker everywhere a person sees it (the button, the panel's
  heading and accessible name, its messages, the shortcuts list); `assistant` in code. Behind the `assistant` feature (`cms/lib/features.tsx`, on). A column beside the
  page at lg; below that a sheet between the header and the tab bar,
  taking exactly the area above an on-screen keyboard. Both slide in 200ms on
  `cubic-bezier(0.16,1,0.3,1)` by transform and opacity only: the column takes its 400px at once
  and slides its content in, and gives the width back only after the content has slid out.
  Reduced motion shows and hides it at once. An action waiting for confirmation is pinned above the
  composer in the `wait` tint. ⌘J toggles it (`aria-keyshortcuts`). Escape closes the sheet (the
  column stays) and hands focus back to the page. A page's edits go through it: an action (publish,
  unpublish, the trash, restoring a version, a bulk change) opens the panel at its confirm card
  (Confirm, or Not now, focused, once the panel is open) and the page waits; answered, focus stays
  with the line that replaces the card, never falling to the page's body. A publish card says what
  goes live from the entry's own version diff, never from anything a model wrote (one source with
  `PublishConfirm`: `entries/EntryReview.tsx`): the changed fields by name, then Review changes for
  each field's published and draft values. Confirm stays off until that read has something to show,
  saying why in words (a status line it is described by) and whatever else can answer it: a read
  that fails offers Try again, a card from another space or environment asks to switch back, and one
  that can't say where it runs asks for Not now and a new question. Not now always works, and takes
  focus if Confirm loses it. Fields the person's role can't read aren't listed
  but are counted in a warning Alert ("1 field you can't read goes live."), never "nothing changed". A card the model proposed shows what it would change, read from the
  system and never from the model's words (`assistant/proposal.tsx`): a draft save as the field
  diff from what the draft holds now (Now and After saving; a field the save leaves out is
  removed), a new entry by its fields, a batch by its first five entries' titles and "and N more",
  a tagging by its tags' names, a release by its title, a block patch from its dry run (`POST
  …/entries/blocks/validate`: the api's own checks, nothing written) by its steps, each block named
  by its type's name and label and never by its key, a move or insert saying where it lands ("to
  the end of Body", a move "to the start of Body" and an insert "at the start of Body", "after
  Call to action “Sign up”", "into Section “Features”", or the place by name too when the block
  has several), and Review changes showing each touched slot's order by block name, Now and After
  saving ("Hero · Section · Call to action" → "Section · Call to action · Hero"; a block with no
  key counted in its place, two of one name numbered), each new block's own fields (what Coworker
  would write), and each updated block's own fields matched by key and judged on the stored value,
  never a positional diff of the list; any other one-entry
  action by the entry's title. Open, Review changes replaces the summary list rather than
  repeating it. A block patch that can't be saved as it stands keeps Confirm off and says why,
  from the api's structured answer, never its wording: in a destructive Alert when the draft
  moved past its version, a step doesn't fit (from its code, the block its key names), the result
  would break a rule of the model (the block and its field, "Call to action “Sign up” › Label:
  Field is required"), the role can't change a field, or the role can't change the entry (every
  403 is a refusal, never Try again); in the warning Alert, counted, when it touches a field the
  person can't read; in a note when it changes nothing or the call doesn't say what to change. It
  is held like a publish: Confirm stays off until that read is done, and a read that
  fails offers Try again. A page's own cards list nothing more: the person just pressed for them on
  that entry. Every card says who asked for it in a caption under its title ("You asked for this
  on the page", or the mark in `ai` and "Coworker suggests this") and when, in its margin. Any
  other edit (saving, duplicating) runs at once and leaves a line ("Published · Spring launch
  notes") linking to the entry, with its time in the margin (a `<time>`, outside the link). A
  declined card's line says in the past tense what stayed as it was ("Not published · Spring
  launch notes"), and a finished read says it is done ("Found entries · 10 results"). The
  pinned waiting bar steps aside while its card is in view. A settled edit is announced to screen
  readers as its line reads. When its socket
  is down the panel says so in one quiet line and the page makes the edit itself, confirming in
  place or in a dialog as The Blast Radius Rule says. Beside the column a page is narrower than the screen, so the Content pages'
  content-type list follows the page's width (it shows from 40rem of page), not the breakpoint.
  In that list a singleton links to its one entry (`/content/:typeId/entry`), not a list of one,
  and stays marked current anywhere under the type.
- **Coworker with no space yet:** a deployment admin's Coworker asks what the first space will hold
  ("What will your first space hold?", two suggestions) and proposes one on a `Create this space`
  card that lists what will be made from the call's own input (name, space ID and locales in mono,
  environments, the starter by the deployment's own title); confirmed, it switches into the space
  and offers two questions to try there by starter, never a tour. Anyone else gets a disabled
  composer and who to ask. Its page form is setup's last step (`routes/setup-space.tsx`, a route
  under the shell with `handle.bare`: providers, no sidebar or header): the mark, an h1, then the
  conversation in a card, named by a visually hidden h2; no panel header, no WaitingBar (the card
  is the whole page, so the card is in view) and no ⌘J hint. Below `sm` the card grows with the
  page instead of holding its own scroll, so the composer stays clear of the keyboard. Skip for now
  and Fill in a form instead sit under it as link buttons.
- **Slow pages:** a navigation that takes over 400ms draws a link-blue rule sweeping under the
  header and marks main `aria-busy`. Quicker ones show nothing.
- **Route announcer:** after a client-side navigation, the new page's h1 is read out in a polite
  live region. Focus stays where it was.

## Safe areas

`index.html` sets `viewport-fit=cover`, so the installed app and a phone on its side draw under the
status bar, the notch and the home indicator. The insets are `--safe-top`, `--safe-right`,
`--safe-bottom` and `--safe-left` (0 elsewhere). Pad with `pt-safe-*`, `pb-safe-*`, `px-safe-*`,
`pr-safe-*`, `pl-safe-*`: a page's own spacing or the inset, whichever is bigger. Read the insets
through the variables, never `env()` directly.

## Touch

- **Targets:** 44px for a finger. A small control keeps its drawn size and gets `hit-area`, an
  invisible box grown to 2.75rem on a coarse pointer. The shared buttons have it at every size,
  a dialog's and a sheet's close and footer buttons included; raw buttons and links in the bars add
  it. A tab grows instead: on a coarse pointer each trigger
  is at least 44px and its list grows to hold it (a mouse keeps the 32px list), since a tab list
  that scrolls sideways would clip an invisible box to its own height.
- **Fields:** 16px on a touch screen whatever their classes say (an unlayered rule in index.css),
  so iOS never zooms into one. Search fields get `enterKeyHint="search"` and no autocorrect.
- **No** tap highlight, double-tap delay, text inflation or rubber-band at the page's edges.
- **Keyboard hints** (⌘K, J/K, ?) show only with `fine:`.

## Lists

A list is one of two things, and the way it's read decides which. **A catalog** is read a row at a
time: releases, redirects, people, keys, webhooks, content types, workflows, tags. **A table** is
worked across its columns (sorted, ticked, moved through with the keyboard) or compared down them:
the entries list, the asset list, the audit logs, agent runs, a diff, a delivery log, an import's
report.

- **Finding:** every list that grows with the work (not a few configured things, such as roles,
  plugins or locales) has one toolbar: `ListToolbar` holds `ListSearch` at its
  start and any `Segmented` filter at its end, inside the card on a catalog. `ListSearch` is the only
  search field a list uses; with `onClear` it offers Clear and Escape clears it. The entries list and
  the asset library keep theirs over the card, where the bulk bar takes its place. A filter runs in
  the browser only over a list the screen holds whole: a capped or paged list searches on the server
  and offers no client filter, since it would answer wrongly.
- **Results** are said to screen readers as they change (`ListToolbar`'s `summary`). A row an action
  takes out of a filtered list hands focus to the row that took its place, or to the search.
- **A filter that misses** says so with the way out in it (`CatalogEmpty`, or `TableEmpty` in a
  table). No rows at all is `Empty` in place of the list.
- **Row actions** are ghost `xs` text buttons, the main verb first and the destructive one last,
  and they name their row for screen readers. At most two stay beside the row's ⋯; the rest go in it.
- **Bulk actions** are `BulkBar`: the count, the actions, then Clear at the end.

## Catalogs

`Catalog` and `CatalogRow` from `packages/ui/src/catalog.tsx`: a `<ul>` of raised rows (`Item`'s
muted variant), named by `aria-label`.

- **A row** leads with `media`, a `CatalogTile` that identifies it (an icon, an avatar, or a short
  code such as a redirect's status), then its `title`, the path into it, and a `meta` line of
  secondary facts, each in its own element.
- **State** sits in the `aside`: a badge, never coloured text alone, and any `CatalogFigure` (a
  caption over a tabular value). A fact whose column header used to explain it says so in words:
  "All locales", not "All".
- **Phones:** what the row is fills the first line; its state and actions share the second.

## Tables

Every table is `Table` from `packages/ui/src/table.tsx` (with shadcn's part names
kept: `TableHeader` is the `<thead>`, `TableHead` a column header, `TableRow`, `TableCell`,
`TableEmpty`; `Th`/`Td`/`Tr` are aliases).

- **Cells** are padded by the table (index.css, at zero specificity). `edge="card"` runs edge to
  edge inside a card, its outer columns inset 1rem; `edge="flush"` lines them up with the text of
  a padded panel.
- **Headers** are captions, `scope="col"`. A column without a name (row actions) still gets one for
  screen readers. A column the list sorts by is `Th sort` (`aria-sort` and an arrow beside the
  caption); a sortable one holds a caption-styled button that sorts by it. Sort lives in the
  headers, never in a filter panel.
- **Rows** from md are one height (the entries list's are 44px, its cells centred on the row); a
  row's quiet actions are ghost `xs` buttons, badge height, so they never set the row's height. A
  ticked row (`data-state="selected"`) takes a faint brand tint and the keyboard's row
  (`data-active`) an ink rule at its leading edge, both from `Tr`, so they read apart and
  together. The keyboard's row is a cursor, not a place: it never wears brand.
- **Figures** (`numeric`) are right-aligned, tabular and unbroken. Ids, API ids and keys are mono.
- **Status** in a cell is a badge (`StatusBadge`, or `ToneBadge` for another vocabulary), never
  coloured text alone.
- **Hover:** a row takes a quiet muted fill under the pointer; a ticked row keeps its tint.
- **More rows** come in from the foot: a `TableFoot` row with a ghost Load more, which appends the
  next page (cursor paging) and hands focus to the first row it brought. The ticks and the
  keyboard's place survive it; a new filter, search or sort starts again from the first page.
- **Phones:** `stack="cards"` turns each row into a card, the first cell on its own line and the
  rest named by their `label`; `stack="rows"` leaves the row's layout to the caller (the entries
  list, whose rows lay out as a grid with their checkbox and actions). Either way the header stays
  for screen readers and the parts keep their table roles.
- **Long lists** (`sticky`: the entries list, the asset list, the audit logs) keep the header
  under the shell's header; the card clips with `overflow-clip`, never `overflow-hidden`. A bar
  held above the table (a bulk bar) sets `--sticky-above` to its height and the header sits under
  it.
- **Keyboard:** the entries list moves with J/K, opens with Enter and ticks with X; Shift-click
  ticks a range (`EntriesTable`). The hint (`Kbd`, `text-2xs`) shows only with `fine:` from md,
  and is `aria-hidden`: the table is `aria-describedby` an sr-only sentence that says the same.

## Screens

- **Overview** (`cms/components/Dashboard.tsx`): what needs attention as cards (not yet published,
  coming up, agent proposals, live activity), then search, AI usage and recent agent runs.
- **Content:** the content types as a catalog (`PageHeader` with New content type): each type's
  icon as its tile, its name linked to its entries (a singleton's to its one entry, `/entry`, as the
  sidebar's link is), its API id in mono and its field count under it ("One entry only" beside them
  for a singleton), then its entries, drafts and changed entries as figures, Edit, and a ghost ⋯ menu ("More actions
  for ‹type›") with Clone… and, after a separator, a destructive Delete…; a Draft badge only on a
  type whose schema isn't published. Clone… opens a dialog with the copy's name and API ID. Closed
  either way, focus goes back to the row's ⋯. **Deleting a type** can't be undone, so it confirms
  in a modal (The Blast Radius Rule): a dialog reads what depends on the type first, names in a warning Alert whatever blocks it (another type
  linking to it, a menu or redirect naming its entries, its URL pattern; then no confirm is
  offered: no opt-in, no red button, only Keep it), and with entries asks for a tick on "Delete its
  N entries too", said to be required: a type can't go while it holds entries. It is confirmed by typing the API ID, with a muted line tied to
  the disabled button saying which steps are outstanding, and a refusal shows as a destructive
  Alert in the dialog. Keep it holds focus while the check runs; once it lands, focus moves to the
  first field. Deleted at once, focus moves to the next row's ⋯, or the page heading when it was the last. With its
  entries, the delete runs as a bulk job shown in the trash's card above the table, Stop included,
  kept by the Content layout so it is still there after a visit to an entry. The type goes in a
  step after the last entry: the card says "Deleting the content type…" until that is recorded on
  the job, then a success Alert, or a warning that the type was kept, naming the entries that
  couldn't be deleted (from the job's report) or why the delete was refused. Below md it stacks
  into cards; a content type's
  entries beside the list of types (from md): `PageHeader` with the real total ("250 entries",
  "Showing 100 of 250 entries" while more pages wait; filtered or in the trash, what was read,
  "100+"), then the filter bar: **Views** first (an outline `sm` pill with a bookmark, the open
  view's name, "View:" before it for a screen reader, "· edited" in muted once the list has moved off it, and a chevron; its menu is a
  radio group, All entries, then "Your views" and "Shared with the space" under menu labels, then
  Save as new view…, Save changes, Rename…, Share with the space or Stop sharing, and a destructive
  Delete view… confirmed in an alert dialog; naming a view is a small dialog with Name and, with
  `content:manage`, a Share with the space switch whose hint says each person sees only what their
  role allows), the search, named "Search entries" (below `sm` on a row of its own, above the buttons), Filters (`aria-expanded`, whose panel holds
  filters only, status values in the status words, and a muted line with a link-button to remove
  grouped conditions a view or link brought, and another for a link's `links_to_entry`), **Mine**, a toggle, `aria-pressed`, an outline pill at
  rest and the ink fill while pressed, with no tooltip since its word says it: only the entries the
  signed-in person created, `sys.createdBy=me`, which Clear clears with the filters, and **Columns** at the row's end, from `md` (an outline `sm`
  pill; a checkbox menu that stays open: Status, Updated and the type's fields). The filters,
  search, sort, columns and view are the page's URL. Then the table: checkbox, the title linking
  to the editor, then the picked columns, by default Status and Updated (`Ago`, the full time in
  its tooltip; on a phone beside the status, which a phone's row always shows, picked or not; a field column
  is one truncated line, its whole text in the cell's `title`, what a line can't show named in muted
  ("Rich text", "3 items"), hidden on a phone, and only Symbol, Text, Integer, Number, Date and
  Boolean columns sort from their headers), the row's quiet Publish (ghost `xs`, shown on hover, focus, the J/K row, a
  ticked row, and always on touch), and the ⋯ menu. Title, Status and Updated sort from their
  headers; Updated flips between newest first and the default, least recently changed first.
  **Ticking** anything swaps the filter bar for a bulk bar (`role="group"`, "2 selected · Publish
  selected · Unpublish selected · Move to trash · Clear"), held under the shell's header, offering
  only what applies (no Publish when every ticked entry is live as it is, no Unpublish when none is
  live) and sending only the entries it changes. A polite sr-only line says "2 entries selected".
  The header checkbox is mixed while some are ticked. A new order or a search leaves ticked only
  what it still shows. Bulk changes confirm once, naming the first five entries and counting the
  rest ("and 3 more"): Publish selected in a dialog, Unpublish selected and Move to trash in place
  under the bar, Keep as is focused; what failed stays ticked and is named in an Alert. **The trash** (View
  trash) is the same table with each title as plain text, a row's outline Restore and "Delete
  permanently…" in its ⋯ menu (a dialog naming the entry); its rows tick too, and its bulk bar
  offers Restore selected and Delete permanently… (both outline). Move to trash, Restore selected
  and Delete permanently… run as a **bulk job** on the server, over everything ticked: Move to
  trash ("Move 2 entries to the trash?", saying live ones are unpublished first) and Delete
  permanently ("Permanently delete 2 entries?", naming them, saying it can't be undone and that an
  entry published entries link to is kept; Keep in trash, then a destructive Delete permanently)
  confirm at the assistant's card; without it the page asks, in place for the trash and in a
  dialog for Delete permanently. Restore selected runs at
  once, as a row's Restore does. Each of the three a role can't start (it doesn't hold that job's
  actions on every type, as the api's `bulkJobs` answer says) is disabled, with the reason under
  the bar (`aria-describedby`). The job shows
  as the asset library's card does ("Bulk job": "Trashing 2 entries…", then "Trashed 2 entries",
  its stamp, the `Progress` of batches, a ghost Stop asked in place), and Stop takes focus as it
  arrives, since the bar's buttons now wait. When it ends the list reloads, only what it still
  lists stays ticked, and what failed is named in the Alert from the job's report (a report that
  can't be read gives the count and why, in a destructive Alert). A job keeps running, and its
  card stays, when another content type is opened. The entry editor: the title wraps; under it an action bar (status,
  version and save state, then the one primary verb for the state: Save draft for a new entry,
  Publish while anything isn't live, a disabled "Published" when live and clean) stays under the
  shell's header from md, and below md its buttons sit above the tab bar. The secondary actions
  (Draft from prose, Generate with AI, Copy preview link) are ghost and fold into a ghost ⋯ menu
  ("More entry actions") when the editor is narrower than 56rem. Publishing always confirms, from
  the editor and from an entries row alike, with the assistant or without it: readers and webhooks
  have a publish at once, and no undo calls that back. An entry that has been live confirms with
  what changed (`entries/PublishConfirm.tsx`), held as the card is (Publish entry stays off until the read has
  something to show, says why, and a failed read offers Try again; the cancel always works): each
  changed field by name, its published and draft values side
  by side where the container has room and stacked where it hasn't (a container query, so a dialog
  or the Coworker column narrows it as a phone does), links by the title of what they point at,
  unchanged fields behind "Show 4 unchanged fields". Fields the role can't read are counted with the
  rest ("1 field you can't read changed", as every diff counts them, never "0 fields changed") and
  always get the warning Alert, even when the editor's own diff has nothing else to list: that still
  confirms, with the warning. "The draft matches" is said only once a read has shown it. The
  scroller takes keyboard focus. A first publish asks the same way, saying the whole entry goes live, with Keep as draft as the safe choice. Beside the form sits the **side pane** (after felix's):
  where the row the two share is wide enough for both (a 420px form and a 336px pane; collapsing
  the sidebar buys the room back) it stands behind a hairline divider, sticky, scrolling on its own;
  narrower, it stacks under the form. The divider is an ARIA splitter (drag, arrows, Shift for a
  bigger step, Home and End, Enter or a double click to reset), and its share is kept per browser.
  A segmented switch shows **Details** (the panels) or **Preview**: the draft as a document, live
  as you type, in the form's locale with delivery's fallbacks (its title and values carry that
  locale's `lang` and `dir`, the captions stay the admin's), references by name, and links shown
  but never followed. For a space administrator a third segment, **Activity**
  (`entries/EntryActivity.tsx`), lists the entry's audit rows newest first in one card: what
  happened in words ("Saved", "Published", "Approved an agent's proposal", an unknown action as
  recorded, in mono), who and when (`actorLabel`, `Ago`, "through MCP" for a tool call), and under
  a save the fields it changed by name with their locales in mono. A row that recorded no changes
  shows no line, never "No field changed"; that is said only when its detail says so. It reads
  again after the editor's own saves, publishes and restores; a ghost Refresh in the card's header
  covers anyone else's. A ghost Load more at its foot (focus to the first row it brought, which
  shows the ring), skeleton rows while it reads, `Empty` when there is nothing, a destructive Alert
  with Try again when the first read fails, and an inline line under the rows kept when a later
  page or a refresh fails. Anyone else never sees the segment, and a remembered Activity opens on Details.
  A new entry's pane is its preview alone. Details opens on **who wrote it**, a
  card of its own that never folds away (two lines read faster than a toggle; no card inside it):
  "Created by" with the date (`When`) and "Last edited by" with how long ago (`Ago`), each writer
  a teammate's name (the team is read only by administrators), "You", or the kind of writer ("An
  API key", "The enrich agent", "A workflow", "A schedule"), never an id; an entry from before
  authorship was recorded reads "Unknown". Long names wrap, never truncate. One helper words a
  writer everywhere (`cms/lib/authorship.ts` `actorLabel`), with an in-sentence form ("by an API
  key") for an asset version's line. **Locales in the form:** a localized field is written one
  locale at a time, a row of locale buttons over the card. The inputs that hold a locale's words
  (Symbol, Text and the rich text's editable content, nested ones in components and blocks
  included) carry `lang` and `dir` for it, from the space's locale settings (`ltr` or `rtl`,
  defaulting from the language); labels, hints, the rich text toolbar and every other field's
  chrome stay in the admin's own direction, and figures, dates, slugs and pickers take neither. A
  locale Delivery doesn't serve keeps a **"Not delivered"** stamp on its button, in words and
  ruled in the button's own colour so it reads on the chosen ink and the muted row alike, and
  the same words beside it in the header's locale switcher: it is still written and previewed.
- **The content nav** (`cms/routes/ContentLayout.tsx`): beside a type's entries once the page is
  40rem wide, drawn as the Settings section nav is. The "Content types" caption, the ungrouped
  types, then each group under its name (an h3 `caption`, ids by the group's place, never a slug)
  naming its list. Each link has its type's icon (`size-4`; a type without one keeps the empty
  slot, so names line up) and a `StatusDot` when not published. The open link takes the accent
  fill, and its icon alone goes `text-brand`.
- **The entry form's layout** (`cms/components/EntryForm.tsx`): a type's layout draws the form as
  tabs ("Sections of the entry", a `TabsList` at full width that scrolls sideways itself, so a
  phone or tablet never scrolls the page), each tab one `Card`. A named group is a `section-title`
  h3 over a hairline (`border-t`); a collapsed one is the same h3 holding a ghost trigger with a
  turning chevron. Tabs and locales carry one `ErrorCount` pill each (destructive tint, the count
  read as "2 validation errors"). A rejected save opens the first tab with an error and opens its
  group; in the error summary, a field out of view (another locale, tab, or a closed group) is a
  button that brings it into view.
- **Fields under rules:** a field its rules hide isn't drawn. One that still holds a value is a
  quiet line in its place (`bg-secondary/40`, "Sold to is hidden while Status is not "sold", but
  still holds a value") with an outline "Clear Sold to". A field its rules make read-only keeps
  its place and value: a text, number, date or select control is `readOnly` with `aria-readonly`,
  stays in the tab order, and its reason ("Read-only while Status is "sold"", muted `text-xs`) is
  read on focus through `aria-describedby`; a button-like widget (a checkbox, a picker, a list's
  Add and Remove, nested fields) is disabled by a fieldset; an extension is told `readOnly`. When
  an edit shows, hides or locks other fields, a polite sr-only line says so ("Sold to shown.
  Reference read-only.").
- **Dates and lists:** a Date's input follows its format: a date picker, `datetime-local`, or a
  `time` input (minutes; seconds kept when stored). A list of Text, Integer, Number or Date
  values is one row per value, each named "<Field> item N" with its own input and a ghost Remove,
  then an outline Add item; focus goes to an added row, and after a Remove to the row that took
  its place (or Add). A row's own error sits under it, marked `aria-invalid` and linked. A list of
  Symbols keeps its chips.
- **The content type dialog** (`cms/components/ContentTypeDialog.tsx`): the type's Group, Icon (a
  select of the icons the admin draws; a stored name it can't draw is kept as "name (not drawn
  here)") and Description beside its name, then Agent instructions: plain text, with a hint saying
  it guides agents reading the type and is never delivered. Each field row has Guidance, Rules and Settings
  buttons; each opens a panel under the row (`bg-secondary/40`, `rounded-xl`, a fieldset with an
  sr-only legend naming the field, "Rules for Price"). Rules are rows of action, sibling, operator
  and value. Settings hold what the type means: a Date's Format (Date and time, Date, Time of
  day, Any ISO date) with its earliest and latest value, a text field's Pattern preset, an asset
  link's allowed file types. A list field gains **Items** beside its Type (Symbol, Text, Integer,
  Number, Date; a new list starts as Symbol); a list of links or components has none. **Layout** is drawn as Fields
  is, its title beside Add tab; each tab a row (its name, a ghost Remove), and each field row gains
  Tab and Group selects once a tab exists.
- **Releases, Workflows, Taxonomy:** `PageHeader` with the page's one "New …" (a `Plus` and the
  noun), then a catalog. Publishing a release confirms in an alert dialog, naming
  what goes live and what to look at first (never-published entries, members in the trash).
- **Assets** (`cms/components/AssetLibrary.tsx`, `cms/components/assets/`): `PageHeader` with
  Upload, which names the open folder ("Upload to “Brand”"); the library section is the drop
  target too, ringed while files are over it. From md the **folder tree** stands beside the
  library: All assets, Not in a folder, then each folder as a list nested in its parent's list,
  the open one `aria-current`; New folder (or subfolder), Rename and Delete (in-place confirm, empty
  folders only) sit under it, and the name form hands focus back to the button that opened it (a
  created folder takes focus itself). Under the tree, captioned **Collections**
  (`assets/AssetCollectionList.tsx`, its own `nav`): each collection a row like a folder's
  (`TreeButton`, named with its count, "Launch, 3 assets"), then New collection, whose form takes
  a name and an optional description. A collection opens **in place of the library**
  (`assets/AssetCollectionView.tsx`), no folder current while it shows: a "Collection" caption over
  its name (an h2 that takes focus when the collection was just made), its description and count,
  then Share and Download as zip (outline), Edit (the same form, in a card) and Delete (an alert
  dialog: its assets stay in the library, links to it stop opening). Its assets are an ordered
  list in a card, every status included: a grip, the position in muted tabular figures, the
  thumbnail, the name as the open button, the status stamp, then Move up, Move down and Remove
  (ghost icon buttons, each named for its asset). A row drags onto another; the buttons are the
  keyboard's way, and focus stays on the moved row (on the other arrow at an end). Each move is
  said in an sr-only polite line ("“Logo” moved to position 2 of 5") and sends the whole order
  loaded; a refused one puts the last saved order back with a toast. Remove takes it out of the
  collection only, and focus goes to the row that takes its place; removes wait their turn behind
  the moves sent before them, and a refused move reads the order back from the server. On a phone a
  row's actions take a line of their own under the name, and on a coarse pointer they stand 20px
  apart (`pointer-coarse:gap-5`), so their 44px `hit-area` targets don't overlap. Upload while a
  collection is open names it ("Upload to “Launch”"): the files land at the library root (the
  folder tree isn't in view) and are added to the collection once uploaded, which the upload card
  says ("Into the collection “Launch”: filed at the library root, then added to it"). Empty, it says
  how to fill it
  (select in the library, then Add to collection). On a phone the collections are a select beside
  an icon New collection. Then the **filter bar**, as the entries' (kind, status, tag,
  sort) with the Grid/List segmented switch at its end, kept per browser, under the **search
  box** (`type="search"`, Escape or the clear button puts the library back; no autocorrect, a
  search Enter key). Typing searches once it pauses: results rank by relevance, all at once (up to
  100), and the folder and filters still apply. A search shows **facet chips** under the filter
  bar, a `role="group"` per facet (Kind, Tag, Folder), each chip a pressed toggle named by what it
  shows ("Images 3 matches", the count in muted text), narrowing the search the way the filter bar
  and tree do, so they agree. One always-mounted polite line (`text-ui`, muted) says "Searching…"
  (the results region `aria-busy`) and then "3 matches for “mug”"; changing the search clears the
  selection. **What ingest found** sits beside an asset's status, on cards, rows and the sheet: a
  `run` "Processing" stamp while ingest runs (the library polls until nothing shown is
  processing); a ruled `bad` "Processing failed" with a Retry icon button and the reason written
  out under it in the `bad` colour (read once, never only on hover); and a `wait` "Possible
  duplicate" stamp that is a button opening the original. Badges that are buttons, and the
  sheet's tag toggles, take `hit-area` and the full `ring` edge. **The sheet** opens on one asset
  (Share, outline, under its title) in tabs (`Tabs`, the row scrolling rather than squeezing a word
  on a phone): **Details** (a
  hosted video's status, the focal point, alt text and tags; Save metadata, the footer's one
  button, shows on this tab only), **Versions**, **Usage** (the entries using it), **Renditions**
  (the transform preview; a non-image says it is delivered as uploaded) and **Rights**; what
  ingest found sits above the tabs, in sight from any. On Details, the focal point is one control
  for pointer and keyboard: click to place it, or Enter (the middle) and the arrow keys (1%, 10%
  with Shift); its name says where it is ("Focal point: 30% across, 60% down") and its hint, a
  polite live region, says where it moved. Its marker is an ink ring (`foreground`) on a paper
  halo (`background`) with an ink dot, no shadow, so one of the two stands off any picture in
  either theme, never a fixed white. Generate alt text and Suggest tags are ghost `xs` buttons led
  by the AI mark in `text-ai` at rest (`ComposeLoader`, still), its task's icon (`write`, `asset`)
  composing beside "Generating…"/"Suggesting…" while the model works, the other disabled
  meanwhile; no emoji. **Versions** (`assets/AssetVersions.tsx`)
  is a list newest first: the version in mono, the file name, its size, when and by whom (a
  teammate by name when the team is readable, else "a teammate", "an API key"; never an id), and
  outline badges for Current and "Restored from v1" beside the `ok` Published stamp on the file
  Delivery serves. Replace file (outline, a file picker) says "Uploading “x”…" in a status line
  while the signed PUT and commit run (past 100 MiB the file goes in parts: a `Progress` of bytes
  stored with the upload queue's "120 MB of 400 MB · 3 of 50 parts" under it, and a ghost Cancel
  upload that gives the upload up and keeps the current file), then a toast names the new version; a failure is a
  destructive Alert in place, and a lost race (another replace committed first) says so and
  reloads the list. A hosted video's Replace file is disabled, its reason written under it. Each
  older version has a ghost Restore that asks in place ("Restore version 1?", ink pill, since
  nothing is lost). When a published asset's current file is not the one Delivery serves, a
  warning Alert says "Delivery serves version 2 · Publish again to deliver v3" with the publish
  beside it. **Rights** (`assets/AssetRightsForm.tsx`) leads with the saved rights as a status:
  a stamp and a sentence ("Expires soon · Expires in 3 days (date)", "Expired", "Embargoed ·
  Under embargo until …", or "No expiry or embargo."), then License, Credit, Expires at and
  Embargo until (`datetime-local` on the reader's clock, named in the hint, sent as UTC
  instants) and Save rights; an expiry already past on a published asset asks in place first
  ("Expire it now?", destructive "Expire now"), and on a published asset the embargo hint says
  it can't be set until it is unpublished. Versions and Rights stay mounted while another tab
  shows, so an upload under way or rights not yet saved survive a look elsewhere. A field the API
  refused is `aria-invalid` with its message under it;
  a role without content:publish gets a warning Alert in place saying who can set rights; a
  refusal of the whole asset is a destructive Alert with the server's words. **Rights on cards and
  rows**: beside the status, "Expires soon" in `wait` (a person must renew or replace it; a week
  out, `RIGHTS_EXPIRE_SOON_MS`), "Expired" in `idle` (lapsed, already out of Delivery) and
  "Embargoed" in `run` (on a clock, it lifts by itself). A refused publish anywhere toasts the
  server's reason ("under embargo until …"). In the sheet, alt text and tags a
  model filled are marked as the `ai` tone until an editor changes them: an "AI suggestion" stamp
  by the field, and on each suggested tag an `ai` dot and the word "AI". Saving sends only the
  fields that changed, so an untouched suggestion stays marked. The sheet fills its form only
  when another asset opens: Retry or a poll bringing the same asset back keeps unsaved edits,
  and opening the original from the duplicate stamp with edits in the form asks in place first
  ("Open the original and discard your changes?", Keep editing focused). **Grid**: board cards,
  the name the open button over the card, the checkbox top-left, status badges and the actions
  below. **List**: a table, `stack="rows"` laid out like the entries rows on a phone. **Selecting**
  shows a bulk bar (`role="group"`, "2 selected · Publish selected · Unpublish selected · Archive
  selected · Move selected · Add tag · Remove tag · Add to collection · Download as zip"; Add to
  collection, a select and an outline button, shows once a collection exists, and the add goes in
  turns of 500, toasting what went in and what was already there); archiving or unpublishing several
  asks in
  place ("Archive 2 assets?"), and what failed stays selected and is named in an inline Alert, as
  in the entries list. Past 50 selected (one page, `ASSET_BULK_JOB_THRESHOLD`), and for tagging
  at any count, the action runs as a **bulk job** on the server: a card shaped like the upload
  queue ("Bulk job") with a polite status line ("Publishing 51 assets…", then "Published 49 of
  51 assets; 2 failed"), the job's status stamp (a `wait` "Finished with failures" when any
  failed, never a green done), the upload queue's `Progress` of batches (batches are what
  complete) and "this keeps running if you close the tab"; the bar is disabled while it runs,
  and freed with a toast if the job can no longer be followed (a refused poll). A ghost Stop asks
  in place ("Stop this bulk job?", Keep running focused, destructive "Stop job"). A stop takes no
  new batches but is no rollback: stopped, the line reads "Stopped: Published 25 assets", the
  stamp is Cancelled, "Stopped after 1 of 2 batches. A batch under way when you stopped may still
  finish; the library shows what changed." sits under the bar, focus moves to Dismiss, the library
  reloads and the selection stays. A zip has no stop (the server can't cancel one).
  When it ends the failures are read from the job's report and named in the same Alert by the
  asset's title or file name (the library's name for one a failed batch left unnamed), still
  selected; a role that can't read the report gets the count
  and why they can't be named. A **zip download** (`assets/AssetZipProgress.tsx`, from the bulk
  bar or a collection) is a card shaped like the bulk job's ("Zip download"): a polite status line
  ("Preparing “Launch.zip”…", "Zipping 12 files into “Launch.zip”…", then "“Launch.zip” is ready:
  12 files, 48 MB"), its status stamp, a `Progress` of the parts written (its value text "3 of 8
  parts written") and "this keeps going if you close the tab", polled every 2 s. Built, a primary
  Download “Launch.zip” (a link with `download`) and a ghost Get a new link (each link lasts 15
  minutes); failed, a destructive Alert with the reason, so it is heard. The library holds a
  collection's zip, not the collection's view, so after leaving the collection its card is still
  in the library to download from; Download as zip waits (disabled) while a zip is being asked
  for, so a second press can't start another. The **upload queue**
  lists each file with a badge and the batch's progress, its summary a live region ("Uploading 1
  of 3", then "Uploaded 2 files; 1 failed, 1 cancelled"), and a toast at the end of the batch. A
  file past 100 MiB goes up **in parts**: its row grows a thin `Progress` of bytes stored
  ("Uploading “film.mov”", value text and a muted tabular line "64 MB of 150 MB · 1 of 3 parts",
  "· retrying part 2" while one waits to try again, its badge then a `run` "Retrying"), and an
  icon Cancel ("Cancel uploading “film.mov”"), which a file still waiting has too; a cancelled file
  is an `idle` "Cancelled". **Share** (`assets/AssetShareDialog.tsx`, from the sheet and
  a collection's) is a dialog, "Share “x”", saying anyone with the link sees the published files
  until it expires or is revoked (for a collection, that its drafts stay off the page). Then a
  form: Expires after (a `Segmented` of 1 day, 7 days, 30 days and Custom, which adds a
  `datetime-local` on the reader's clock), an Allow downloads `Switch` with its hint, an optional
  password with its hint, and Create link; the new link's Copy takes focus. Active links follow
  under their own heading: the URL in mono (or that the deployment has no media origin), "Expires
  in 3 days (date)", `idle` stamps for Password and Downloads allowed or View only, then Copy
  (outline) and Revoke (ghost, an alert dialog over the Share dialog, since the link can't be
  brought back; focus goes to the heading). An unpublished asset
  gets a warning Alert ("Publish it to share it", with an outline Publish asset that goes live at
  once, as the library's Publish does, and hands on to the form) in place of the form; a role without
  content:publish, a warning Alert saying who can share, and no form; a refusal is a destructive
  Alert in the server's words, a field's beside the field as an alert (heard at once), tied to the
  expiry choice or the field by `aria-describedby`. Archiving one asset is an
  Undo toast that restores it; an archived one shows Restore (back as a draft). **Delete** asks in
  an alert dialog, since its files go too, and one an entry still links to is refused: a warning Alert takes focus, names the first
  five entries (each a link) and counts the rest ("and 12 more"), and offers Archive instead. A
  load that failed is a destructive Alert with Retry, never an empty library; the first page
  loads as Skeleton cards or rows. **On a phone** the tree becomes a select of folder paths
  ("Brand / Logos") with a Folder actions button that opens the folder actions in a bottom sheet.
- **Settings:** one page, its section nav beside the section (a grouped select on a phone); each
  section is cards and catalogs. The install hint sits at the top of Connection. A plugin's
  **Settings** is a sheet (from the side; the bottom on a phone) whose form is drawn from its
  manifest's fields: a secret shows an `idle` Set or Not set stamp with Set/Replace and Clear,
  never a value; a refusal sits beside its field and takes focus.
  **Trash** (Workspace) is one section: a segmented Keep until deleted / Delete after a while
  (off by default), and when on a "Days in the trash" field (1 to 3650; an out-of-range value is
  said under it, tied to it by `aria-describedby`), with a muted line saying what happens (an
  hourly sweep deletes for good entries in the trash longer than that, with their history, and
  keeps one published entries link to). Save turning it on, or shortening it, asks in an alert
  dialog ("Delete trashed entries after 14 days?", Keep as is, "Save and delete"), since trash already
  that old goes at the next sweep; turning it off saves at once. While it loads it is a skeleton
  line with a sr-only status, `aria-busy`; a failed load is a destructive Alert with Retry, never
  a setting that looks off.
  **Locales** (Workspace) is one section, a catalog flush in its card, one row per locale: its
  language subtag as the tile, its code in mono with an outline "Default" badge on the default, what
  it falls back to ("Falls back to fr"; "No fallback" for the default, the end of every chain), a **Delivered**
  `Switch` named "Deliver fr", and **Direction**, a `Segmented` of Left to right and Right to left
  named "Text direction of fr". The default locale's switch is disabled, its reason in the row's meta line and
  tied to it by `aria-describedby` ("Always delivered: every fallback ends here."). A change saves
  at once, with a toast, except turning Delivered off, which asks in place in a row beneath ("Stop
  delivering fr?", saying Delivery stops serving it in every environment at once and that editors
  still write and preview it; Keep delivering focused, then the ink "Stop delivering", since
  nothing is lost). A save refreshes every environment's cached space config, so the editor's
  locale buttons and the header's switcher follow at once. Loading draws the headers and two
  skeleton rows, `aria-busy` with a sr-only status; a failed load is a destructive Alert with
  Retry, never locales that look turned off. Without space:admin it reads only: every control
  disabled under a warning Alert saying changing locales takes space:admin.
- **Workflows list:** a catalog, flush in one section under its search: each
  workflow's trigger as its tile, its name linked to its editor with its description and steps under it; what starts its
  published version (from the API's `publishedTrigger`, with "Draft starts on …" when the draft
  starts differently, and the other workflows that start alongside it, from `startsAlongside`);
  what it covers; whether it gates publishing; its live version; then Duplicate and Delete
  (confirmed in an alert dialog). "New workflow" is a form sheet (template or blank) and "Draft
  with AI" a dialog whose proposal is reviewed in a Confirmation before a draft is created.

## Screens that change shape

- **Workflow editor** (`cms/routes/WorkflowEditor.tsx`): full-bleed, the window's height at lg
  (the page never scrolls; its columns do). At lg it builds, palette | canvas | inspector; with
  Coworker open the inspector steps aside until a step is picked. On touch, a palette item is tapped in (dragging is offered only to
  a fine pointer: iPadOS drag is unreliable), node handles grow and carry a 32px target, and a
  connection snaps from 40px. Below lg it is review-only, saying so in place ("Building workflows
  needs a wider screen…"): the canvas, the checks and each step's settings show read-only, and
  nothing on screen can change the workflow. Every wire can also be made from the keyboard: a
  selected step's Connections list offers only targets that wouldn't close a cycle. A Loop's
  second input, `next`, is a hollow ink ring on the node's bottom edge, named under the outputs,
  and its back-edge is dashed ink labelled `next`: colour on the canvas is for status only (The
  One Meaning Rule); node categories colour only their icon (`--cat-*`: triggers ink, control
  steps the muted grey, commerce slate, AI the brand; none takes a status hue). A selected node is an ink
  edge with the focus ring, never the link blue. A workflow too wide to read whole opens framed on
  its first loop or wait, never below 0.7 zoom; Fit view (⇧1) stops at the zoom that keeps a 13px
  label at 10px. Every canvas with a loop or a wait has **Jump to**. React Flow's credit stays, at
  caption size. Publish asks in place about the draft on screen (any edit withdraws the question)
  and, while the checks have errors, refuses and lists them instead.

## Elevation & Depth

Flat. A card sits on the page edged by a faint ring and no shadow; inside it, depth is tonal: tiles
are a muted step. Shadows are kept for what floats over the page.

### Shadow Vocabulary

- **Card** (`box-shadow: 0 0 0 1px color-mix(in oklch, var(--foreground) 10%, transparent)`): every
  panel (`card`), a ring rather than a shadow.
- **Raised segment** (`shadow-sm`): the chosen segment of a segmented control.
- **Float** (`shadow-float`): a control over a scrolling page (a phone's New entry, a toast). None
  in dark.
- **Overlay** (`shadow-overlay`): the sidebar opened over the page.

### Named Rules

**The No Nested Cards Rule.** Inside a card, group with tiles or rows, never another card.

## Motion

Quiet and exact. Things move only when state changes, and only to say what changed and where:
opacity, colour and a few pixels of travel.

- **Durations** (`app.css` motion tokens):
  `--motion-instant` 100ms (feedback, anything leaving), `--motion-move` 180ms (something appearing
  or changing state), `--motion-travel` 240ms (pages and panels).
- **Easing:** `ease-arrive` (`cubic-bezier(0.16,1,0.3,1)`) for arrivals, `ease-leave` for exits.
- **Overlays:** a sheet, or a dialog rising on a phone, travels in on `--motion-travel` and
  `ease-arrive`; a dialog appears on `--motion-move`; all of them leave on `--motion-instant`.
- **Arrival:** `animate-arrive`, a fade and a 4px rise, for a toast, a confirm or a new row
  (`useArrivals` decides what is new).
- **Pages** cross-fade with View Transitions while the header, the sidebar and the tab bar hold
  still. A page slow to arrive (400ms) shows `PendingBar`, a link-blue rule sweeping under the
  top bar.
- **Loading** (`cw-skeleton`, `cw-refreshing` in `app.css`): a skeleton waits out a 200ms grace,
  so a quick answer never flashes one, then fades in and breathes slowly between two weights of
  ink (8% and 4.5% of `ink` over whatever is beneath, so one fill reads on paper, a card or a
  tile, light or dark). Rows already on screen while a new query runs stay put and readable; after
  400ms they settle back a step and the link-blue rule sweeps the region's top edge.

**The Drawn Page Rule.** A page that is loading draws everything it already knows for real (the
title, the intro if it's fixed, the filter bar, the column headers, a sheet's header) and stands a
skeleton in only for the data, in the shape and size of what replaces it: text as one-line bars
in the text's own size, badges and buttons as pills, thumbnails as tiles, table rows built from
the real row's classes so they stack the same on a phone. Nothing moves when the data lands. No
region says "Loading…" on screen: it announces its load once to assistive technology
(`LoadingStatus`, "Loading Author entries…") and marks itself `aria-busy`, and its skeletons are
hidden. A list's skeleton comes back as long as the list was last time this session.

**The Reduced Motion Rule.** With reduced motion nothing travels, but nothing that carries meaning
is lost: colours still change, arrivals and overlays fade without rising, and page changes happen
at once. A skeleton fades in and holds still: its status line says it is loading.

## Shapes

Generous and round. The radius base is 0.625rem on a multiplying scale: cards are 2xl, tiles xl,
one-line fields 4xl, text areas xl, menus 2xl. Buttons, one-line fields, badges, segmented controls
and icon buttons are pills. Hairlines divide rows inside a card; cards have no border.

**The Pill Rule.** Anything you press or that labels a status is fully round. Square corners are
for code and data blocks only.

## Components

- **Buttons** (`ui/button.tsx`): pills. Primary is an ink fill with paper text; outline is a rule
  over a faint `input` fill; ghost fills muted on hover; link is the work blue. Every size carries
  `hit-area`.
- **Fields** (`ui/input.tsx`, `ui/textarea.tsx`, `ui/native-select.tsx`): pills with an `input`
  hairline over an `input` fill. Focus: the `ring` edge and halo. Invalid: the destructive edge.
- **Segmented** (`ui/segmented.tsx`): a radio group drawn as a muted pill track; the chosen
  segment is raised on paper.
- **Card** (`ui/card.tsx`): `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`,
  `CardContent`, `CardFooter`. `Section` (`components/page.tsx`) is a Card with a section title, an
  optional description and action, and `flush` content under a rule.
- **Page** (`components/page.tsx`): `PageHeader` (the h1, an intro held to the measure, the page's
  actions), `Body`, `Section`, `Empty` (with an `icon` and `title` where the empty state is the
  news).
- **ComposeLoader** (`ui/compose-loader.tsx`, `cw-compose` in `app.css`): the AI loader, for a
  model at work (never for plain loading, which is a skeleton). The mark composes itself in
  reading order (strokes draw, blocks are revealed from their leading edge), holds, then clears as
  the icon fades, in one 2.8s cycle, in `text-ai`. Icons: `aiMark` (the default), `write`,
  `schema`, `asset`, `search`, `workflow`; sequences (`drafting`, `enriching`, `working`) play one
  per cycle and open on the mark. Decoration beside a status line, unless `label` makes it the
  status. Where motion is reduced it is drawn whole and holds still. It is the AI's working state
  everywhere: Coworker's thinking line and its running tool lines, the busy Generate draft button
  (`drafting`), and AI assist, whose header mark composes while a task runs and whose busy button
  shows that task's icon. An agent at rest is the mark in `text-ai`, never a robot icon.
- **Skeleton** (`ui/skeleton.tsx`): `Skeleton` (a block, tile radius), `SkeletonText` (lines one
  line-height tall in the surrounding type), `SkeletonPill` (a badge, or a button with `h-8`). The
  CMS's regions compose them with `LoadingStatus`, `Refreshing`, `PageSkeleton` and the
  remembered row count (`cms/components/loading.tsx`).
- **Item, Field, Kbd, Spinner, Badge, Separator, Breadcrumb, Tooltip, Sheet, Dropdown
  menu, Alert, Alert dialog, Dialog, Select, Tabs, Checkbox, Avatar** (`packages/ui`): radix-maia
  primitives on the Ledger tokens. Dialogs, alert dialogs and sheets open over a clear backdrop that
  blurs the page (`backdrop-blur-sm`), with no tint.
- **Dialog** (`ui/dialog.tsx`, `ui/alert-dialog.tsx`): capped to the screen, less an on-screen
  keyboard (`--keyboard-inset`, since iOS leaves that out of `dvh`), so what gives way is the body,
  which scrolls: the header, the footer and the close button stay put and every action stays in
  reach. A focused field clears what is pinned, as it takes focus and as the keyboard rises. A dialog
  comes from the bottom on a phone and sits centred from `sm`; an alert dialog is a question, not a
  form, and stays centred, except the entry publish review (`placement="sheet"`), which is read
  before it is answered and comes from the bottom as a dialog does, its Publish entry in thumb
  reach. The palette anchors to the top at every width (`placement="top"`), so its search box holds
  still as the results shrink.
- **Sheet** (`ui/sheet.tsx`): built as a dialog is, from the side or from the bottom. Capped to the
  screen, less an on-screen keyboard and the safe areas; `SheetHeader` and `SheetFooter` stick to the
  edges of a body that scrolls (`bodyClassName` for its padding, `className` for the sheet's size),
  and the close button (a dialog's: a filled 32px `icon-sm`) sits outside the body, so a long sheet
  never scrolls its way out or its action off a phone. A body that overflows with nothing to tab
  to takes focus itself, ringed and named as the sheet is, so the keyboard can scroll it. Its footer
  is a dialog's, stacked primary first on a phone. A consumer never puts `overflow-y-auto` on the
  content. Where pinning would leave no room between header and footer (a phone on its side with
  the keyboard up), both let go and scroll with the body, in a dialog too (`data-cramped`).
  - **Title:** `section-title`, the same in a dialog, an alert dialog and a sheet.
  - **Closing:** focus goes back to what opened it, in a dialog, an alert dialog and a sheet alike
    (`ui/lib/focus-return.ts`): the control that was pressed even where Safari didn't focus it, a
    menu's trigger for a menu's item, the sheet under a dialog over one. An opener that is disabled
    or gone hands on to what stood beside it, then to the page, and focus the closing action put
    somewhere on purpose stays there. `onCloseAutoFocus` overrides it.
  - **Footer:** an outline Cancel, then the primary at the default size, on the right. On a phone
    they stack, the primary on top.
  - **Errors:** `DialogError`, one line (or a title and a list) in `destructive`, `role="alert"`,
    above the footer, for what stopped the form, in a dialog or a sheet; it brings itself into view,
    since the pinned footer can be pressed from anywhere in the scroll. A field's own error stays
    beside the field, and a notice that blocks the task (a refusal with a way on) is an Alert.
  - **Leaving:** a form with work in it never goes quietly (`cms/components/discard-guard.tsx`).
    Escape, a press outside, the close button and Cancel all ask in place of its buttons ("Discard
    this redirect?", Keep editing focused, then a destructive Discard); Keep editing goes back to
    the field last in use; saving doesn't ask, and an
    untouched form just closes. A save under way holds the form: Cancel waits, and a try at leaving
    says "Still saving". Only a save holds it; a read (Check, Fetch) stays closable. A save that
    never answers times out (`RequestTimeoutError`, in `req`): the form lets go and keeps what was
    typed, and `DialogError` says the save didn't confirm and to check before trying again, never
    that nothing was saved. A failed save goes to the guard (`saveFailed`), which tells a refusal
    (a 4xx: the question can say "Nothing has been saved") from an outcome nobody knows (a timeout,
    a dropped connection, a 5xx). After one of those the question says "A save here may have gone
    through; discarding won't undo it.", in place of any note, until the form
    closes: a refused retry doesn't speak for the save before it (its Alert says "This try was
    refused", not that nothing was saved, and a create keeps "Create again"), and a "someone else
    saved" conflict allows that it may have been their own. Where a create has no natural key, the button turns to "Create again". A form of a line
    or two (a view's name, an invitation, a clone's name) isn't guarded, and New space and New
    environment keep what was typed when they close. Dialogs that talk to a model keep their work instead: the prompt
    and a draft under review stay for when they open again, and only Discard or Apply clear them.
    Closing one while the model works aborts the request and drops a late answer, so a model that
    hangs never holds the dialog shut.
- **Status badge** (`components/status.tsx`): a pill tinted 11% in the status colour with a dot; an
  ending that went badly is ruled in the colour with a mark (✕ or undo) instead of tinted, so it
  reads apart without colour. `ToneBadge` for another vocabulary (a diff's change, a finding's
  severity); `StatusDot` alone where the word sits beside it.
- **Inline confirm** (`cms/components/InlineConfirm.tsx`): an "are you sure?" where the action was.
  The safe choice has focus, Escape backs out of the newest one, and focus goes back to what asked.
  **The Blast Radius Rule:** how something asks follows what it reaches. Anything irreversible that
  touches content, files or access confirms in a modal, its act in `variant="destructive"`
  (`cms/components/ConfirmDialog.tsx`, the modal twin of `ConfirmButton`, or a dialog of its own when
  it has more to say; it waits for the answer, its act held and Cancel with it, says a refusal in
  the dialog, and closes once the page has moved on; with no answer it says the act may have gone
  through, and its safe choice reads Close): the thing is gone, and asking again makes something new rather than bringing
  it back. Those are deleting an asset, a release, a workflow, a role, a menu, a collection, a saved
  view, a webhook or a content type; deleting a taxonomy scheme, concept or tag, which every entry
  carrying it loses; Delete permanently, and shortening how long the trash keeps entries; revoking a
  key, a token or a share link; disconnecting an application; removing someone from a space;
  uninstalling a plugin (its settings and stored data go with it); starting a new conversation; and
  discarding an entry's unsaved changes. A publish confirms in a modal too, an entry's, a bulk
  publish or a release's: readers and webhooks have it at once, and no undo calls that back.
  Anything undoable confirms in place: restoring a version appends a new version and the one it
  replaced can be restored in turn, and Undo or Restore puts back an unpublish or a move to the
  trash, one entry or many.
  **The named exceptions:** a small irreversible config row may stay in place, when it reaches no
  content, file or access and can be typed in again as it was. Only these: a redirect, an item in a
  menu's editor, an environment alias, a function, an AI action, an app extension, a comment or a
  task on an entry, and an empty asset folder (a folder with anything in it is refused). The team
  page's account actions and revoking an invitation also ask in place for now: their step-up field
  posts with their form. Anything new joins this list by being written here. The rule is about what
  is stored, so three kinds of asking sit outside it: leaving a form with work in it (Leaving,
  above, and leaving a workflow with edits) loses only what was never saved; stopping a bulk job
  leaves done what is done, and the rest can be run again; and a workflow's Publish asks in place,
  since a run keeps the version it began on. An asset's Publish doesn't ask: unpublishing it puts
  back what was delivered.
- **Toasts** (`cms/lib/toast.tsx`): a card above the tab bar with a status dot and the words; an undo
  toast carries its Undo action.
- **Form sheet** (`cms/components/form-sheet.tsx`): a list page's create form behind one "New …"
  button, in a sheet from the side (from the bottom on a phone, as every sheet with a form or a
  detail is: `ResponsiveSheetContent`).
- **Relative time** (`components/ago.tsx`): "3m ago" that stays true, the full time in its tooltip.
- **Copy and share** (`components/copy-button.tsx`, `cms/components/share-button.tsx`): copy says so
  for a moment; share uses the system sheet where there is one.
- **Install hint** (`components/install-hint.tsx`): on an iPhone or iPad in Safari, in More and on
  Connection, until it's dismissed.
- **Rich text editor** (signature): TipTap styled as content, not chrome; entry and asset
  reference links in the work blue with dotted underlines; code in mono on muted; tables in
  hairline cells, header cells semibold on muted, scrolling inside their wrapper when wide. Table
  controls (icon and words, since "delete row" isn't something an icon says alone) appear in a
  second toolbar row only while the cursor is in a table.

## Installed

`public/manifest.webmanifest` and the apple-touch-icon put the admin on the Home Screen as its own
app (`standalone`). The icons are rendered from the mark by `apps/studio/scripts/icons.sh`: the mark
in white on a full-bleed brand tile, opaque, inside the central 60% so the same art is maskable. The
favicon (`favicon.svg`, shared with the docs, and `favicon.ico`) is the mark itself in brand (`#0e49bc`), the
lighter dark-theme brand (`#77a4f6`) where the browser is dark. `theme-color` follows the chosen theme: the inline theme script in `root.tsx`
(run before first paint under the CSP's nonce) keeps a `theme-color` meta of its own in step. The
theme follows the system until the reader picks Light or Dark. There is no service worker: actions must reach the API.

## Do's and Don'ts

### Do

- **Do** keep text at 4.5:1 and focus edges at 3:1, in both themes, on the surface they sit on.
- **Do** take sizes from the theme (`text-ui`, `text-2xs`, `max-w-page`, `max-w-measure`).
- **Do** check a layout change with `pnpm --filter @commerceworker/admin e2e` (the shell spec runs
  desktop and phone, light and dark, through axe).
- **Do** give a small control `hit-area` rather than growing it.
- **Do** put a phone's most frequent action within thumb reach: the tab bar, a bottom sheet.
- **Do** pair every status colour with words.

### Don't

- **Don't** fade the focus ring below 3:1, or remove the outline without drawing an edge.
- **Don't** put a status colour on something that isn't a status.
- **Don't** read `env(safe-area-inset-*)` directly, or hard-code the header or tab bar height.
- **Don't** set a field under 16px for touch, or show a keyboard shortcut to a finger.
- **Don't** recreate the legacy enterprise CMS admin: no crowded chrome, no nested settings mazes,
  no boxes-in-boxes.
- **Don't** import the SaaS-gradient look: no gradients, glassmorphism or marketing energy.
- **Don't** scatter sparkle icons or "AI" buttons; AI lives inside flows and, when it ships, in the
  one summonable assistant.
- **Don't** use coloured side-stripes as accents (a card's, row's or alert's thick coloured edge), or
  solid saturated fills for status. The current item is its fill, never a coloured tick or stripe
  at its edge, and nothing else (a keyboard row, a hover, a nested level) is drawn in brand at an
  item's edge.
- **Don't** make a person wait on motion: an action responds at once.
