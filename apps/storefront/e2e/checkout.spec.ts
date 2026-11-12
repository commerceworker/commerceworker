import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import {
  CHECKOUT_ID,
  CHECKOUT_SECRET,
  CLAIMED_ID,
  ENDED_ID,
  PLACED_ID,
  PLACED_ORDER,
} from './checkout-seed';

/**
 * The hosted checkout page on each device: a checkout the global setup put in the database
 * (e2e/checkout-seed.ts) with two lines, shipping options, a store to collect from and a code
 * that applied and one that didn't. What a thumb and iOS need: the page no wider than the screen,
 * every control 44px tall, every field 16px, the safe areas padded, and nothing cached or framed.
 */

test.beforeEach(async ({ context, baseURL }) => {
  // As the start link sets it over plain http, which is local development only: deployed over
  // https it is `__Host-cw_chk_<id>` and Secure (tests/hosted-checkout.test.ts holds both).
  await context.addCookies(
    [CHECKOUT_ID, ENDED_ID, CLAIMED_ID, PLACED_ID].map((id) => ({
      name: `cw_chk_${id}`,
      value: CHECKOUT_SECRET,
      url: baseURL!,
    })),
  );
});

const open = async (page: Page, id = CHECKOUT_ID) => {
  const res = await page.goto(`/checkout/${id}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
  return res!;
};

/** The page is no wider than the screen. */
async function fits(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
}

test('shows every section from the buyer’s view, and fits the screen', async ({ page }) => {
  await open(page);
  for (const heading of ['Contact', 'Delivery', 'Promo code', 'Your order'])
    await expect(page.getByRole('heading', { name: heading, level: 2 })).toBeVisible();
  // Contact, the ship-to, the quote's shipping options and a store to collect from.
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('Address', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Ground/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /Two-day air/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Pick it up in a store' })).toBeVisible();
  // The codes: one applied, one refused with why.
  await expect(page.getByText('Applied: 10% off')).toBeVisible();
  await expect(page.getByText('Not applied: That code does not exist.')).toBeVisible();
  // The total as the quote has it.
  const summary = page.getByRole('complementary', { name: 'Order summary' });
  for (const row of ['Subtotal', '10% off', 'Shipping', 'Tax', 'Total'])
    await expect(summary.getByText(row, { exact: false }).first()).toBeVisible();
  await expect(summary.getByText('$436.90')).toBeVisible();
  // Test mode places an order without a card.
  await expect(page.getByRole('button', { name: 'Place order (test mode)' })).toBeVisible();
  await fits(page);
});

test('every control is 44px tall and every field is 16px', async ({ page }) => {
  await open(page);
  const small: string[] = [];
  const controls = page.locator(
    'main input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), main button:not([aria-hidden="true"]), main label:has(input[type="radio"])',
  );
  for (const el of await controls.all()) {
    if (!(await el.isVisible())) continue;
    const box = await el.boundingBox();
    if (box && box.height < 43.5)
      small.push(`${await el.evaluate((n) => n.outerHTML.slice(0, 80))}: ${box.height}`);
  }
  expect(small, 'controls shorter than 44px').toEqual([]);

  const sizes = await page
    .locator('main input:not([type="hidden"]):not([type="radio"])')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize));
  expect(sizes.length).toBeGreaterThanOrEqual(10);
  expect(new Set(sizes)).toEqual(new Set(['16px']));
});

test('fills fields by the tokens a browser knows', async ({ page }) => {
  await open(page);
  const tokens = await page
    .locator('main input[autocomplete]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('autocomplete')));
  expect(tokens).toEqual(
    expect.arrayContaining([
      'email',
      'given-name',
      'family-name',
      'tel',
      'shipping name',
      'shipping address-line1',
      'shipping address-line2',
      'shipping address-level2',
      'shipping address-level1',
      'shipping postal-code',
      'shipping country-name',
    ]),
  );
});

test('is never cached, shared, framed or read from a Referer, and pads for the notch', async ({
  page,
}) => {
  const res = await open(page);
  expect(res.headers()['cache-control']).toBe('no-store');
  expect(res.headers()['referrer-policy']).toBe('no-referrer');
  // The dev server sets no policy of its own; the Worker still denies framing
  // (tests/checkout-page.test.ts holds `frame-ancestors 'none'` on the built entry).
  expect(res.headers()['x-frame-options']).toBe('DENY');
  expect(new URL(page.url()).search).toBe('');
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('viewport-fit=cover');
  await expect(page.getByRole('navigation')).toHaveCount(0);
  // The page's own padding, or the inset when it is bigger: the insets are only ever read as
  // `--safe-*`, so a notch can be faked by setting them, and the padding follows.
  const main = page.locator('main');
  const padding = (side: 'Left' | 'Right' | 'Top' | 'Bottom') =>
    main.evaluate(
      (el, s) => Number.parseFloat(getComputedStyle(el)[`padding${s}` as 'paddingLeft']),
      side,
    );
  expect(await padding('Left')).toBeGreaterThanOrEqual(16);
  await page.evaluate(() => {
    const root = document.documentElement.style;
    for (const [side, px] of [
      ['left', 47],
      ['right', 53],
      ['top', 59],
      ['bottom', 34],
    ] as const)
      root.setProperty(`--safe-${side}`, `${px}px`);
  });
  expect(await padding('Left')).toBe(47);
  expect(await padding('Right')).toBe(53);
  expect(await padding('Top')).toBe(59);
  expect(await padding('Bottom')).toBeGreaterThanOrEqual(34);
});

test('in test mode loads nothing of Stripe and keeps the browser’s payment request denied', async ({
  page,
}) => {
  // The dev engine records payments only, so this is the mock path: the page takes no card. (The
  // Payment Element, Apple Pay and 3-D Secure need Stripe's own pages and a registered domain, which
  // this offline run has neither of; tests/card-payment.test.ts holds what the page posts and its
  // policy, and tests/stripe/hosted-pay.test.ts the engine against Stripe's shapes.)
  const stripe: string[] = [];
  page.on('request', (r) => {
    if (/stripe\.com/.test(r.url())) stripe.push(r.url());
  });
  const res = await open(page);
  expect(res.headers()['permissions-policy']).toContain('payment=()');
  expect(res.headers()['permissions-policy'] ?? '').not.toContain('stripe');
  await expect(page.getByRole('button', { name: 'Place order (test mode)' })).toBeVisible();
  await expect(page.getByText('Card payment needs JavaScript')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(stripe).toEqual([]);
});

test('says which field is wrong, next to it, and keeps what was typed', async ({ page }) => {
  await open(page);
  await page.getByLabel('Email').fill('not an email');
  await page.getByLabel('First name').fill('Ada');
  await page.getByRole('button', { name: 'Place order (test mode)' }).click();
  const email = page.getByLabel('Email');
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Enter an email address like name@example.com.')).toBeVisible();
  await expect(email).toHaveValue('not an email');
  await expect(page.getByLabel('First name')).toHaveValue('Ada');
  await expect(page.getByText('Check the highlighted fields.')).toBeVisible();
  await fits(page);
});

test('picking up swaps the address for the stores', async ({ page }) => {
  await open(page);
  await expect(page.getByLabel('Address', { exact: true })).toBeVisible();
  // The row is the target, as a finger or a click finds it: not the 16px circle.
  await page.getByText('Pick it up in a store').click();
  await expect(page.getByLabel('Address', { exact: true })).toBeHidden();
  await expect(page.getByRole('radio', { name: /Austin Central/ })).toBeVisible();
  await fits(page);
});

test('a refused order says so on the one alert and takes focus there', async ({ page }) => {
  await open(page);
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByRole('button', { name: 'Place order (test mode)' }).click();
  // The device tests' engine has no checkout flow, so it answers that it isn't set up: said in words,
  // on the alert for an order that was not placed, with what was typed kept.
  const alert = page.getByRole('alert').filter({ hasText: 'Order not placed' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Checkout is not set up for this business.');
  await expect(alert).toBeFocused();
  await expect(page.getByLabel('Email')).toHaveValue('ada@example.com');
  await expect(page.getByRole('alert')).toHaveCount(1);
  await fits(page);
});

test('says "this checkout changed" when the page was out of date, and shows it as it is', async ({
  page,
}) => {
  await open(page);
  await page.getByLabel('Email').fill('ada@example.com');
  // The page was drawn at one version; the session is at another: the post names one it never had.
  // (Done on the wire, so it holds whether or not the page has hydrated.)
  await page.route(/\/checkout\/chk_e2e_page(\.data)?(\?.*)?$/, (route) => {
    const post = route.request().postData();
    return route.request().method() === 'POST' && post
      ? route.continue({ postData: post.replace(/version=\d+/, 'version=999') })
      : route.continue();
  });
  await page.getByRole('button', { name: 'Apply' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'This checkout changed' });
  await expect(alert).toBeVisible();
  await expect(alert).toBeFocused();
  // Its fields start again from the session as it is: what was typed was not saved.
  await expect(page.getByLabel('Email')).toHaveValue('');
  await expect(page.locator('input[name="version"]')).toHaveValue('1');
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('a checkout that is over, being placed or placed offers nothing to change', async ({
  page,
}) => {
  await open(page, ENDED_ID);
  await expect(page.getByText('This checkout has ended')).toBeVisible();
  await expect(page.getByText('Note: This checkout expired.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Place order/ })).toHaveCount(0);
  await expect(page.getByLabel('Email')).toBeDisabled();
  await fits(page);

  await open(page, CLAIMED_ID);
  await expect(page.getByText('Your order is being placed')).toBeVisible();
  await expect(page.getByLabel('Email')).toBeDisabled();
  await expect(page.getByRole('button', { name: /Place order/ })).toHaveCount(0);

  // A placed one goes to its order: the reference, nothing personal in the address.
  const res = await page.goto(`/checkout/${PLACED_ID}`);
  expect(page.url()).toContain(`/checkout/${PLACED_ID}/placed`);
  expect(res?.headers()['cache-control']).toBe('no-store');
  await expect(page.getByRole('heading', { name: 'Order placed' })).toBeVisible();
  await expect(page.getByText(`#${PLACED_ORDER.slice(-6)}`)).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  await fits(page);
});

test('works from the keyboard alone: tab to a field, submit with Enter, land on what is wrong', async ({
  page,
}) => {
  await open(page);
  await page.locator('body').press('Tab');
  await expect(page.getByLabel('Email')).toBeFocused();
  await page.keyboard.type('not an email');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
  // Focus is on the field that is wrong, with its message read as its description.
  await expect(page.getByLabel('Email')).toBeFocused();
  await expect(page.getByLabel('Email')).toHaveAccessibleDescription(/Enter an email address/);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('ada@example.com');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('First name (optional)')).toBeFocused();
});

test('has nothing an accessibility scan finds, open or over', async ({ page }) => {
  for (const id of [CHECKOUT_ID, ENDED_ID]) {
    await open(page, id);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`),
      id,
    ).toEqual([]);
  }
});
