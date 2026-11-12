import { expect, type Locator, test } from '@playwright/test';
import { STORE_NAME } from './checkout-seed';
import { placedId, placedKey, placedToken } from './placed-seed';

/**
 * A hosted checkout placed end to end, against the real engine: the buyer opens the start link,
 * fills in contact and address, takes a shipping option and places the order (test payments: the
 * device engine has no Stripe), lands on its placed page, and the order exists in the engine: its
 * confirmation email (captured as the engine's message row, since the device engine's local
 * `send_email` sends nothing) carries a receipt link that the engine honours and a made-up
 * credential does not. Nothing is mocked or seeded past the session and the published flow
 * (`placed-seed.ts`, published by the `publish` project once the other specs are done).
 *
 * One session per device project, retry and variant (hydrated or scripts off), as the start link
 * spends once.
 */

for (const scripts of [true, false]) {
  test.describe(scripts ? 'hydrated' : 'with scripts off', () => {
    test.use({ javaScriptEnabled: scripts });

    test('start link to placed order to receipt', async ({ page }, info) => {
      // Seven steps through a dev server that compiles each route on first use, and an order whose
      // flow runs in the engine: longer than one page's 30 s, and every wait below is on a
      // response, never a pause.
      test.setTimeout(120_000);
      const tap = (l: Locator) => l.click();
      const posted = () => page.waitForResponse((r) => r.request().method() === 'POST');
      const key = placedKey(info.project.name.replace(' placed', ''), info.retry, scripts);
      const id = placedId(key);

      // 1. The start link: a page that spends nothing until the button posts.
      await page.goto(`/checkout/start/${id}/${placedToken(key)}`);
      await Promise.all([
        posted(),
        tap(page.getByRole('button', { name: 'Continue to checkout' })),
      ]);

      // 2. The checkout page, under the merchant's name.
      // (A form's POST answers with a redirect: wait for the page it lands on, not for the answer.)
      await page.waitForURL(new RegExp(`/checkout/${id}$`));
      await expect(page.getByRole('heading', { name: 'Checkout', level: 1 })).toBeVisible();
      await expect(page.getByText(STORE_NAME, { exact: true })).toBeVisible();

      // 3. Contact and address; saving prices the order with the flow's own nodes.
      await page.getByLabel('Email').fill('ada@example.com');
      await page.getByLabel('First name').fill('Ada');
      await page.getByLabel('Address', { exact: true }).fill('500 Congress Ave');
      await page.getByLabel('City').fill('Austin');
      await page.getByLabel('State or region').fill('TX');
      await page.getByLabel('Postal code').fill('78701');
      await page.getByLabel('Country').fill('US');
      await Promise.all([posted(), tap(page.getByRole('button', { name: 'Apply' }))]);

      // 4. Shipping: the options the engine's shipping node quoted. The engine starts on the
      // first; the buyer takes the other and saves it, so the total they place is the one they
      // saw (placing with a changed option in the same press is refused: "its price moved").
      const shipping = page.getByRole('group', { name: 'Shipping' });
      // (The session was seeded with options of its own: wait for the engine's, so the choice is
      // made on the options that stay.)
      const express = shipping.getByRole('radio', { name: /Express/ });
      await expect(express).toBeVisible();
      await expect(shipping.getByRole('radio')).toHaveCount(2);
      await expect(express).not.toBeChecked();
      await tap(express);
      await Promise.all([posted(), tap(page.getByRole('button', { name: 'Apply' }))]);
      await expect(express).toBeChecked();

      // 5. Place the order.
      await Promise.all([
        posted(),
        tap(page.getByRole('button', { name: 'Place order (test mode)' })),
      ]);

      // 6. The placed page: the order's reference and the store's name.
      await page.waitForURL(new RegExp(`/checkout/${id}/placed$`));
      await expect(page.getByRole('heading', { name: 'Order placed' })).toBeVisible();
      await expect(page.getByText(STORE_NAME, { exact: true })).toBeVisible();
      const sentence = await page.getByText(/Your order reference is/).innerText();
      const ref = /#[A-Za-z0-9]+/.exec(sentence)?.[0];
      expect(ref, 'the order reference').toBeTruthy();
      expect(new URL(page.url()).search).toBe('');

      // 7. The confirmation email's receipt link. The device engine's local `send_email` sends
      // nothing, and miniflare keeps what it was given, which the dev server's explorer lists
      // (the engine's own message row carries the link without its credential). The engine mails
      // once the order's card is authorized, a moment after the page lands: poll, no sleeps.
      const explorer = '/cdn-cgi/local/explorer/api/local/email/sending';
      let link = '';
      await expect
        .poll(
          async () => {
            const list = (await (
              await page.request.get(explorer, { params: { per_page: 100 } })
            ).json()) as {
              result: { messageId: string; subject: string; to: string[] }[];
            };
            const sent = list.result.find((m) => m.subject === `Your order ${ref} is confirmed`);
            if (!sent) return '';
            const one = (await (
              await page.request.get(explorer, { params: { email_id: sent.messageId } })
            ).json()) as { result: { text: string } };
            link = /\/orders\/[A-Za-z0-9_-]+\?t=[A-Za-z0-9_-]+/.exec(one.result.text)?.[0] ?? '';
            return link;
          },
          {
            message: 'the confirmation email carries a receipt link',
            timeout: 60_000,
            intervals: [1_000],
          },
        )
        .toMatch(/\/orders\/ord_[A-Za-z0-9_-]+\?t=/);

      const receipt = await page.goto(link);
      expect(receipt?.status()).toBe(200);
      expect(receipt?.headers()['cache-control']).toBe('no-store');
      await expect(page.getByText(ref!).first()).toBeVisible();
      await expect(page.getByText('27" monitor').first()).toBeVisible();

      // A made-up credential reads the same as no order at all.
      const forged = await page.goto(`${link.split('?')[0]}?t=${'0'.repeat(64)}`);
      expect(forged?.status()).toBe(404);
    });
  });
}
