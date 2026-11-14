/**
 * The storefront's root (`/`): the store's name, the way to a shopper's account, and what to open
 * instead, with the merchant's name only ever drawn as text and the platform's never.
 */
import { describe, expect, it } from 'vitest';
import HomePage, { meta } from '../app/routes/home';
import { drawPage, MARKUP_NAME, rootMatches } from './draw-page';

describe('the storefront home page', () => {
  it('names the store and links to the account', () => {
    const html = drawPage(HomePage, {}, 'Juniper & Pine');
    expect(html).toContain('Juniper &amp; Pine');
    expect(html).toMatch(/<a[^>]+href="\/account"[^>]*>Go to your orders<\/a>/);
    expect(html).toContain('Open the link you were sent');
  });

  it('draws the merchant name as text, never markup', () => {
    const html = drawPage(HomePage, {}, MARKUP_NAME);
    expect(html).not.toContain('<b>Supply</b>');
    expect(html).toContain('&lt;b&gt;Supply&lt;/b&gt;');
  });

  it('names no one when no store name is set', () => {
    const html = drawPage(HomePage, {}, null);
    expect(html).toContain('Your account');
    expect(html.toLowerCase()).not.toContain('commerceworker');
  });

  it('titles the page with the store name and keeps it out of search', () => {
    const tags = meta({ matches: rootMatches('Juniper & Pine') } as never);
    expect(tags).toContainEqual({ title: 'Juniper & Pine' });
    expect(tags).toContainEqual({ name: 'robots', content: 'noindex' });
    expect(meta({ matches: rootMatches(null) } as never)).toContainEqual({ title: 'Your account' });
  });
});
