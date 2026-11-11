import { usageError } from './output.js';

/**
 * Where the CLI is willing to send a token or open a browser, and what it will print of what a
 * server sent. A deployment's answers are untrusted text: they reach a terminal and, with `--open`,
 * a browser.
 */

const LOOPBACK_V4 = /^127(\.\d{1,3}){3}$/;

/** localhost, 127.0.0.0/8 and [::1]: where plain http is fine, since nothing leaves the machine. */
export const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' || LOOPBACK_V4.test(hostname) || hostname === '[::1]';

/** True for an https URL, or an http one on loopback. */
export const isSecureUrl = (url: URL): boolean =>
  url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));

/** The URL's origin, refusing anything a bearer token must not travel over (plain http off loopback). */
export function assertSecureOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`"${stripControl(raw)}" is not a URL.`);
  }
  if (!isSecureUrl(url)) {
    throw usageError(
      `Refusing ${url.protocol}//${stripControl(url.host)}: a token is only sent over https (http works for localhost).`,
    );
  }
  return url.origin;
}

/**
 * The page to open for `--open`, or undefined when it isn't safe: an https page (http on loopback)
 * with nothing in it a shell or a command line could read as more than a URL, and, when
 * `origin` is given, on that origin. The caller opens `href`, never the raw string.
 */
export function browserUrl(raw: string, origin?: string): string | undefined {
  if (/[\s"&<>^|`'\\\p{Cc}]/u.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (!isSecureUrl(url)) return undefined;
  if (origin !== undefined && url.origin !== origin) return undefined;
  return url.href;
}

const CONTROL = /\p{Cc}/gu;
const CONTROL_KEEP_LAYOUT = /(?![\n\t])\p{Cc}/gu;

/** Text with its C0 and C1 control characters removed: no escape sequence reaches a terminal. */
export const stripControl = (text: string): string => text.replace(CONTROL, '');

/** As {@link stripControl}, but keeps newlines and tabs, for output laid out in lines. */
export const stripControlKeepLayout = (text: string): string =>
  text.replace(CONTROL_KEEP_LAYOUT, '');

/** Every string inside a value, stripped (for an error's server-sent fields). */
export function cleanDeep<T>(value: T): T {
  if (typeof value === 'string') return stripControl(value) as T;
  if (Array.isArray(value)) return value.map(cleanDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanDeep(v)])) as T;
  }
  return value;
}
