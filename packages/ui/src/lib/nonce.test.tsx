import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentNonce, NonceContext, useNonce } from './nonce';

describe('the nonce in the browser', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A page whose theme script was served with `nonce`, its attribute emptied as under a CSP header. */
  const page = (nonce: string | null) => ({
    querySelector: (sel: string) =>
      sel === 'script[nonce]' && nonce !== null ? { nonce, getAttribute: () => '' } : null,
  });
  const Script = () => createElement('script', { nonce: useNonce() });

  it('renders the same nonce the server did, read from the property, so hydration matches', () => {
    const server = renderToStaticMarkup(
      createElement(NonceContext.Provider, { value: 'r4nd0m' }, createElement(Script)),
    );
    vi.stubGlobal('document', page('r4nd0m'));
    expect(renderToStaticMarkup(createElement(Script))).toBe(server);
    expect(server).toContain('nonce="r4nd0m"');
  });

  it('has none where the page carries none, and none on the server without a context', () => {
    expect(documentNonce(page(null))).toBeUndefined();
    expect(documentNonce(page(''))).toBeUndefined();
    expect(documentNonce(undefined)).toBeUndefined();
  });
});
