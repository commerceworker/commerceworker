import { writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import {
  api,
  createChanged,
  createDraft,
  EDITOR_READY,
  MGMT,
  openCms,
  SPACE,
  seedAsset,
  seedAssetFolder,
  seedBriefedType,
  seedCms,
  seedGuidedType,
  seedIngestFindings,
  seedLaidOutType,
  seedRuledType,
  seedShelfType,
  seedVenueType,
  statusOf,
  stubLocales,
  uploadAssetBytes,
  useCmsScope,
  withoutAssistant,
} from './cms';

/*
 * The CMS screens end to end against the local stack (web + api + engine on one local D1):
 * author and publish, rich text, the unsaved-changes guards, bulk actions, trash and duplicate,
 * and the settings sections. Ported from the Vite admin's admin.spec.ts. A page's actions go through
 * the assistant (its agent runs in the engine here): they stop at a confirm card in its panel.
 */

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

/** The seeded content type's entries list, from the Content section's own sub-nav. */
/**
 * Confirms a page's action at its card in the assistant's panel; the page waits on the answer. The
 * conversation is the one person's, kept across tests and live in all of them, so the card is found
 * by the entry it names: the newest "Publish this entry" can be another test's, here before this
 * one's has arrived. Newest of those, for an entry asked about twice.
 */
async function confirmCard(page: Page, title: string, about: string) {
  const card = page
    .getByRole('complementary', { name: 'Coworker' })
    .getByRole('region', { name: title })
    .filter({ hasText: about })
    .last();
  await card.getByRole('button', { name: 'Confirm' }).click();
}

/**
 * The Article list, from the Content overview's card: the content-type list beside the page gives
 * way while the assistant's column is open.
 */
async function toArticles(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Content', exact: true })
    .first()
    .click();
  // The seeded space has one content type: Article.
  await page
    .getByRole('main')
    .getByRole('list', { name: 'Content types' })
    .getByRole('link', { name: 'Article', exact: true })
    .click();
  await expect(page).toHaveURL(/\/content\/article$/);
  // From md the header says where you are (once a space is in scope).
  await expect(
    page.getByRole('banner').getByRole('navigation', { name: 'breadcrumb' }).getByText('Article'),
  ).toBeVisible();
}

/** A new article's editor. */
async function newArticle(page: Page) {
  await openCms(page, '/content/article/new');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible(EDITOR_READY);
}

test('the entries list offers New entry for its content type', async ({ page }) => {
  await openCms(page, '/content/article');
  const link = page.getByRole('link', { name: 'New entry', exact: true }).first();
  await expect(link).toHaveAttribute('href', '/content/article/new');
});

test('authors and publishes an entry end-to-end', async ({ page }) => {
  await openCms(page, '/content');
  await toArticles(page);
  await newArticle(page);
  const title = `E2E ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  // Publish from the editor header: confirmed at the assistant's card.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await confirmCard(page, 'Publish this entry', title);
  await expect(page.getByText(/Published v\d+/)).toBeVisible();

  // Back on the list, the entry shows as published (in words, not only colour).
  await toArticles(page);
  const row = page.getByRole('row', { name: new RegExp(title) });
  await expect(row).toBeVisible();
  await expect(row.getByText(/published/i)).toBeVisible();
});

test('authors rich text with marks and persists it across a reload', async ({ page }) => {
  await newArticle(page);
  const title = `Rich ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title);

  // Select the word only once ProseMirror has accepted the selection (it re-asserts the caret
  // after digesting typed input, which can wipe a selection made in the gap).
  const editor = page.locator('.rich-text-editor');
  const selectLeft = async (word: string) => {
    const read = () => page.evaluate(() => window.getSelection()?.toString() ?? '');
    for (let i = 0; i < word.length; i++) await page.keyboard.press('Shift+ArrowLeft');
    const deadline = Date.now() + 8000;
    let stable = 0;
    while (Date.now() < deadline) {
      const sel = await read();
      if (sel === word) {
        stable += 1;
        if (stable >= 2) return;
        await page.waitForTimeout(75);
        continue;
      }
      stable = 0;
      if (sel.length < word.length && word.endsWith(sel)) {
        await page.keyboard.press('Shift+ArrowLeft');
      } else {
        await page.waitForTimeout(50);
      }
    }
    expect(await read()).toBe(word);
  };
  await editor.click();
  await page.keyboard.type('Plain then bolded');
  await selectLeft('bolded');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(editor.locator('strong')).toHaveText('bolded');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();

  // Reopen the entry from the list: the stored document round-trips back.
  await toArticles(page);
  const row = page.getByRole('row', { name: new RegExp(title) });
  await row.getByRole('link', { name: title, exact: true }).click();
  const reopened = page.locator('.rich-text-editor');
  await expect(reopened).toContainText('Plain then bolded');
  await expect(reopened.locator('strong')).toHaveText('bolded');
});

test('publishing with unsaved edits saves first, then confirms', async ({ page }) => {
  await newArticle(page);
  const title = `Chain ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();
  await page.getByRole('textbox', { name: /Title/ }).fill(`${title} v2`);
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Draft updated')).toBeVisible();
  // Named as just saved, not as the page read before the save.
  await confirmCard(page, 'Publish this entry', `${title} v2`);
  await expect(page.getByText(/Published v\d+/)).toBeVisible();

  // Publish with an INVALID form: feedback at the button, no confirm.
  await page.getByRole('textbox', { name: /Title/ }).fill('');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Fix 1 field error to publish')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish entry' })).not.toBeVisible();
});

test('navigating away from unsaved edits asks before discarding', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('iphone'), 'the editor is review-only on a phone');
  await newArticle(page);
  await page.getByRole('textbox', { name: /Title/ }).fill(`Guard ${Date.now()}`);

  const overview = page.getByRole('navigation', { name: 'Main' }).getByRole('link', {
    name: 'Overview',
  });
  await overview.first().click();
  await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByRole('textbox', { name: /Title/ })).toBeVisible();

  await overview.first().click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

// Through the page's own confirm, not a card in the assistant's panel. The conversation is the one
// person's, shared by every spec running alongside: its cards (a retried attempt's card has this
// one's title, and `.last()` can take it before the new one renders) and its rate window (30
// calls a minute, spent by every spec's saves) change under this spec. The card path itself is
// covered by apps/pipeline/test/assistant.test.ts and apps/studio/tests/assistant-panel.test.tsx.
test('the bulk bar offers what applies to the ticked drafts and names them in its confirm', async ({
  page,
  request,
}) => {
  await withoutAssistant(page);
  const stamp = Date.now();
  for (const n of [1, 2]) {
    const res = await api(request, 'POST', `${MGMT}/entries`, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': `Bulk ${stamp} ${n}` } },
    });
    expect(res.ok(), await res.text()).toBe(true);
  }
  await openCms(page, '/content/article');
  for (const n of [1, 2]) {
    await page
      .getByRole('row', { name: new RegExp(`Bulk ${stamp} ${n}`) })
      .getByRole('checkbox')
      .check();
  }
  // Ticking swaps the filter bar for the bulk bar; drafts can be published, not unpublished.
  const bar = page.getByRole('group', { name: 'Selected entries' });
  await expect(bar.getByText('2 selected')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search entries' })).toBeHidden();
  await expect(bar.getByRole('button', { name: 'Unpublish selected' })).toHaveCount(0);
  await bar.getByRole('button', { name: 'Publish selected' }).click();
  // Asked once, for the whole selection, by name.
  const confirm = page.getByRole('alertdialog', { name: 'Publish 2 entries?' });
  await expect(confirm.getByText(`Bulk ${stamp} 1`)).toBeVisible();
  await expect(confirm.getByText(`Bulk ${stamp} 2`)).toBeVisible();
  await confirm.getByRole('button', { name: 'Keep as is' }).click();
  await expect(confirm).toBeHidden();
  await bar.getByRole('button', { name: 'Clear selection' }).click();
  await expect(page.getByRole('searchbox', { name: 'Search entries' })).toBeVisible();
});

test('saves the list as a view, reopens it from a clean list and from its link, and shares it', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  for (const which of ['keep', 'other']) {
    const res = await api(request, 'POST', `${MGMT}/entries`, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': `View ${stamp} ${which}` } },
    });
    expect(res.ok(), await res.text()).toBe(true);
  }
  const keep = page.getByRole('row', { name: new RegExp(`View ${stamp} keep`) });
  const other = page.getByRole('row', { name: new RegExp(`View ${stamp} other`) });
  await openCms(page, '/content/article');
  await page.getByRole('searchbox', { name: 'Search entries' }).fill(`View ${stamp} keep`);
  // The search is the URL, as the API reads it.
  await expect(page).toHaveURL(new RegExp(`query=View(\\+|%20)${stamp}`));
  await expect(other).toHaveCount(0);
  await expect(keep).toBeVisible();

  const name = `Keepers ${stamp}`;
  await page.getByRole('button', { name: 'Views' }).click();
  await page.getByRole('menuitem', { name: 'Save as new view…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save view' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog.getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByText(`Saved “${name}”`)).toBeVisible();
  await expect(page).toHaveURL(/view=/);
  const link = page.url();

  // A clean list shows both; the view brings its filter back.
  await openCms(page, '/content/article');
  await expect(other).toBeVisible();
  await page.getByRole('button', { name: 'Views' }).click();
  await page.getByRole('menuitemradio', { name }).click();
  await expect(keep).toBeVisible();
  await expect(other).toHaveCount(0);

  // Its link opens the same list.
  await page.goto(link);
  await expect(keep).toBeVisible();
  await expect(other).toHaveCount(0);
  await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible();

  // Shared, it moves under the space's views.
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await page.getByRole('menuitem', { name: 'Share with the space' }).click();
  await expect(page.getByText(`“${name}” is shared with everyone in the space`)).toBeVisible();
  await page.getByRole('button', { name: new RegExp(name) }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Shared with the space')).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name })).toBeVisible();
  await page.keyboard.press('Escape');
  const listed = await api(request, 'GET', `${MGMT}/saved-views?content_type=article`);
  const views = (await listed.json()) as { items: { name: string; visibility: string }[] };
  expect(views.items.find((v) => v.name === name)?.visibility).toBe('shared');
});

test('a saved view: renamed, saved over, refused when stale, unshared, then deleted', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  await createDraft(request, `Flow ${stamp} one`);
  await createDraft(request, `Flow ${stamp} two`);
  await openCms(page, '/content/article');
  const searchbox = page.getByRole('searchbox', { name: 'Search entries' });

  // Typing in the list is the list's own state: it asks nothing of the shell's server loader.
  const loads: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.endsWith('.data')) loads.push(r.url());
  });
  await searchbox.pressSequentially(`Flow ${stamp} one`);
  await expect(page).toHaveURL(new RegExp(`query=Flow(\\+|%20)${stamp}(\\+|%20)one`));
  expect(loads).toEqual([]);

  const views = page.getByRole('button', { name: 'Views' });
  const first = `Flow view ${stamp}`;
  const name = `Renamed ${stamp}`;
  const trigger = (view: string) => page.getByRole('button', { name: new RegExp(view) });
  await views.click();
  await page.getByRole('menuitem', { name: 'Save as new view…' }).click();
  const saving = page.getByRole('dialog', { name: 'Save view' });
  await saving.getByRole('textbox', { name: 'Name' }).fill(first);
  await saving.getByRole('switch', { name: 'Share with the space' }).click();
  await saving.getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByText(`Saved “${first}” for everyone`)).toBeVisible();
  // An open view's trigger says so, with its visible text in the name.
  await expect(trigger(first)).toHaveAccessibleName(`View: ${first}`);

  await trigger(first).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  const renaming = page.getByRole('dialog', { name: 'Rename view' });
  await renaming.getByRole('textbox', { name: 'Name' }).fill(name);
  await renaming.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByText(`Renamed to “${name}”`)).toBeVisible();
  await expect(trigger(name)).toHaveAccessibleName(`View: ${name}`);

  // Edited, it says so; someone else saving first refuses this save, and it reads the view again.
  await searchbox.fill(`Flow ${stamp}`);
  await expect(trigger(`${name}.*edited`)).toBeVisible();
  const listed = await api(request, 'GET', `${MGMT}/saved-views?content_type=article`);
  const saved = (await listed.json()) as { items: { id: string; name: string }[] };
  const id = saved.items.find((v) => v.name === name)?.id;
  const other = await api(request, 'PATCH', `${MGMT}/saved-views/${id}`, {
    query: { search: `Flow ${stamp} two` },
  });
  expect(other.ok(), await other.text()).toBe(true);
  await trigger(name).click();
  const save = page.getByRole('menuitem', { name: `Save changes to “${name}”` });
  await save.click();
  await expect(page.getByText(/saved by someone else since/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`query=Flow(\\+|%20)${stamp}(&|$)`));
  // Asked again, on the view as it now stands, it goes through.
  await trigger(name).click();
  await save.click();
  await expect(page.getByText(`Saved “${name}”`)).toBeVisible();
  await expect(trigger(name)).not.toContainText('edited');
  const read = await api(request, 'GET', `${MGMT}/saved-views/${id}`);
  expect(((await read.json()) as { query: unknown }).query).toEqual({ search: `Flow ${stamp}` });

  // Unshared, it is the creator's alone: back under their own views, as a fresh read says.
  await trigger(name).click();
  await page.getByRole('menuitem', { name: 'Stop sharing' }).click();
  await expect(page.getByText(`“${name}” is yours alone now`)).toBeVisible();
  await page.reload();
  await trigger(name).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Your views')).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Share with the space' })).toBeVisible();

  // Backing out of the delete and going through with it both leave the keyboard on the trigger.
  await menu.getByRole('menuitem', { name: 'Delete view…' }).click();
  const confirm = page.getByRole('alertdialog', { name: `Delete “${name}”?` });
  await confirm.getByRole('button', { name: 'Keep view' }).click();
  await expect(confirm).toBeHidden();
  await expect(trigger(name)).toBeFocused();
  await trigger(name).click();
  await page.getByRole('menuitem', { name: 'Delete view…' }).click();
  await confirm.getByRole('button', { name: 'Delete view' }).click();
  await expect(page.getByText(`Deleted “${name}”`)).toBeVisible();
  await expect(views).toBeFocused();
  await expect(page).not.toHaveURL(/view=/);
});

test('a link’s grouped conditions show in the filters and can be removed', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  await createDraft(request, `Group ${stamp} in`);
  await createDraft(request, `Other ${stamp} out`);
  const where = { or: [{ field: 'title', op: 'startsWith', value: `Group ${stamp}` }] };
  await openCms(page, `/content/article?where=${encodeURIComponent(JSON.stringify(where))}`);
  const kept = page.getByRole('row', { name: new RegExp(`Group ${stamp} in`) });
  const other = page.getByRole('row', { name: new RegExp(`Other ${stamp} out`) });
  await expect(kept).toBeVisible();
  await expect(other).toHaveCount(0);

  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByText(/grouped conditions/)).toBeVisible();
  await page.getByRole('button', { name: 'Remove them' }).click();
  await expect(page.getByText(/grouped conditions/)).toHaveCount(0);
  await expect(page).not.toHaveURL(/where=/);
  await expect(other).toBeVisible();
});

test('trashes an entry, restores it, then deletes it permanently', async ({ page, request }) => {
  const title = `Trash ${Date.now()}`;
  await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': title } },
  });
  await openCms(page, '/content/article');

  const row = page.getByRole('row', { name: new RegExp(title) });
  await row.getByRole('button', { name: /^More actions for / }).click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await confirmCard(page, 'Move this entry to the trash', title);
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeHidden();

  await page.getByRole('button', { name: 'View trash' }).click();
  const trashed = page.getByRole('row', { name: new RegExp(title) });
  await expect(trashed).toBeVisible();
  await trashed.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeHidden();
  await page.getByRole('button', { name: 'Back to entries' }).click();
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeVisible();

  await page
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: /^More actions for / })
    .click();
  await page.getByRole('menuitem', { name: 'Move to trash' }).click();
  await confirmCard(page, 'Move this entry to the trash', title);
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeHidden();
  await page.getByRole('button', { name: 'View trash' }).click();
  await page
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: /^More actions for / })
    .click();
  await page.getByRole('menuitem', { name: 'Delete permanently…' }).click();
  await confirmCard(page, 'Delete this entry for good', title);
  await expect(page.getByRole('row', { name: new RegExp(title) })).toBeHidden();
});

test('moves two entries to the trash as a job, then deletes them permanently from the trash', async ({
  page,
  request,
}) => {
  // Two bulk jobs the engine works through: the queue consumer and outbox relay run locally.
  test.setTimeout(180_000);
  // The page's own dialogs (the assistant's card is the jsdom suite's): each asks by name.
  await withoutAssistant(page);
  const stamp = Date.now();
  const titles = [`Bulk trash ${stamp} 1`, `Bulk trash ${stamp} 2`];
  for (const title of titles) {
    const res = await api(request, 'POST', `${MGMT}/entries`, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': title } },
    });
    expect(res.ok(), await res.text()).toBe(true);
  }
  await openCms(page, '/content/article');
  for (const title of titles) {
    await page
      .getByRole('row', { name: new RegExp(title) })
      .getByRole('checkbox')
      .check();
  }
  const bar = page.getByRole('group', { name: 'Selected entries' });
  await bar.getByRole('button', { name: 'Move to trash' }).click();
  const trash = page.getByRole('alertdialog', { name: 'Move 2 entries to the trash?' });
  for (const title of titles) await expect(trash.getByText(title)).toBeVisible();
  await trash.getByRole('button', { name: 'Move to trash' }).click();
  const job = page.getByRole('region', { name: 'Bulk job' });
  await expect(job.getByRole('status')).toHaveText('Trashed 2 entries', { timeout: 120_000 });
  for (const title of titles) {
    await expect(page.getByRole('row', { name: new RegExp(title) })).toBeHidden();
  }
  await job.getByRole('button', { name: 'Dismiss' }).click();

  await page.getByRole('button', { name: 'View trash' }).click();
  for (const title of titles) {
    await page
      .getByRole('row', { name: new RegExp(title) })
      .getByRole('checkbox')
      .check();
  }
  await bar.getByRole('button', { name: 'Delete permanently…' }).click();
  const purge = page.getByRole('alertdialog', { name: 'Permanently delete 2 entries?' });
  for (const title of titles) await expect(purge.getByText(title)).toBeVisible();
  await expect(purge.getByText(/can’t be undone/)).toBeVisible();
  await purge.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(job.getByRole('status')).toHaveText('Permanently deleted 2 entries', {
    timeout: 120_000,
  });
  for (const title of titles) {
    await expect(page.getByRole('row', { name: new RegExp(title) })).toBeHidden();
  }
  await expect(bar).toBeHidden();
});

test('Settings → Trash: turning retention on asks in place before it saves', async ({ page }) => {
  await openCms(page, '/settings/trash');
  await page.getByRole('radio', { name: 'Delete after a while' }).click();
  const days = page.getByLabel('Days in the trash');
  await days.fill('3650');
  await expect(page.getByText(/longer than 3650 days/)).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // Asked in place, the safe choice focused; backing out saves nothing.
  await expect(page.getByText('Delete trashed entries after 3650 days?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep as is' })).toBeFocused();
  await page.getByRole('button', { name: 'Keep as is' }).click();
  await expect(page.getByText('Delete trashed entries after 3650 days?')).toBeHidden();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Keep until deleted' })).toBeChecked();
});

test('Settings → Locales: a direction saves at once, turning delivery off asks first', async ({
  page,
}) => {
  // Stubbed in the browser (see stubLocales): the shared space's settings never change.
  const sent = await stubLocales(page, { ar: { delivered: true, direction: 'ltr' } });
  await openCms(page, '/settings/locales');
  // The default locale can't stop being delivered, and says why.
  const en = page.getByRole('switch', { name: 'Deliver en-US' });
  await expect(en).toBeDisabled();
  await expect(en).toHaveAccessibleDescription(/every fallback ends here/);

  await page
    .getByRole('radiogroup', { name: 'Text direction of ar' })
    .getByRole('radio', {
      name: 'Right to left',
    })
    .click();
  await expect.poll(() => sent).toEqual([{ localeSettings: { ar: { direction: 'rtl' } } }]);
  await expect(
    page.getByRole('radiogroup', { name: 'Text direction of ar' }).getByRole('radio', {
      name: 'Right to left',
    }),
  ).toBeChecked();

  const ar = page.getByRole('switch', { name: 'Deliver ar' });
  await ar.click();
  await expect(page.getByRole('alertdialog', { name: 'Stop delivering ar?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep delivering' })).toBeFocused();
  await page.getByRole('button', { name: 'Keep delivering' }).click();
  await expect(ar).toBeChecked();
  expect(sent).toHaveLength(1);
  await ar.click();
  await page.getByRole('button', { name: 'Stop delivering' }).click();
  await expect(ar).not.toBeChecked();
  expect(sent.at(-1)).toEqual({ localeSettings: { ar: { delivered: false } } });
  // The header's locale switcher reads the same config, refreshed by the save.
  await page.getByRole('combobox', { name: 'Locale' }).click();
  await expect(page.getByRole('option', { name: 'ar Not delivered' })).toBeVisible();
});

test('duplicates an entry into a new draft marked as a copy', async ({ page, request }) => {
  const title = `Dup ${Date.now()}`;
  await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': title } },
  });
  await openCms(page, '/content/article');
  await page
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: /^More actions for / })
    .click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.getByRole('heading', { name: `${title} (copy)` })).toBeVisible();
  await toArticles(page);
  const list = page.getByRole('table');
  await expect(list.getByRole('link', { name: `${title} (copy)`, exact: true })).toBeVisible();
  await expect(list.getByRole('link', { name: title, exact: true })).toBeVisible();
});

test('settings lists the space’s API keys, and the space access section', async ({
  page,
  request,
}) => {
  const name = `e2e-key-${Date.now()}`;
  const minted = await api(request, 'POST', `/spaces/${SPACE}/api-keys`, { kind: 'cda', name });
  expect(minted.ok(), await minted.text()).toBe(true);
  await openCms(page, '/settings/team');
  await expect(page.getByRole('heading', { name: 'People in this space' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'API keys' })
    .click();
  await expect(page.getByRole('heading', { name: 'API keys' })).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
});

test('Settings → Audit log: pressing a target filters the log, and Clear brings it back', async ({
  page,
  request,
}) => {
  const id = await createDraft(request, `Audited ${Date.now()}`);
  const update = await api(request, 'PUT', `${MGMT}/entries/${id}`, {
    fields: { title: { 'en-US': `Audited again ${Date.now()}` } },
  });
  expect(update.ok(), await update.text()).toBe(true);
  await openCms(page, '/settings/audit-log');
  await page
    .getByRole('button', { name: `Filter by target ${id}` })
    .first()
    .click();
  await expect(page.getByLabel('Target ID')).toHaveValue(id);
  await expect(page.getByLabel('Target type')).toHaveValue('entry');
  const rows = page.getByRole('button', { name: /^Filter by actor / });
  // The save, and the create: a create's row names the entry it made.
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole('cell', { name: /^title/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByLabel('Target ID')).toHaveValue('');
  await expect.poll(() => rows.count()).toBeGreaterThan(1);
});

test('a webhook is sent a test, and its delivery is resent from the log', async ({ page }) => {
  await openCms(page, '/settings/webhooks');
  // A public address: the engine sends to it for real, so the attempt may succeed or fail (offline);
  // either way it is logged.
  const url = `https://example.com/cw-e2e-${Date.now()}`;
  await page.getByPlaceholder('https://example.com/hooks/cms').fill(url);
  await page.getByPlaceholder('Signing secret').fill('e2e-secret');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await page.getByRole('button', { name: `Send test to ${url}` }).click();
  // The log opens on its own and waits for the engine to send the test.
  const log = page.getByRole('dialog', { name: 'Deliveries' });
  await expect(log).toBeVisible();
  await expect(log.getByRole('cell', { name: /webhook\.test/ }).first()).toBeVisible({
    timeout: 30_000,
  });
  await log
    .getByRole('button', { name: /^Resend delivery #\d+$/ })
    .first()
    .click();
  await expect(log.getByText(/resend of #\d+/)).toBeVisible({ timeout: 30_000 });
});

test('an unknown settings section lands on the first one', async ({ page }) => {
  await openCms(page, '/settings/connection');
  await expect(page).toHaveURL(/\/settings\/team$/);
});

test('API calls go to the same origin and carry the read-your-writes bookmark', async ({
  page,
}) => {
  const seen: { url: string; bookmark: string | null; auth: string | null }[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/spaces')) return;
    seen.push({
      url: url.origin,
      bookmark: req.headers()['x-cw-bookmark'] ?? null,
      auth: req.headers().authorization ?? null,
    });
  });
  await openCms(page, '/content/article');
  await expect(page.getByRole('table')).toBeVisible();
  const origin = new URL(page.url()).origin;
  expect(seen.length).toBeGreaterThan(1);
  for (const s of seen) {
    expect(s.url).toBe(origin);
    // No bearer token: the gateway signs the session into the forwarded request.
    expect(s.auth).toBeNull();
  }
  // Once the api has answered with a bookmark, later requests send it back.
  expect(seen.slice(1).some((s) => s.bookmark)).toBe(true);
});

test('the editor’s Activity view lists the entry’s history with the fields each save changed', async ({
  page,
  request,
}) => {
  const id = await createDraft(request, `Activity ${Date.now()}`);
  const update = await api(request, 'PUT', `${MGMT}/entries/${id}`, {
    fields: { title: { 'en-US': `Activity again ${Date.now()}` } },
  });
  expect(update.ok(), await update.text()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCms(page, `/content/article/${id}`);
  const pane = page.getByRole('complementary', { name: 'Side pane' });
  await pane.getByRole('radio', { name: 'Activity' }).click();
  const list = pane.getByRole('list', { name: 'Activity, newest first' });
  // The save, newest, then the create: both rows that name this entry, and nothing else.
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').first()).toContainText('Saved');
  await expect(list.getByRole('listitem').first()).toContainText('Title');
  await expect(list.getByRole('listitem').last()).toContainText('Created');
  // A save from the editor shows up beside it, without a Refresh.
  await page.getByRole('textbox', { name: /Title/ }).fill(`Activity edited ${Date.now()}`);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft updated')).toBeVisible();
  await expect(list.getByRole('listitem')).toHaveCount(3);
  // Kept per browser, as Preview is: the next entry opens on it.
  await page.reload();
  await expect(pane.getByRole('radio', { name: 'Activity' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await pane.getByRole('radio', { name: 'Details' }).click();
  await expect(list).toHaveCount(0);
});

test('the editor’s side pane sits beside the form, resizes, and previews the draft as typed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await newArticle(page);
  // A new entry's pane is its preview alone.
  const preview = page.getByRole('article', { name: 'Preview' });
  await expect(preview.getByRole('heading', { name: 'Untitled' })).toBeVisible();
  const title = `Pane ${Date.now()}`;
  await page.getByRole('textbox', { name: /Title/ }).fill(title);
  await expect(preview.getByRole('heading', { name: title })).toBeVisible();

  // Beside the form behind a splitter, which the keyboard moves.
  const divider = page.getByRole('separator', { name: 'Resize the side pane' });
  const before = Number(await divider.getAttribute('aria-valuenow'));
  await divider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', String(before + 2));
  await page.keyboard.press('Enter');
  await expect(divider).toHaveAttribute('aria-valuenow', String(before));

  // Saved, the pane switches between the entry's panels and the preview.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();
  const pane = page.getByRole('complementary', { name: 'Side pane' });
  await pane.getByRole('radio', { name: 'Preview' }).click();
  await expect(preview.getByRole('heading', { name: title })).toBeVisible();
  await pane.getByRole('radio', { name: 'Details' }).click();
  await expect(preview).toHaveCount(0);
});

test('typing right after creating an entry lands in the created entry, never a form being replaced', async ({
  page,
}) => {
  await newArticle(page);
  // Hold the swap from /new to the created entry's URL open, as a slow runner does: the new route's
  // module arrives late.
  await page.route('**/*content-entry*', async (route) => {
    await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  const title = `Swap ${Date.now()}`;
  const box = page.getByRole('textbox', { name: /Title/ });
  await box.fill(title);
  await page.getByRole('button', { name: 'Save draft' }).click();
  // The new form is gone while it is replaced, so this waits for the created entry's editor.
  await box.fill(`${title} v2`, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/content\/article\/(?!new)[^/]+$/);
  await expect(box).toHaveValue(`${title} v2`);
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Draft updated')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: `${title} v2` })).toBeVisible();
});

test('the asset library searches: a match by name, facet chips, and back to the library on clear', async ({
  page,
  request,
}) => {
  // Waits on ingest, which a cold engine takes a while to start.
  test.setTimeout(120_000);
  const stamp = Date.now();
  // In a folder of their own, as the ingest specs' assets are: specs upload side by side during
  // the ingest wait below, and the library's first page (the latest 50) can't be counted on to
  // hold this spec's assets; the folder's can.
  const folder = `Search ${stamp}`;
  const folderId = await seedAssetFolder(request, folder);
  // Shares no word with the search below (its stamp in base 36), so neither leg can match it.
  const other = `Ordinary ${stamp.toString(36)}`;
  await seedAsset(request, other, { folderId });

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: folder, exact: true })
    .click();
  await expect(page.getByRole('button', { name: `Upload to “${folder}”` })).toBeVisible();
  await expect(library.getByRole('button', { name: `Open “${other}”` })).toBeVisible();

  // Uploaded into the folder through the signed PUT, which hands the file to ingest; ingest
  // indexes it.
  const wanted = `heliotrope-${stamp}.txt`;
  await page
    .getByLabel('Upload asset files')
    .setInputFiles([
      { name: wanted, mimeType: 'text/plain', buffer: Buffer.from('a heliotrope field guide') },
    ]);
  const uploads = page.getByRole('region', { name: 'Uploads' });
  await expect(uploads.getByRole('status')).toHaveText('Uploaded 1 file', { timeout: 30_000 });

  const box = library.getByRole('searchbox', { name: 'Search assets' });
  const query = `heliotrope ${stamp}`;
  // Ingest runs on the engine after the upload: search again until the index has caught up. The
  // summary names the query, so the library shown before the debounced search can't pass.
  await expect(async () => {
    await box.fill('');
    await box.fill(query);
    await expect(library.getByText(new RegExp(`match(es)? for “${query}”`))).toBeVisible({
      timeout: 3_000,
    });
    await expect(library.getByRole('button', { name: `Open “${wanted}”` })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 90_000 });
  await expect(library.getByRole('button', { name: `Open “${other}”` })).toHaveCount(0);
  const kinds = library.getByRole('group', { name: 'Kind' });
  await expect(kinds.getByRole('button', { name: /^Documents \d+ match/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await library.getByRole('button', { name: 'Clear search' }).click();
  // Back to the folder's own list: no facets, no search summary, and both of its assets, the one
  // the search left out among them.
  await expect(library.getByRole('group', { name: 'Kind' })).toHaveCount(0);
  await expect(library.getByRole('searchbox', { name: 'Search assets' })).toHaveValue('');
  await expect(library.getByText(/ for “/)).toHaveCount(0);
  await expect(library.getByRole('button', { name: `Open “${other}”` })).toBeVisible();
  await expect(library.getByRole('button', { name: `Open “${wanted}”` })).toBeVisible();
});

test('the asset library: a folder, uploads into it, a move, a bulk archive, a restore and a guarded delete', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const seeded = [`Seed ${stamp} 1`, `Seed ${stamp} 2`];
  for (const title of seeded) await seedAsset(request, title);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await expect(library.getByRole('button', { name: `Open “${seeded[0]}”` })).toBeVisible();

  // A folder, created in the tree: it opens, and takes focus.
  const folderName = `Folder ${stamp}`;
  const folders = page.getByRole('navigation', { name: 'Folders' });
  await folders.getByRole('button', { name: 'New folder' }).click();
  await folders.getByRole('textbox', { name: 'New folder name' }).fill(folderName);
  await folders.getByRole('button', { name: 'Create folder' }).click();
  await expect(folders.getByRole('button', { name: folderName, exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: `Upload to “${folderName}”` })).toBeVisible();

  // Several files uploaded into it; the queue says how the batch went.
  const files = [1, 2, 3].map((n) => ({
    name: `upload-${stamp}-${n}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from(`file ${n}`),
  }));
  await page.getByLabel('Upload asset files').setInputFiles(files);
  const uploads = page.getByRole('region', { name: 'Uploads' });
  await expect(uploads.getByRole('status')).toHaveText('Uploaded 3 files', { timeout: 30_000 });
  for (const f of files) {
    await expect(library.getByRole('button', { name: `Open “${f.name}”` })).toBeVisible();
  }

  // The seeded assets, selected from everything and moved into the folder.
  await folders.getByRole('button', { name: 'All assets' }).click();
  for (const title of seeded) {
    await library.getByRole('checkbox', { name: `Select “${title}”` }).check();
  }
  const bar = page.getByRole('group', { name: 'Selected assets' });
  await expect(bar.getByText('2 selected')).toBeVisible();
  await bar.getByRole('combobox', { name: 'Move to folder' }).selectOption({ label: folderName });
  await bar.getByRole('button', { name: 'Move selected' }).click();
  await expect(page.getByText(`Moved 2 assets to “${folderName}”`)).toBeVisible();

  // In the folder: all five, archived together after an in-place confirm.
  await folders.getByRole('button', { name: folderName, exact: true }).click();
  await library.getByRole('radio', { name: 'List' }).click();
  await expect(library.getByRole('row')).toHaveCount(6); // the header and five assets
  await library.getByRole('checkbox', { name: 'Select all shown' }).check();
  await expect(bar.getByText('5 selected')).toBeVisible();
  await bar.getByRole('button', { name: 'Archive selected' }).click();
  await bar
    .getByRole('alertdialog', { name: /Archive 5 assets\?/ })
    .getByRole('button', { name: 'Archive 5 assets' })
    .click();
  await expect(page.getByText('Archived 5 assets')).toBeVisible();
  await expect(library.getByText('Nothing here')).toBeVisible();

  // One restored, from the archived filter: it comes back as a draft.
  await library.getByRole('combobox', { name: 'Status' }).selectOption('archived');
  await library.getByRole('button', { name: `Restore “${seeded[0]}”` }).click();
  await expect(page.getByText(`Restored “${seeded[0]}” as a draft`)).toBeVisible();
  await library.getByRole('combobox', { name: 'Status' }).selectOption('draft');
  await expect(library.getByRole('button', { name: `Open “${seeded[0]}”` })).toBeVisible();
});

test('deleting an asset an entry uses names that entry and links to it', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const assetTitle = `Hero ${stamp}`;
  // In a folder of its own: seeded assets from a spec beside this one can't push it off the page,
  // and an asset with no bytes isn't in the search index to be found by name.
  const folderId = await seedAssetFolder(request, assetTitle);
  const assetId = await seedAsset(request, assetTitle, { publish: true, folderId });
  const entryTitle = `Uses hero ${stamp}`;
  const created = await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: 'article',
    fields: {
      title: { 'en-US': entryTitle },
      content: {
        'en-US': {
          nodeType: 'document',
          data: {},
          content: [
            {
              nodeType: 'embedded-asset-block',
              data: { target: { id: assetId, linkType: 'Asset' } },
              content: [],
            },
          ],
        },
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { entry } = (await created.json()) as { entry: { id: string } };
  const published = await api(request, 'POST', `${MGMT}/entries/${entry.id}/published`);
  expect(published.ok(), await published.text()).toBe(true);

  await openCms(page, '/assets');
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: assetTitle, exact: true })
    .click();
  const library = page.getByRole('region', { name: 'Asset library' });
  await library.getByRole('button', { name: `Archive “${assetTitle}”` }).click();
  await library.getByRole('combobox', { name: 'Status' }).selectOption('archived');
  await library.getByRole('button', { name: `Delete “${assetTitle}”` }).click();
  // A modal, portalled out of the library: it can't be undone and its files go too.
  const ask = page.getByRole('alertdialog', { name: new RegExp(`Delete “${assetTitle}”`) });
  await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await ask.getByRole('button', { name: 'Delete asset' }).click();

  const notice = library
    .getByRole('alert')
    .filter({ hasText: `“${assetTitle}” is used by 1 entry` });
  await expect(notice).toBeVisible();
  await expect(notice).toBeFocused();
  const link = notice.getByRole('link', { name: entryTitle });
  await expect(link).toHaveAttribute('href', `/content/article/${entry.id}`);
  // Still there: the delete was refused.
  await expect(library.getByRole('button', { name: `Open “${assetTitle}”` })).toBeVisible();
});

test('a changed entry’s card says what goes live, and declining keeps focus in the panel', async ({
  page,
  request,
}) => {
  const title = `Carded ${Date.now()}`;
  const id = await createChanged(request, title);
  await openCms(page, '/content/article');
  await page
    .getByRole('row', { name: new RegExp(title) })
    .getByRole('button', { name: `Publish “${title}”` })
    .click();

  const card = page
    .getByRole('complementary', { name: 'Coworker' })
    .getByRole('region', { name: 'Publish this entry' })
    .filter({ hasText: title });
  await expect(card.getByText('1 field goes live:')).toBeVisible();
  await expect(card.getByRole('list', { name: 'Changed fields' })).toContainText('Body');
  await expect(card.getByRole('button', { name: 'Not now' })).toBeFocused();

  await card.getByRole('button', { name: 'Review changes' }).click();
  await expect(card.getByText('Live body')).toBeVisible();
  await expect(card.getByText('Edited body')).toBeVisible();

  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByText(`Not published · ${title}`).last()).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  expect(await statusOf(request, id)).toBe('changed');
});

test.describe('publishing from a row, without the assistant', () => {
  test.beforeEach(async ({ page }) => {
    await withoutAssistant(page);
  });

  test('a changed entry confirms what goes live; Keep live version publishes nothing, Publish entry publishes', async ({
    page,
    request,
  }) => {
    const title = `Revised ${Date.now()}`;
    const id = await createChanged(request, title);
    await openCms(page, '/content/article');
    const row = page.getByRole('row', { name: new RegExp(title) });
    await expect(row.getByText('Changed', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: `Publish “${title}”` }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading', { name: `Publish “${title}”?` })).toBeVisible();
    // Only the body differs from what's live: it is listed as changed, the title is not.
    await expect(dialog.getByText('1 field changed')).toBeVisible();
    const changed = dialog.getByRole('list', { name: 'Changes' }).getByRole('listitem');
    await expect(changed).toHaveCount(1);
    await expect(changed.getByText('Body', { exact: true })).toBeVisible();
    await expect(changed.getByText('Live body')).toBeVisible();
    await expect(changed.getByText('Edited body')).toBeVisible();
    await expect(dialog.getByText(title, { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: /^Show \d+ unchanged field/ }).click();
    await expect(
      dialog.getByRole('list', { name: 'Unchanged fields' }).getByText(title),
    ).toBeVisible();

    await dialog.getByRole('button', { name: 'Keep live version' }).click();
    await expect(dialog).toBeHidden();
    expect(await statusOf(request, id)).toBe('changed');
    await expect(row.getByRole('button', { name: `Publish “${title}”` })).toBeVisible();

    await row.getByRole('button', { name: `Publish “${title}”` }).click();
    await dialog.getByRole('button', { name: 'Publish entry' }).click();
    await expect(page.getByText(`“${title}” published`)).toBeVisible();
    await expect(row.getByRole('button', { name: `Publish “${title}”` })).toHaveCount(0);
    expect(await statusOf(request, id)).toBe('published');
  });

  test('at phone width the value going live sits inside the dialog, however long', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    const title = `Narrow ${Date.now()}`;
    const id = await createChanged(request, title);
    const long = `https://example.com/${'unbroken-'.repeat(30)}`;
    const edited = await api(request, 'PUT', `${MGMT}/entries/${id}`, {
      fields: { title: { 'en-US': title }, body: { 'en-US': long } },
    });
    expect(edited.ok(), await edited.text()).toBe(true);
    await openCms(page, '/content/article');
    await page.getByRole('link', { name: title }).focus();
    await page.getByRole('button', { name: `Publish “${title}”` }).click();

    const dialog = page.getByRole('alertdialog');
    const region = dialog.getByRole('region', { name: 'What changes' });
    const value = region.getByText(long);
    await expect(value).toBeVisible();
    const box = (await value.boundingBox()) ?? { x: 0, width: Number.POSITIVE_INFINITY };
    const bounds = (await region.boundingBox()) ?? { x: 0, width: 0 };
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(await region.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    // A keyboard reaches the scroller, and leaves the safe choice as where it starts.
    await expect(dialog.getByRole('button', { name: 'Keep live version' })).toBeFocused();
    expect(await region.getAttribute('tabindex')).toBe('0');
  });

  test('a draft confirms before it goes live, and Keep as draft leaves it one', async ({
    page,
    request,
  }) => {
    const title = `Fresh ${Date.now()}`;
    const id = await createDraft(request, title);
    await openCms(page, '/content/article');
    const row = page.getByRole('row', { name: new RegExp(title) });
    const publish = row.getByRole('button', { name: `Publish “${title}”` });

    await publish.click();
    const dialog = page.getByRole('alertdialog', { name: `Publish “${title}”?` });
    await expect(dialog.getByRole('button', { name: 'Keep as draft' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Keep as draft' }).click();
    await expect(dialog).toBeHidden();
    await expect(publish).toBeFocused();
    expect(await statusOf(request, id)).toBe('draft');

    await publish.click();
    await dialog.getByRole('button', { name: 'Publish entry' }).click();
    await expect(page.getByText(`“${title}” published`)).toBeVisible();
    // Readers and webhooks have it now, so there is no Undo to offer.
    await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    expect(await statusOf(request, id)).toBe('published');
    // The row's Publish has gone: its title keeps the keyboard on the row.
    await expect(row.getByRole('link', { name: title })).toBeFocused();
  });
});

test('the asset library shows what ingest found: a duplicate opens its original, and a failed ingest retries', async ({
  page,
  request,
}) => {
  // Waits for ingest to find the twin and to give up on the missing file (after its retries).
  test.setTimeout(240_000);
  const stamp = Date.now();
  const { original, copy, broken, folder } = await seedIngestFindings(request, stamp);

  await openCms(page, '/assets');
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: folder, exact: true })
    .click();
  const library = page.getByRole('region', { name: 'Asset library' });
  const duplicateBadge = `Possible duplicate: open the asset “${copy}” duplicates`;

  // From the grid: the badge opens the original's sheet.
  await library.getByRole('button', { name: duplicateBadge }).click();
  let sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: original })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // From the copy's sheet with an edit in it: asked in place first, then the original.
  await library.getByRole('button', { name: `Open “${copy}”` }).click();
  sheet = page.getByRole('dialog');
  await sheet.getByLabel('Alt text (en-US)').fill('Not saved yet');
  await sheet.getByRole('button', { name: duplicateBadge }).click();
  const ask = sheet.getByRole('alertdialog', {
    name: 'Open the original and discard your changes?',
  });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  await expect(sheet.getByLabel('Alt text (en-US)')).toHaveValue('Not saved yet');
  await sheet.getByRole('button', { name: duplicateBadge }).click();
  await sheet.getByRole('button', { name: 'Discard and open' }).click();
  await expect(sheet.getByRole('heading', { name: original })).toBeVisible();
  await page.keyboard.press('Escape');

  // The failure's reason is on the card, in sight; Retry sends the asset through ingest again.
  await expect(library.getByText('The file is not in storage').first()).toBeVisible();
  await library.getByRole('button', { name: `Retry processing “${broken}”` }).click();
  await expect(page.getByText(`Processing “${broken}” again`)).toBeVisible();
  await expect(library.getByRole('button', { name: `Retry processing “${broken}”` })).toHaveCount(
    0,
  );
});

test('an asset’s file is replaced, republished and restored from its Versions tab', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const name = `versions-${stamp}.txt`;
  const id = await uploadAssetBytes(request, name, Buffer.from(`first ${stamp}`));
  const pub = await api(request, 'POST', `${MGMT}/assets/${id}/published`);
  expect(pub.ok(), await pub.text()).toBe(true);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await library.getByRole('button', { name: `Open “${name}”` }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('tab', { name: 'Versions' }).click();
  const versions = sheet.getByRole('list', { name: 'File versions' });
  await expect(versions.getByRole('listitem')).toHaveCount(1);

  // Replace: the signed PUT, then the commit; the new file is v2 and current.
  const next = `versions-${stamp}-new.txt`;
  await sheet.getByLabel('Replacement file').setInputFiles({
    name: next,
    mimeType: 'text/plain',
    buffer: Buffer.from(`second ${stamp}`),
  });
  await expect(page.getByText(`Replaced the file with “${next}” (version 2)`)).toBeVisible();
  await expect(versions.getByRole('listitem')).toHaveCount(2);
  const top = versions.getByRole('listitem').first();
  await expect(top.getByText('v2', { exact: true })).toBeVisible();
  await expect(top.getByText(next)).toBeVisible();
  await expect(top.getByText('Current')).toBeVisible();

  // Delivery keeps v1 until the asset is published again.
  await expect(sheet.getByText('Delivery serves version 1')).toBeVisible();
  await sheet.getByRole('button', { name: 'Publish v2' }).click();
  await expect(sheet.getByText('Delivery serves version 1')).toHaveCount(0);
  await expect(top.getByText('Published')).toBeVisible();

  // Restore v1: asked in place, then its file is current again as v3.
  await sheet.getByRole('button', { name: 'Restore version 1' }).click();
  await sheet
    .getByRole('alertdialog', { name: /Restore version 1\?/ })
    .getByRole('button', { name: 'Restore v1' })
    .click();
  await expect(page.getByText('Restored version 1 as version 3')).toBeVisible();
  await expect(versions.getByRole('listitem')).toHaveCount(3);
  const restored = versions.getByRole('listitem').first();
  await expect(restored.getByText('v3', { exact: true })).toBeVisible();
  await expect(restored.getByText('Restored from v1')).toBeVisible();
  await expect(restored.getByText(name)).toBeVisible();
});

test('publishing more assets than a page shows runs as a job and names the one it refused', async ({
  page,
  request,
}) => {
  // 51 assets seeded, then a job the engine works through in batches.
  test.setTimeout(180_000);
  const stamp = Date.now();
  const folderName = `Bulk ${stamp}`;
  const folderId = await seedAssetFolder(request, folderName);
  const titles = Array.from(
    { length: 51 },
    (_, i) => `Bulk ${stamp} ${String(i + 1).padStart(2, '0')}`,
  );
  const ids: string[] = [];
  for (let i = 0; i < titles.length; i += 10) {
    ids.push(
      ...(await Promise.all(
        titles.slice(i, i + 10).map((title) => seedAsset(request, title, { folderId })),
      )),
    );
  }
  // One under embargo: the job refuses it, and says which.
  const embargoed = titles[6] as string;
  const rights = await api(request, 'PUT', `${MGMT}/assets/${ids[6]}/rights`, {
    embargoUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  expect(rights.ok(), await rights.text()).toBe(true);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: folderName, exact: true })
    .click();
  await library.getByRole('radio', { name: 'List' }).click();
  await expect(library.getByRole('row')).toHaveCount(51); // the header and the first page of 50
  await expect(library.getByText('Embargoed')).toBeVisible();
  await library.getByRole('button', { name: 'Load more' }).click();
  await expect(library.getByRole('row')).toHaveCount(52);
  await library.getByRole('checkbox', { name: 'Select all shown' }).check();
  const bar = page.getByRole('group', { name: 'Selected assets' });
  await expect(bar.getByText('51 selected')).toBeVisible();

  await bar.getByRole('button', { name: 'Publish selected', exact: true }).click();
  const job = page.getByRole('region', { name: 'Bulk job' });
  await expect(job.getByRole('progressbar', { name: 'Bulk job progress' })).toBeVisible();
  await expect(job.getByRole('status')).toHaveText('Published 50 of 51 assets; 1 failed', {
    timeout: 120_000,
  });
  await expect(job.getByText('Finished with failures')).toBeVisible();
  // The job card, finished, passes the same WCAG sweep as the rest of the admin.
  const axe = await new AxeBuilder({ page })
    .include('section[aria-label="Bulk job"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual(
    [],
  );
  const failures = page.getByRole('alert').filter({ hasText: '1 asset not published' });
  await expect(failures.getByText(embargoed, { exact: true })).toBeVisible();
  await expect(failures.getByText(/under embargo/)).toBeVisible();
  await expect(bar.getByText('1 selected')).toBeVisible();
  await expect(library.getByRole('checkbox', { name: `Select “${embargoed}”` })).toBeChecked();
});

/** Uploads a small text file through the signed PUT, publishes it, and returns its id. */
async function publishedFile(request: Parameters<typeof uploadAssetBytes>[0], name: string) {
  const id = await uploadAssetBytes(request, name, Buffer.from(`bytes of ${name}`));
  const pub = await api(request, 'POST', `${MGMT}/assets/${id}/published`);
  expect(pub.ok(), await pub.text()).toBe(true);
  return id;
}

test('an asset collection: made beside the folders, filled from the library, reordered, shared and zipped', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const files = ['a', 'b', 'c'].map((n) => `coll-${stamp}-${n}.txt`);
  for (const name of files) await publishedFile(request, name);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await library.getByRole('radio', { name: 'List' }).click();
  await expect(library.getByRole('button', { name: `Open “${files[0]}”` })).toBeVisible();

  // Made in the sidebar, under the folders: it opens in place of the library, heading focused.
  const name = `Launch ${stamp}`;
  const nav = page.getByRole('navigation', { name: 'Collections' });
  await nav.getByRole('button', { name: 'New collection' }).click();
  const form = nav.getByRole('form', { name: 'New collection' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel(/Description/).fill('Spring launch');
  await form.getByRole('button', { name: 'Create collection' }).click();
  const heading = page.getByRole('heading', { name, exact: true });
  await expect(heading).toBeFocused();
  await expect(page.getByText('Nothing in this collection yet')).toBeVisible();

  // Filled from the library's selection, through the bulk bar.
  await page
    .getByRole('navigation', { name: 'Folders' })
    .getByRole('button', { name: 'All assets' })
    .click();
  for (const f of files) {
    await library.getByRole('checkbox', { name: `Select “${f}”` }).check();
  }
  const bar = page.getByRole('group', { name: 'Selected assets' });
  await bar.getByRole('combobox', { name: 'Collection to add to' }).selectOption({ label: name });
  await bar.getByRole('button', { name: 'Add to collection' }).click();
  await expect(page.getByText(`Added 3 assets to “${name}”`)).toBeVisible();

  // Its assets in order; c moved up with the keyboard's buttons keeps focus, and is said.
  await nav.getByRole('button', { name: `${name}, 3 assets` }).click();
  const list = page.getByRole('list', { name: `Assets in “${name}”, in order` });
  const order = () => list.getByRole('button', { name: /^Open/ }).allTextContents();
  await expect.poll(order).toEqual(files);
  const up = list.getByRole('button', { name: `Move “${files[2]}” up` });
  await up.focus();
  await page.keyboard.press('Enter');
  await expect.poll(order).toEqual([files[0], files[2], files[1]]);
  await expect(list.getByRole('button', { name: `Move “${files[2]}” up` })).toBeFocused();
  await expect(page.getByText(`“${files[2]}” moved to position 2 of 3`)).toBeAttached();

  // Dragged: the first row onto the last.
  const rows = list.getByRole('listitem');
  await rows.nth(0).dragTo(rows.nth(2));
  await expect.poll(order).toEqual([files[2], files[1], files[0]]);
  // The order is the server's now, not just the screen's.
  const collections = (await (await api(request, 'GET', `${MGMT}/asset-collections`)).json()) as {
    items: { id: string; name: string }[];
  };
  const id = collections.items.find((c) => c.name === name)?.id as string;
  await expect
    .poll(async () => {
      const page = (await (
        await api(request, 'GET', `${MGMT}/asset-collections/${id}/assets`)
      ).json()) as { items: { title: Record<string, string> }[] };
      return page.items.map((a) => a.title['en-US']);
    })
    .toEqual([files[2], files[1], files[0]]);

  // Shared: a link for a day, without downloads; listed, then revoked in place.
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Share “${name}”` });
  await expect(dialog.getByText(/drafts in the collection stay off the page/)).toBeVisible();
  const share = dialog.getByRole('form', { name: 'New share link' });
  await share.getByRole('radio', { name: '1 day' }).click();
  await share.getByRole('switch', { name: 'Allow downloads' }).click();
  await share.getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByText('Share link created')).toBeVisible();
  const active = dialog.getByRole('list', { name: 'Active links' });
  await expect(active.getByRole('listitem')).toHaveCount(1);
  await expect(active.getByText('View only')).toBeVisible();
  await active.getByRole('button', { name: /Revoke the link/ }).click();
  await page
    .getByRole('alertdialog', { name: /Revoke this link\?/ })
    .getByRole('button', { name: 'Revoke link' })
    .click();
  await expect(dialog.getByText('No link opens it now.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Zipped: the job is created and followed; the engine's Workflow builds it on the local stack.
  await page.getByRole('button', { name: 'Download as zip' }).click();
  const zip = page.getByRole('region', { name: 'Zip download' });
  await expect(zip.getByRole('status')).toContainText(`${name}.zip`);
  await expect(zip.getByRole('progressbar', { name: 'Zip progress' })).toBeAttached();
  await expect(zip.getByRole('link', { name: `Download “${name}.zip”` })).toBeVisible({
    timeout: 60_000,
  });
  await expect(zip.getByRole('status')).toContainText(`“${name}.zip” is ready: 3 files`);

  // One taken out (it stays in the library), then the collection deleted after asking.
  await list.getByRole('button', { name: `Remove “${files[1]}” from “${name}”` }).click();
  await expect(page.getByText(`Removed “${files[1]}” from “${name}”`)).toBeVisible();
  await expect.poll(order).toEqual([files[2], files[0]]);
  await page.getByRole('button', { name: `Delete “${name}”` }).click();
  await page
    .getByRole('alertdialog', { name: new RegExp(`Delete “${name}”\\?`) })
    .getByRole('button', { name: 'Delete collection' })
    .click();
  await expect(page.getByText(`Deleted collection “${name}”`)).toBeVisible();
  await expect(library.getByRole('button', { name: `Open “${files[1]}”` })).toBeVisible();
});

test('an asset is shared from its sheet once it is published', async ({ page, request }) => {
  const stamp = Date.now();
  const draft = `share-draft-${stamp}.txt`;
  // Bytes of its own: a file another spec uploaded would be flagged a possible duplicate.
  await uploadAssetBytes(request, draft, Buffer.from(`draft ${stamp}`));
  const live = `share-live-${stamp}.txt`;
  await publishedFile(request, live);

  await openCms(page, '/assets');
  const library = page.getByRole('region', { name: 'Asset library' });
  await library.getByRole('button', { name: `Open “${draft}”` }).click();
  const sheet = page.getByRole('dialog', { name: draft });
  const share = sheet.getByRole('button', { name: 'Share', exact: true });
  await share.click();
  const dialog = page.getByRole('dialog', { name: `Share “${draft}”` });
  await expect(dialog.getByText('Publish it to share it')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create link' })).toHaveCount(0);
  // Closing hands focus back to Share, in the sheet.
  await page.keyboard.press('Escape');
  await expect(share).toBeFocused();
  await page.keyboard.press('Escape');

  await library.getByRole('button', { name: `Open “${live}”` }).click();
  await page
    .getByRole('dialog', { name: live })
    .getByRole('button', { name: 'Share', exact: true })
    .click();
  const liveDialog = page.getByRole('dialog', { name: `Share “${live}”` });
  await liveDialog.getByRole('button', { name: 'Create link' }).click();
  await expect(
    liveDialog.getByRole('list', { name: 'Active links' }).getByRole('listitem'),
  ).toHaveCount(1);
});

test('a file past 100 MiB goes up in parts, with its bytes and parts as progress', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const name = `big-${Date.now()}.bin`;
  // 101 MiB: one past what a single signed PUT takes, so 13 parts of 8 MiB.
  const path = testInfo.outputPath(name);
  await writeFile(path, Buffer.alloc(101 * 1024 * 1024, 7));

  await openCms(page, '/assets');
  await page.getByLabel('Upload asset files').setInputFiles(path);
  const uploads = page.getByRole('region', { name: 'Uploads' });
  await expect(uploads.getByRole('progressbar', { name: `Uploading “${name}”` })).toBeVisible();
  await expect(uploads.getByText(/ of 101 MB · \d+ of 13 parts/)).toBeVisible();
  await expect(uploads.getByRole('status')).toHaveText('Uploaded 1 file', { timeout: 150_000 });
  const library = page.getByRole('region', { name: 'Asset library' });
  await expect(library.getByRole('button', { name: `Open “${name}”` })).toBeVisible();
});

// A phone: the collections are a select, the row's actions sit on a line of their own, and a
// finger's 44px targets for Move up, Move down and Remove don't overlap.
test.describe('on a phone', () => {
  test.use({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });

  test('a collection is opened, reordered with its buttons and shared', async ({
    page,
    request,
  }) => {
    const stamp = Date.now();
    const files = ['a', 'b'].map((n) => `phone-${stamp}-${n}.txt`);
    const ids = [];
    for (const name of files) ids.push(await publishedFile(request, name));
    const name = `Phone ${stamp}`;
    const made = await api(request, 'POST', `${MGMT}/asset-collections`, { name });
    expect(made.ok(), await made.text()).toBe(true);
    const { id } = (await made.json()) as { id: string };
    const added = await api(request, 'POST', `${MGMT}/asset-collections/${id}/assets`, {
      assetIds: ids,
    });
    expect(added.ok(), await added.text()).toBe(true);

    await openCms(page, '/assets');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await page
      .getByRole('navigation', { name: 'Collections' })
      .getByRole('combobox', { name: 'Collection' })
      .selectOption({ label: name });
    const list = page.getByRole('list', { name: `Assets in “${name}”, in order` });
    const order = () => list.getByRole('button', { name: /^Open/ }).allTextContents();
    await expect.poll(order).toEqual(files);

    // The three targets of a row, centre to centre, at least a finger's 44px apart.
    const centres = await Promise.all(
      [
        `Move “${files[1]}” up`,
        `Move “${files[1]}” down`,
        `Remove “${files[1]}” from “${name}”`,
      ].map(async (label) => {
        const box = await list.getByRole('button', { name: label }).boundingBox();
        return (box?.x ?? 0) + (box?.width ?? 0) / 2;
      }),
    );
    expect(centres[1]! - centres[0]!).toBeGreaterThanOrEqual(44);
    expect(centres[2]! - centres[1]!).toBeGreaterThanOrEqual(44);

    await list.getByRole('button', { name: `Move “${files[1]}” up` }).tap();
    await expect.poll(order).toEqual([files[1], files[0]]);

    await page.getByRole('button', { name: 'Share', exact: true }).tap();
    const dialog = page.getByRole('dialog', { name: `Share “${name}”` });
    await expect(dialog.getByRole('form', { name: 'New share link' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create link' })).toBeInViewport();
  });
});

test('a role’s content access: withhold unpublish, save, and read it back', async ({
  page,
  request,
}) => {
  const name = `Keeps live ${Date.now()}`;
  const created = await api(request, 'POST', `/spaces/${SPACE}/roles`, {
    name,
    scopes: ['content:write', 'content:publish', 'preview:read'],
    contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write', 'publish'] }],
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  await openCms(page, '/settings/roles');
  await page.getByRole('button', { name: `Content access for ${name}` }).click();
  const sheet = page.getByRole('dialog');
  const save = sheet.getByRole('button', { name: 'Save access' });
  await expect(save).toBeDisabled();
  await sheet.getByRole('checkbox', { name: 'Unpublish Every type' }).click();
  await save.click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText(`Saved content access for ${name}`)).toBeVisible();

  // Stored as a withhold, with the rest of the role untouched.
  const role = (await (await api(request, 'GET', `/spaces/${SPACE}/roles/${id}`)).json()) as {
    name: string;
    scopes: string[];
    contentGrants: { actions: string[]; deniedActions?: string[] }[];
  };
  expect(role.name).toBe(name);
  expect(role.scopes).toEqual(['content:write', 'content:publish', 'preview:read']);
  expect(role.contentGrants[0]).toMatchObject({
    actions: ['read', 'write', 'publish'],
    deniedActions: ['unpublish'],
  });
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: name })
      .getByText('Every type: read, write, publish, delete'),
  ).toBeVisible();

  // Reopened, the box reads back unticked.
  await page.getByRole('button', { name: `Content access for ${name}` }).click();
  await expect(
    page.getByRole('dialog').getByRole('checkbox', { name: 'Unpublish Every type' }),
  ).not.toBeChecked();
});

test('guidance saved in the content type dialog shows on the entry form', async ({
  page,
  request,
}) => {
  await seedGuidedType(request);
  await openCms(page, '/content');
  await page.getByRole('button', { name: 'Edit “Guided”' }).click();
  await page.getByRole('button', { name: 'Guidance for Subtitle' }).click();
  await page.getByLabel('Help text for Subtitle').fill('One line under the title.');
  await page.getByLabel('Placeholder for Subtitle').fill('Close to the park');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  await openCms(page, '/content/guided/new');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible(EDITOR_READY);
  const subtitle = page.getByLabel('Subtitle');
  await expect(subtitle).toHaveAttribute('placeholder', 'Close to the park');
  await expect(subtitle).toHaveAccessibleDescription(/One line under the title\./);
  // Listed values are offered as a select.
  await expect(page.getByLabel('Status').getByRole('option')).toHaveText(['None', 'open', 'let']);
});

test('agent instructions saved in the content type dialog are there when it reopens', async ({
  page,
  request,
}) => {
  await seedBriefedType(request);
  await openCms(page, '/content');
  await page.getByRole('button', { name: 'Edit “Briefed”' }).click();
  await page.getByLabel('Agent instructions').fill('Keep titles short.');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  await openCms(page, '/content');
  await page.getByRole('button', { name: 'Edit “Briefed”' }).click();
  await expect(page.getByLabel('Agent instructions')).toHaveValue('Keep titles short.');
});

test('the editor names who created and last edited an entry, and Mine lists one’s own', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = `Authored ${Date.now()}`;
  // Through the same origin as the browser: the signed-in person is its author.
  const id = await createDraft(request, title);
  await openCms(page, `/content/article/${id}`);
  const pane = page.getByRole('complementary', { name: 'Side pane' });
  await pane.getByRole('radio', { name: 'Details' }).click();
  // The person reads as "You", never as their id; the creation time is a <time>.
  await expect(pane.getByText('Created by').locator('+ dd')).toContainText('You');
  await expect(pane.getByText('Created by').locator('+ dd time')).toHaveCount(1);
  await expect(pane.getByText('Last edited by').locator('+ dd')).toContainText(/^You · /);
  await expect(pane.getByText('Last edited by').locator('+ dd time')).toHaveCount(1);

  await openCms(page, '/content/article');
  const mine = page.getByRole('button', { name: 'Mine' });
  await mine.click();
  await expect(mine).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('table').getByRole('link', { name: title, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(mine).toHaveAttribute('aria-pressed', 'false');
});

test('a singleton type opens its one entry, and refuses a second', async ({ page, request }) => {
  const stamp = Date.now();
  const name = `Settings ${stamp}`;
  const apiId = `settings${stamp}`;
  await openCms(page, '/content');
  await page.getByRole('button', { name: 'New content type' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New content type' });
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('API ID', { exact: true }).fill(apiId);
  await dialog.getByRole('checkbox', { name: /one entry only/i }).check();
  await dialog.getByRole('button', { name: 'Create content type' }).click();
  await expect(dialog).toBeHidden();

  // The sidebar and the overview open the entry, not a list: a new one while there is none.
  await expect(
    page.locator(`nav[aria-labelledby="content-types-nav"] a[href="/content/${apiId}/entry"]`),
  ).toHaveCount(1);
  const row = page
    .getByRole('main')
    .getByRole('list', { name: 'Content types' })
    .getByRole('listitem')
    .filter({ hasText: name });
  await expect(row.getByText('One entry only')).toBeVisible();
  await row.getByRole('link', { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/content/${apiId}/new$`));
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible(EDITOR_READY);
  await page.getByRole('textbox', { name: /Title/ }).fill('Our site');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/content/${apiId}/[0-9a-f-]{36}$`));
  const editorUrl = page.url();

  // With its entry made, the same link opens that entry.
  await openCms(page, `/content/${apiId}/entry`);
  await expect(page).toHaveURL(editorUrl);
  await expect(page.getByRole('heading', { name: 'Our site' })).toBeVisible();

  // A second entry is refused, whoever asks.
  const second = await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: apiId,
    fields: { title: { 'en-US': 'Another' } },
  });
  expect(second.status()).toBe(409);

  // Its list, reached past the sidebar, keeps the views menu: a view of the one row saves and opens.
  await openCms(page, `/content/${apiId}`);
  const table = page.getByRole('main').getByRole('table');
  await expect(table.getByRole('link', { name: 'Our site' })).toBeVisible();
  await page.getByRole('button', { name: 'Views' }).click();
  await page.getByRole('menuitem', { name: 'Save as new view…' }).click();
  const saving = page.getByRole('dialog', { name: 'Save view' });
  await saving.getByLabel('Name', { exact: true }).fill('The one');
  await saving.getByRole('button', { name: 'Save view' }).click();
  await expect(saving).toBeHidden();
  await expect(page.getByRole('button', { name: /The one/ })).toBeVisible();
  await expect(page).toHaveURL(/[?&]view=/);
  await expect(table.getByRole('link', { name: 'Our site' })).toBeVisible();
});

test('a content type is cloned, then deleted with its entries, from its menu', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const apiId = `scratch${stamp}`;
  const made = await api(request, 'POST', `${MGMT}/content-types`, {
    apiId,
    name: `Scratch ${stamp}`,
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: false,
        position: 0,
      },
    ],
  });
  expect(made.status()).toBe(201);
  await api(request, 'POST', `${MGMT}/content-types/${apiId}/published`);

  await openCms(page, '/content');
  const focused = () =>
    page.evaluate(() => {
      const at = document.activeElement;
      return at?.getAttribute('aria-label') ?? at?.tagName ?? null;
    });
  // Closed without cloning, focus goes back to the row's menu button, not to the page.
  await page.getByRole('button', { name: `More actions for “Scratch ${stamp}”` }).click();
  await page.getByRole('menuitem', { name: 'Clone…' }).click();
  await expect(page.getByRole('dialog', { name: `Clone “Scratch ${stamp}”` })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(focused).toBe(`More actions for “Scratch ${stamp}”`);

  await page.getByRole('button', { name: `More actions for “Scratch ${stamp}”` }).click();
  await page.getByRole('menuitem', { name: 'Clone…' }).click();
  const clone = page.getByRole('dialog', { name: `Clone “Scratch ${stamp}”` });
  await clone.getByLabel('Name', { exact: true }).fill(`Copy ${stamp}`);
  await clone.getByRole('button', { name: 'Clone content type' }).click();
  await expect(page.getByText(`Cloned as “Copy ${stamp}”, a draft`)).toBeVisible();
  const copyId = `copy${stamp}`;
  expect((await api(request, 'GET', `${MGMT}/content-types/${copyId}`)).status()).toBe(200);

  // The original gets an entry; deleting it then takes the entries with it, as a job.
  await api(request, 'POST', `${MGMT}/entries`, {
    contentTypeApiId: apiId,
    fields: { title: { 'en-US': 'Doomed' } },
  });
  await page.getByRole('button', { name: `More actions for “Scratch ${stamp}”` }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const remove = page.getByRole('dialog', { name: `Delete “Scratch ${stamp}”?` });
  await remove.getByLabel(/to confirm/).fill(apiId);
  await expect(remove.getByRole('button', { name: 'Delete type and entries' })).toBeDisabled();
  await remove.getByRole('checkbox', { name: /Delete its 1 entry too/ }).check();
  await remove.getByRole('button', { name: 'Delete type and entries' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: `Deleted 1 entry of “Scratch ${stamp}”` }),
  ).toBeVisible({
    timeout: 30_000,
  });
  // The card waits for the type's own delete, recorded on the job, and says when it is done.
  await expect(
    page.getByRole('alert').filter({ hasText: `“Scratch ${stamp}” was deleted, with its entries` }),
  ).toBeVisible({ timeout: 30_000 });
  expect((await api(request, 'GET', `${MGMT}/content-types/${apiId}`)).status()).toBe(404);
  await expect(page.getByRole('link', { name: `Scratch ${stamp}`, exact: true })).toHaveCount(0);

  // The clone has no entries: deleted at once.
  await page.getByRole('button', { name: `More actions for “Copy ${stamp}”` }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const second = page.getByRole('dialog', { name: `Delete “Copy ${stamp}”?` });
  await second.getByLabel(/to confirm/).fill(copyId);
  await second.getByRole('button', { name: 'Delete content type' }).click();
  await expect(page.getByText(`Deleted “Copy ${stamp}”`)).toBeVisible();
  expect((await api(request, 'GET', `${MGMT}/content-types/${copyId}`)).status()).toBe(404);
  // Its row is gone: focus moves to the next row's menu button, or the page's heading.
  await expect.poll(focused).toMatch(/^(More actions for “(?!Copy \d+”).*”|H1)$/);
});

test('a field its rules hide appears and goes as its sibling changes, and the entry saves', async ({
  page,
  request,
}) => {
  await seedRuledType(request);
  await openCms(page, '/content/ruled/new');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible(EDITOR_READY);
  await page.getByLabel('Title').fill(`Ruled ${Date.now()}`);
  const soldTo = page.getByLabel('Sold to');
  await expect(soldTo).toHaveCount(0);
  await page.getByLabel('Status').fill('sold');
  await expect(soldTo).toBeVisible();
  // Read-only while sold, and saying why; it keeps focus, so the reason is read on it.
  const reference = page.getByLabel('Reference');
  await expect(reference).not.toBeEditable();
  await expect(reference).toHaveAttribute('aria-readonly', 'true');
  await expect(reference).toHaveAccessibleDescription('Read-only while Status is "sold"');
  await reference.focus();
  await expect(reference).toBeFocused();
  await page.getByLabel('Status').fill('open');
  await expect(soldTo).toHaveCount(0);
  // Hidden, so not required: the save goes through.
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();
});

test('a laid-out type: filed under its group, its entry form in tabs, a date field saved', async ({
  page,
  request,
}) => {
  await seedLaidOutType(request);
  await openCms(page, '/content/happening/new');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible(EDITOR_READY);
  // The content nav files it under its group (wide enough to show the nav).
  const nav = page.getByRole('navigation', { name: 'Content types' });
  if (await nav.isVisible()) {
    await expect(
      nav.getByRole('list', { name: 'Programme' }).getByRole('link', { name: 'Happening' }),
    ).toBeVisible();
  }
  await page.getByLabel('Title').fill(`Happening ${Date.now()}`);
  await page.getByRole('tab', { name: 'When' }).click();
  await expect(page.getByRole('region', { name: 'Timing' })).toBeVisible();
  await page.getByLabel('Day').fill('2026-11-03');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();
  await page.getByRole('tab', { name: 'When' }).click();
  await expect(page.getByLabel('Day')).toHaveValue('2026-11-03');
});

test('entry tabs move with the arrow keys', async ({ page, request }) => {
  await seedVenueType(request);
  await openCms(page, '/content/venue/new');
  const main = page.getByRole('tab', { name: 'Main' });
  const contact = page.getByRole('tab', { name: 'Contact' });
  await expect(main).toBeVisible(EDITOR_READY);
  await main.focus();
  await page.keyboard.press('ArrowRight');
  await expect(contact).toBeFocused();
  await expect(contact).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Booking' })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(main).toBeFocused();
  await expect(main).toHaveAttribute('aria-selected', 'true');
});

test('a rejected save opens the tab and the closed group holding the field it names', async ({
  page,
  request,
}) => {
  await seedVenueType(request);
  await openCms(page, '/content/venue/new');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible(EDITOR_READY);
  await page.getByLabel('Title').fill(`Venue ${Date.now()}`);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('tab', { name: /Contact/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel(/Booking email/)).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Field is required');
});

test('an images-only asset link offers images only', async ({ page, request }) => {
  const stamp = Date.now();
  await seedVenueType(request);
  await seedAsset(request, `Poster art ${stamp}`);
  await seedAsset(request, `Floor plan ${stamp}`, { contentType: 'application/pdf' });
  await openCms(page, '/content/venue/new');
  const picker = page.getByRole('combobox', { name: /Poster/ });
  await expect(picker).toBeVisible(EDITOR_READY);
  await picker.fill(String(stamp));
  await expect(page.getByRole('option', { name: `Poster art ${stamp}` })).toBeVisible();
  await expect(page.getByRole('option', { name: `Floor plan ${stamp}` })).toHaveCount(0);
});

test('a list of whole numbers is edited row by row, saved as numbers, beside a time of day', async ({
  page,
  request,
}) => {
  await seedShelfType(request);
  await openCms(page, '/content/shelf/new');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeVisible(EDITOR_READY);
  await page.getByLabel('Title').fill(`Shelf ${Date.now()}`);
  const add = page.getByRole('button', { name: 'Add item' });
  await add.click();
  await expect(page.getByLabel('Sizes item 1', { exact: true })).toBeFocused();
  await page.keyboard.type('12');
  await add.click();
  await expect(page.getByLabel('Sizes item 2', { exact: true })).toBeFocused();
  await page.keyboard.type('14');
  await add.click();
  await page.keyboard.type('16');
  // Removing the middle row puts focus on the one that took its place.
  await page.getByRole('button', { name: 'Remove Sizes item 2' }).click();
  await expect(page.getByLabel('Sizes item 2', { exact: true })).toBeFocused();
  await expect(page.getByLabel('Sizes item 2', { exact: true })).toHaveValue('16');
  await page.getByLabel('Opens').fill('09:30');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('Entry created')).toBeVisible();
  await expect(page.getByLabel('Sizes item 1', { exact: true })).toHaveValue('12');
  await expect(page.getByLabel('Sizes item 2', { exact: true })).toHaveValue('16');
  await expect(page.getByLabel('Opens')).toHaveValue('09:30');
});

test('a list’s search filters, clears and keeps focus, and its rows fit a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await openCms(page, '/content');
  const list = page.getByRole('list', { name: 'Content types' });
  const search = page.getByRole('searchbox', { name: 'Search content types' });
  await expect(list.getByRole('listitem').first()).toBeVisible();

  // Nothing in a row runs past it: the card clips, so the page's own width wouldn't show it.
  const spilled = await list.getByRole('listitem').evaluateAll(
    (rows) =>
      rows.filter((row) => {
        const edge = row.getBoundingClientRect().right;
        return Array.from(row.querySelectorAll('*')).some(
          (el) => el.getBoundingClientRect().right > edge + 1,
        );
      }).length,
  );
  expect(spilled).toBe(0);

  await search.fill('no-such-type');
  await expect(page.getByText(/No content types match/)).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(search).toBeFocused();
  await expect(list.getByRole('link', { name: 'Article', exact: true })).toBeVisible();

  await search.fill('article');
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('');
});
