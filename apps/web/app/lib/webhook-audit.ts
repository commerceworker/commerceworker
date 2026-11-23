/** What the audit log records about a webhook subscription. Pure, so REST and the screen share it. */

/**
 * A subscription's address as the audit log names it: scheme, host and path. A receiver may put its
 * own token in the query string, and the log keeps what it records.
 */
export function auditUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0]!;
  }
}
