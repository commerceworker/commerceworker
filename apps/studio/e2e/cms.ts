import { execFileSync } from 'node:child_process';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * The CMS specs' world: one space, `e2e`, with a published "article" content type, created
 * through the web app's own gateway (same origin, as the browser does) while sign-in is still
 * open (local development, nobody added yet: the person is a deployment admin). Every CMS spec
 * opens the admin scoped to it.
 */
export const SPACE = 'e2e';
export const MGMT = `/spaces/${SPACE}/environments/main`;
const JSON_HEADERS = { 'content-type': 'application/json' };

/** Same-origin API calls the way the CMS screens make them. */
export async function api(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  data?: unknown,
) {
  return request.fetch(path, {
    method,
    headers: JSON_HEADERS,
    ...(data === undefined ? {} : { data }),
  });
}

/** Creates the e2e space and its article type, once; a 409 (already there) is fine. */
export async function seedCms(request: APIRequestContext) {
  const space = await api(request, 'POST', '/spaces', {
    spaceId: SPACE,
    name: 'E2E',
    defaultLocale: 'en-US',
  });
  expect([200, 201, 409], await space.text()).toContain(space.status());
  const type = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: true,
        required: true,
        position: 0,
      },
      { apiId: 'body', name: 'Body', type: 'Text', localized: false, required: false, position: 1 },
      {
        apiId: 'content',
        name: 'Content',
        type: 'RichText',
        localized: false,
        required: false,
        position: 2,
      },
      // A repeater, so the nested editor has something to render.
      {
        apiId: 'callouts',
        name: 'Callouts',
        type: 'Array',
        localized: false,
        required: false,
        position: 3,
        items: {
          type: 'Component',
          fields: [
            {
              apiId: 'heading',
              name: 'Heading',
              type: 'Symbol',
              localized: false,
              required: true,
              position: 0,
            },
            {
              apiId: 'body',
              name: 'Body',
              type: 'Text',
              localized: false,
              required: false,
              position: 1,
            },
          ],
        },
      },
    ],
  });
  expect([200, 201, 409], await type.text()).toContain(type.status());
  await api(request, 'POST', `${MGMT}/content-types/article/published`);
}

/**
 * Scopes the admin to the e2e space before the page loads, and fails the test on React's own
 * rendering complaints (duplicate keys and the like) rather than letting them scroll past.
 */
export async function useCmsScope(page: Page) {
  await page.addInitScript((space) => {
    localStorage.setItem(
      'commerceworker-scope',
      JSON.stringify({ space, environment: 'main', locale: 'en-US' }),
    );
  }, SPACE);
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (!/same key|Each child in a list|Warning: React/i.test(text)) return;
    throw new Error(`React reported a rendering error:\n${text}`);
  });
}

/**
 * Waiting for the editor to mount also guards against it failing to. Kept modest: if the editor
 * is not up in 15s something is wrong.
 */
export const EDITOR_READY = { timeout: 15_000 };

/**
 * Opens a CMS page and waits until it is hydrated and styled. Not `networkidle` (helpers' `open`):
 * the overview holds the Live Content API's event stream open, so the network never goes idle.
 */
export async function openCms(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'load' });
  await page.waitForFunction(
    () =>
      document.documentElement.hasAttribute('data-hydrated') &&
      getComputedStyle(document.body).overscrollBehaviorY === 'none' &&
      Boolean((window as unknown as { __reactRouterDataRouter?: object }).__reactRouterDataRouter),
  );
}

type LocaleStub = { readonly delivered: boolean; readonly direction: 'ltr' | 'rtl' };

/**
 * Locale settings for one page only, stubbed in the browser so no spec changes the shared space's
 * settings under another: `GET …/space-config` answers the real config with `locales` added and
 * their settings set, and `PUT …/locale-settings` is recorded, applied to the stub and answered as
 * the api would (the config, every locale resolved). Returns the bodies the page sent.
 */
export async function stubLocales(page: Page, locales: Readonly<Record<string, LocaleStub>>) {
  let settings: Record<string, LocaleStub> = { ...locales };
  let real: { locales: string[]; localeSettings?: Record<string, LocaleStub> } | null = null;
  const sent: unknown[] = [];
  const config = () => {
    const base = real ?? { locales: [] };
    return {
      ...base,
      locales: [...base.locales, ...Object.keys(settings).filter((l) => !base.locales.includes(l))],
      localeSettings: { ...base.localeSettings, ...settings },
    };
  };
  await page.route(`**${MGMT}/space-config`, async (route) => {
    // A refetch can still be in flight when the test ends and its page closes: that request has
    // no one left to answer, so its failure is dropped rather than reported against no test.
    try {
      const res = await route.fetch();
      real = await res.json();
      await route.fulfill({ response: res, json: config() });
    } catch (err) {
      if (!/Test ended|Target page, context or browser has been closed/.test(String(err)))
        throw err;
    }
  });
  await page.route(`**${MGMT}/locale-settings`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON() as {
      localeSettings: Record<string, Partial<LocaleStub>>;
    };
    sent.push(body);
    for (const [locale, change] of Object.entries(body.localeSettings)) {
      const was = settings[locale] ?? real?.localeSettings?.[locale];
      settings = {
        ...settings,
        [locale]: { delivered: true, direction: 'ltr', ...was, ...change },
      };
    }
    await route.fulfill({ json: config() });
  });
  return sent;
}

/** A fresh draft article, through the API; returns its id. */
export async function createDraft(request: APIRequestContext, title: string, body?: string) {
  const res = await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': title }, ...(body ? { body: { 'en-US': body } } : {}) },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { entry: { id: string } }).entry.id;
}

/** An entry's status as the Preview API reports it. */
export async function statusOf(request: APIRequestContext, id: string) {
  const res = await api(request, 'GET', `/preview/${SPACE}/main/entries?sys.id=${id}&limit=1`);
  expect(res.ok(), await res.text()).toBe(true);
  const { items } = (await res.json()) as { items: { id: string; status: string }[] };
  return items.find((e) => e.id === id)?.status;
}

const blockField = (apiId: string, name: string) => ({
  apiId,
  name,
  type: 'Symbol',
  localized: false,
  required: false,
  position: 0,
});

/**
 * A landing page shaped like the demo's "Everything showcase" (the e2e space has no demo data):
 * a Blocks field holding a hero, a section and a call to action. Returns its id and version.
 */
export async function createBlocksPage(request: APIRequestContext, title: string) {
  const type = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'landing',
    name: 'Landing page',
    displayField: 'title',
    fields: [
      { ...blockField('title', 'Title'), required: true },
      {
        apiId: 'blocks',
        name: 'Blocks',
        type: 'Array',
        localized: false,
        required: false,
        position: 1,
        items: {
          type: 'Component',
          variants: [
            { apiId: 'hero', name: 'Hero', fields: [blockField('heading', 'Heading')] },
            { apiId: 'section', name: 'Section', fields: [blockField('title', 'Title')] },
            { apiId: 'cta', name: 'Call to action', fields: [blockField('label', 'Label')] },
          ],
        },
      },
    ],
  });
  expect([200, 201, 409], await type.text()).toContain(type.status());
  await api(request, 'POST', `${MGMT}/content-types/landing/published`);
  const res = await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'landing',
    fields: {
      title: { 'en-US': title },
      blocks: {
        'en-US': [
          { _type: 'hero', heading: title },
          { _type: 'section', title: 'Features' },
          { _type: 'cta', label: 'Sign up' },
        ],
      },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const { entry } = (await res.json()) as { entry: { id: string; currentVersion: number } };
  return { id: entry.id, version: entry.currentVersion };
}

/** Saves the entry's draft again as it is, so a card held to the version before it is stale. */
export async function resaveBlocksPage(request: APIRequestContext, id: string, title: string) {
  const got = await api(request, 'GET', `${MGMT}/entries/${id}`);
  const { fields } = (await got.json()) as { fields: Record<string, unknown> };
  const saved = await api(request, 'PUT', `${MGMT}/entries/${id}`, {
    fields: { ...fields, title: { 'en-US': `${title} (saved again)` } },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
}

/** Opens Coworker (when it isn't) and sends `text` as the person's message. */
export async function askCoworker(page: Page, text: string) {
  const toggle = page.getByRole('button', { name: 'Coworker', exact: true });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const panel = page.getByRole('complementary', { name: 'Coworker' });
  const box = panel.getByRole('textbox', { name: 'Message Coworker' });
  await box.fill(text);
  await box.press('Enter');
  return panel;
}

/** A published article whose draft then changed (status `changed`): the body is edited. */
export async function createChanged(request: APIRequestContext, title: string) {
  const id = await createDraft(request, title, 'Live body');
  const published = await api(request, 'POST', `${MGMT}/entries/${id}/published`);
  expect(published.ok(), await published.text()).toBe(true);
  const edited = await api(request, 'PUT', `${MGMT}/entries/${id}`, {
    fields: { title: { 'en-US': title }, body: { 'en-US': 'Edited body' } },
  });
  expect(edited.ok(), await edited.text()).toBe(true);
  return id;
}

/**
 * Makes the page's edits go straight to the API, as they do whenever the assistant can't be
 * reached: its socket is refused, so a row's Publish opens the page's own confirmation rather than
 * a card in the assistant's panel.
 */
export async function withoutAssistant(page: Page) {
  await page.routeWebSocket(/\/agents\//, (ws) => ws.close({ code: 1011 }));
}

/** The entry the seeded agent proposal targets: the Approvals sweeps look it up by this title. */
export const PROPOSAL_TARGET = 'Proposal target';

/**
 * One pending agent proposal for `entryId`, written into the e2e database (there is no API to
 * propose: agents do, from a workflow run). Deterministic id and time, so a rerun replaces it.
 * Written once from the global setup, while the dev server is idle: a second writer on the same
 * file during the run would lose the lock to the server.
 */
export function seedAgentReview(entryId: string) {
  const proposed = JSON.stringify({ body: { 'en-US': 'Agent proposed body' } });
  const notes = JSON.stringify(['Tightened the body to one concrete claim']);
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const sql =
    'INSERT OR REPLACE INTO agent_reviews ' +
    '(space_id, environment_id, id, workflow, entry_id, proposed, notes, status, awaiting, created_at) ' +
    `VALUES (${q(SPACE)}, 'main', ${q(`e2e-review-${entryId}`)}, 'enrich', ${q(entryId)}, ` +
    `${q(proposed)}, ${q(notes)}, 'pending', 0, 1767225600000)`;
  execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      'commerceworker',
      '--local',
      '--persist-to',
      '.wrangler/e2e',
      '--command',
      sql,
    ],
    { stdio: 'pipe' },
  );
}

/** The e2e space with a draft article and a pending agent proposal for it (see PROPOSAL_TARGET). */
export async function seedAgentProposal(request: APIRequestContext) {
  await seedCms(request);
  seedAgentReview(await createDraft(request, PROPOSAL_TARGET, 'Current body'));
}

/**
 * Shows the admin a deployment with no spaces but `keep`: the e2e database is shared by specs
 * running side by side, so instead of a database of its own, a spec that needs the first-run
 * screens filters `GET /spaces` down to the spaces it creates itself.
 */
export async function asFreshDeployment(page: Page, keep: (id: string) => boolean) {
  await page.route(
    (url) => url.pathname === '/spaces',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      const body = (await res.json()) as { items: { id: string }[] };
      await route.fulfill({ response: res, json: { items: body.items.filter((s) => keep(s.id)) } });
    },
  );
}

/** Creates an asset record (no bytes: the library lists it all the same) and returns its id. */
export async function seedAsset(
  request: APIRequestContext,
  title: string,
  opts: {
    readonly folderId?: string;
    readonly publish?: boolean;
    /** Archived: the state an asset has to be in before it can be deleted. */
    readonly archive?: boolean;
    readonly contentType?: string;
  } = {},
): Promise<string> {
  const contentType = opts.contentType ?? 'image/png';
  const res = await api(request, 'POST', `${MGMT}/assets`, {
    fileName: `${title.replace(/\W+/g, '-')}.${contentType.split('/')[1] ?? 'bin'}`,
    contentType,
    title: { 'en-US': title },
    ...(opts.folderId ? { folderId: opts.folderId } : {}),
  });
  expect(res.ok(), await res.text()).toBe(true);
  const { asset } = (await res.json()) as { asset: { id: string } };
  if (opts.publish) {
    const pub = await api(request, 'POST', `${MGMT}/assets/${asset.id}/published`);
    expect(pub.ok(), await pub.text()).toBe(true);
  }
  if (opts.archive) {
    const archived = await api(request, 'POST', `${MGMT}/assets/${asset.id}/archive`);
    expect(archived.ok(), await archived.text()).toBe(true);
  }
  return asset.id;
}

/** Creates an asset folder at the library root and returns its id. */
export async function seedAssetFolder(request: APIRequestContext, name: string): Promise<string> {
  const res = await api(request, 'POST', `${MGMT}/asset-folders`, { name });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/**
 * Creates an asset and PUTs its bytes through the signed upload URL, as the admin's Upload does,
 * which hands the file to ingest. Returns the asset's id.
 */
export async function uploadAssetBytes(
  request: APIRequestContext,
  fileName: string,
  bytes: Buffer,
  contentType = 'text/plain',
): Promise<string> {
  const res = await api(request, 'POST', `${MGMT}/assets`, {
    fileName,
    contentType,
    title: { 'en-US': fileName },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const { asset, upload } = (await res.json()) as {
    asset: { id: string };
    upload: { url: string; headers: Record<string, string> };
  };
  const put = await request.fetch(upload.url, {
    method: 'PUT',
    headers: upload.headers,
    data: bytes,
  });
  expect(put.ok(), await put.text()).toBe(true);
  return asset.id;
}

interface IngestState {
  readonly ingestStatus?: string;
  readonly ingestError?: string;
  readonly duplicateOf?: string;
}

/** The asset as the Management API returns it, for what ingest recorded on it. */
async function ingestOf(request: APIRequestContext, id: string): Promise<IngestState> {
  const res = await api(request, 'GET', `${MGMT}/assets/${id}`);
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as IngestState;
}

/**
 * What ingest finds, seeded through the API: two uploads of the same bytes (the second a possible
 * duplicate of the first), and an asset whose file never arrived, sent through ingest, which fails
 * on it ("The file is not in storage") once the hash step's retries are spent. Waits for both.
 */
export async function seedIngestFindings(request: APIRequestContext, stamp: number) {
  // Specs run side by side and can draw the same millisecond: the bytes and names must still be
  // theirs alone, or one spec's twin is the other's duplicate.
  stamp = stamp * 1000 + Math.floor(Math.random() * 1000);
  const bytes = Buffer.from(`the same bytes, twice ${stamp}`);
  const original = `twin-a-${stamp}.txt`;
  const copy = `twin-b-${stamp}.txt`;
  const originalId = await uploadAssetBytes(request, original, bytes);
  // The copy goes up once the original is ingested, as a later upload of the same file would.
  await expect
    .poll(async () => (await ingestOf(request, originalId)).ingestStatus, { timeout: 90_000 })
    .toBe('ready');
  const copyId = await uploadAssetBytes(request, copy, bytes);
  const broken = `Broken ${stamp}`;
  const brokenId = await seedAsset(request, broken);
  const retry = await api(request, 'POST', `${MGMT}/assets/${brokenId}/reingest`);
  expect(retry.ok(), await retry.text()).toBe(true);
  // Settled first, so a run that failed says so (with its reason) rather than timing out.
  await expect
    .poll(async () => (await ingestOf(request, copyId)).ingestStatus, { timeout: 90_000 })
    .toMatch(/^(ready|error)$/);
  const copied = await ingestOf(request, copyId);
  expect(copied, JSON.stringify(copied)).toMatchObject({
    ingestStatus: 'ready',
    duplicateOf: originalId,
  });
  await expect
    .poll(async () => (await ingestOf(request, brokenId)).ingestStatus, { timeout: 120_000 })
    .toBe('error');
  // Filed in a folder of their own: specs upload side by side during the ingest waits above, and
  // the library's first page (the latest 50) can no longer be counted on to hold these.
  const folder = `Ingest ${stamp}`;
  const folderId = await seedAssetFolder(request, folder);
  const moved = await api(request, 'POST', `${MGMT}/assets/move`, {
    ids: [originalId, copyId, brokenId],
    folderId,
  });
  expect(moved.ok(), await moved.text()).toBe(true);
  return { original, copy, broken, folder };
}

/**
 * A type of its own for a spec that saves one: specs run in parallel, and a save replaces it.
 * Its agent instructions are cleared, so a rerun on the same database starts without them.
 */
export async function seedBriefedType(request: APIRequestContext) {
  const res = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'briefed',
    name: 'Briefed',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
    agentInstructions: null,
  });
  expect(res.status()).toBeLessThan(300);
}

/**
 * A content type whose fields carry guidance: help and a placeholder on its title, a plain field
 * with none, and listed values on another (bare, so the type reads the same on every version of
 * the api). Created or updated by apiId, so it is safe to run per test.
 */
export async function seedGuidedType(request: APIRequestContext) {
  const field = (apiId: string, name: string, position: number, extra: object = {}) => ({
    apiId,
    name,
    type: 'Symbol',
    localized: false,
    required: false,
    position,
    ...extra,
  });
  const res = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'guided',
    name: 'Guided',
    displayField: 'title',
    fields: [
      field('title', 'Title', 0, {
        required: true,
        help: 'Lead with the neighbourhood.',
        placeholder: 'Sunny two-bed in Leith',
        description: 'The headline of the listing.',
      }),
      field('subtitle', 'Subtitle', 1),
      field('status', 'Status', 2, {
        validations: { in: ['open', 'let'], messages: { in: 'Pick a status from the list' } },
      }),
    ],
  });
  if (![200, 201].includes(res.status())) throw new Error(await res.text());
  await api(request, 'POST', `${MGMT}/content-types/guided/published`);
}

/**
 * A content type whose fields carry conditional rules: "Sold to" is hidden (and so not required)
 * until Status is "sold", and "Reference" turns read-only once it is. Created or updated by apiId,
 * so it is safe to run per test.
 */
export async function seedRuledType(request: APIRequestContext) {
  const field = (apiId: string, name: string, position: number, extra: object = {}) => ({
    apiId,
    name,
    type: 'Symbol',
    localized: false,
    required: false,
    position,
    ...extra,
  });
  const res = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'ruled',
    name: 'Ruled',
    displayField: 'title',
    fields: [
      field('title', 'Title', 0, { required: true }),
      field('status', 'Status', 1),
      field('soldTo', 'Sold to', 2, {
        required: true,
        rules: [{ action: 'hide', when: { field: 'status', operator: 'ne', value: 'sold' } }],
      }),
      field('reference', 'Reference', 3, {
        rules: [{ action: 'disable', when: { field: 'status', operator: 'eq', value: 'sold' } }],
      }),
    ],
  });
  if (![200, 201].includes(res.status())) throw new Error(await res.text());
  await api(request, 'POST', `${MGMT}/content-types/ruled/published`);
}

/**
 * A content type filed under a group with an icon, laid out in two tabs (a named group on the
 * second), with a date-only field: what the content nav, the dialog's Settings and Layout, and the
 * entry form's tabs are exercised on.
 */
export async function seedLaidOutType(request: APIRequestContext) {
  const field = (apiId: string, name: string, position: number, extra: object = {}) => ({
    apiId,
    name,
    type: 'Symbol',
    localized: false,
    required: false,
    position,
    ...extra,
  });
  const res = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'happening',
    name: 'Happening',
    displayField: 'title',
    group: 'Programme',
    icon: 'calendar',
    description: 'Something on the calendar.',
    layout: {
      tabs: [
        { apiId: 'main', name: 'Main', groups: [{ fields: ['title'] }] },
        { apiId: 'when', name: 'When', groups: [{ name: 'Timing', fields: ['day', 'note'] }] },
      ],
    },
    fields: [
      field('title', 'Title', 0, { required: true }),
      field('day', 'Day', 1, { type: 'Date', format: 'date' }),
      field('note', 'Note', 2, { validations: { regexp: { preset: 'email' } } }),
    ],
  });
  if (![200, 201].includes(res.status())) throw new Error(await res.text());
  await api(request, 'POST', `${MGMT}/content-types/happening/published`);
}

/**
 * A type laid out in two tabs with a required field in a collapsed group on the second, and an
 * asset link that takes images only: what the entry form's tab keys, a rejected save's jump and
 * the file-type-filtered asset picker are exercised on.
 */
export async function seedVenueType(request: APIRequestContext) {
  const field = (apiId: string, name: string, position: number, extra: object = {}) => ({
    apiId,
    name,
    type: 'Symbol',
    localized: false,
    required: false,
    position,
    ...extra,
  });
  const res = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'venue',
    name: 'Venue',
    displayField: 'title',
    layout: {
      tabs: [
        { apiId: 'main', name: 'Main', groups: [{ fields: ['title', 'poster'] }] },
        {
          apiId: 'contact',
          name: 'Contact',
          groups: [{ name: 'Booking', fields: ['email'], collapsed: true }],
        },
      ],
    },
    fields: [
      field('title', 'Title', 0, { required: true }),
      field('poster', 'Poster', 1, {
        type: 'Link',
        linkType: 'Asset',
        validations: { assetMimeTypes: ['image/*'] },
      }),
      field('email', 'Booking email', 2, { required: true }),
    ],
  });
  if (![200, 201].includes(res.status())) throw new Error(await res.text());
  await api(request, 'POST', `${MGMT}/content-types/venue/published`);
}

/** A type with a list of whole numbers and a time-of-day field: the scalar list editor's ground. */
export async function seedShelfType(request: APIRequestContext) {
  const res = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId: 'shelf',
    name: 'Shelf',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
      {
        apiId: 'sizes',
        name: 'Sizes',
        type: 'Array',
        items: { type: 'Integer' },
        localized: false,
        required: false,
        position: 1,
      },
      {
        apiId: 'opens',
        name: 'Opens',
        type: 'Date',
        format: 'time',
        localized: false,
        required: false,
        position: 2,
      },
    ],
  });
  if (![200, 201].includes(res.status())) throw new Error(await res.text());
  await api(request, 'POST', `${MGMT}/content-types/shelf/published`);
}
