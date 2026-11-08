/** Join absolute site origin and path for canonical / Open Graph URLs. */
export function joinCanonical(base: string, pathname: string): string {
  const b = base.replace(/\/$/, '');
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${b}${p}`;
}
