import { createContext, useContext } from 'react';

/** The per-response nonce for inline scripts, set by `entry.server.tsx`; absent in the browser. */
export const NonceContext = createContext<string | undefined>(undefined);

/**
 * The nonce this page was served with, read back in the browser from a script that carries it.
 * Under a CSP header the browser empties the `nonce` attribute (so no injected markup can read it)
 * and keeps the value in the property, which is also what React compares when it hydrates.
 */
export function documentNonce(
  doc: Pick<Document, 'querySelector'> | undefined = globalThis.document,
) {
  return doc?.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || undefined;
}

/**
 * The nonce for the root's inline scripts and links: the server's, or the same one in the browser.
 * Rendering none in the browser would make every one of them a hydration mismatch.
 */
export function useNonce(): string | undefined {
  return useContext(NonceContext) ?? documentNonce();
}
