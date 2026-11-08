import { expect, test } from '@playwright/test';
import { api, askCoworker, createBlocksPage, MGMT, openCms, seedCms, useCmsScope } from './cms';

/**
 * Coworker proposing a block patch, end to end without a model: the mock model reads "Move the
 * first block to the end" on an entry as an outline, then the move (`mockBlockMove`), and the card
 * shows it from the api's dry run of that very call before anything is saved.
 */

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }) => {
  await useCmsScope(page);
});

test('Coworker’s block move says where the block lands and the order it leaves, before Confirm', async ({
  page,
  request,
}) => {
  const title = `Everything showcase ${Date.now()}`;
  const { id, version } = await createBlocksPage(request, title);
  await openCms(page, `/content/landing/${id}`);

  const panel = await askCoworker(page, 'Move the first block to the end');
  // The conversation is shared with tests running beside this one: this entry's card only.
  const card = panel.getByRole('region', { name: 'Change blocks' }).filter({ hasText: title });
  await expect(card.getByText('Coworker suggests this')).toBeVisible();
  const steps = card.getByRole('list', { name: 'Steps' });
  await expect(steps).toHaveText(`Moves Hero “${title}” to the end of Blocks`);
  await expect(card.getByRole('button', { name: 'Confirm' })).toBeEnabled();

  await card.getByRole('button', { name: 'Review changes' }).click();
  const changes = card.getByRole('list', { name: 'Changes' });
  await expect(
    changes.getByText(`Hero “${title}” · Section “Features” · Call to action “Sign up”`),
  ).toBeVisible();
  await expect(
    changes.getByText(`Section “Features” · Call to action “Sign up” · Hero “${title}”`),
  ).toBeVisible();

  // The conversation is shared with every other test: a card left waiting would be in theirs.
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(card).toHaveCount(0);
  // Declined, nothing was saved: the draft is at the version it was created at.
  const after = await api(request, 'GET', `${MGMT}/entries/${id}`);
  const { entry } = (await after.json()) as { entry: { currentVersion: number } };
  expect(entry.currentVersion).toBe(version);
});
