import { ValidationError } from '@commerceworker/domain';

/**
 * Pure, DNS-free SSRF guard for user-supplied outbound URLs (webhook targets,
 * function endpoints). It refuses non-http(s) schemes and any host that is a
 * literal loopback / link-local / private / unique-local address, plus
 * `localhost` and `*.local` / `*.internal` names.
 *
 * This is the first line of defence and is portable everywhere (no I/O). It
 * cannot catch a public hostname that *resolves* to an internal IP (DNS
 * rebinding); the sending adapter complements it with `redirect: 'manual'` and,
 * where the runtime allows, a resolved-IP re-check before connecting.
 */
export function assertSafeExternalUrl(rawUrl: string, field = 'url'): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError([{ field, message: 'must be a valid absolute URL' }]);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError([{ field, message: 'must use http or https' }]);
  }
  // URL keeps IPv6 hosts in brackets; strip them for inspection.
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (isBlockedHost(host)) {
    throw new ValidationError([
      { field, message: 'must not target a loopback, link-local, or private address' },
    ]);
  }
}

function isBlockedHost(host: string): boolean {
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;

  const v4 = parseIPv4(host);
  if (v4) return isBlockedIPv4(v4);

  // IPv6 literal (host had brackets stripped, so it contains ':').
  if (host.includes(':')) return isBlockedIPv6(host);

  return false;
}

function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number) as [number, number, number, number];
  if (parts.some((p) => p > 255)) return null;
  return parts;
}

function isBlockedIPv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 ("this host")
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC 6598)
  return false;
}

function isBlockedIPv6(host: string): boolean {
  const h = host.split('%')[0] ?? host; // drop zone id
  if (h === '::1' || h === '::') return true; // loopback / unspecified
  // IPv4-mapped (e.g. ::ffff:127.0.0.1) — the WHATWG URL parser normalizes the
  // embedded v4 to hex (::ffff:7f00:1), so accept both dotted and hex forms.
  const mapped = extractMappedV4(h);
  if (mapped && isBlockedIPv4(mapped)) return true;
  const first = h.split(':')[0] ?? '';
  const head = Number.parseInt(first || '0', 16);
  if (Number.isNaN(head)) return false;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

function extractMappedV4(h: string): [number, number, number, number] | null {
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (dotted?.[1]) return parseIPv4(dotted[1]);
  const hex = /::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
  }
  return null;
}
