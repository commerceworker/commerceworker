import { SIDEBAR_COOKIE_NAME } from '@commerceworker/ui/sidebar';
import { describe, expect, it } from 'vitest';
import { sidebarOpenFrom } from '../app/lib/sidebar';

const withCookie = (cookie?: string) =>
  new Request('https://app.test/orders', cookie ? { headers: { cookie } } : {});

describe('the sidebar as it was left', () => {
  it('reads the cookie the sidebar writes, open unless it says false', () => {
    expect(sidebarOpenFrom(withCookie())).toBe(true);
    expect(sidebarOpenFrom(withCookie(`${SIDEBAR_COOKIE_NAME}=false`))).toBe(false);
    expect(sidebarOpenFrom(withCookie(`theme=dark; ${SIDEBAR_COOKIE_NAME}=false; x=1`))).toBe(
      false,
    );
    expect(sidebarOpenFrom(withCookie(`${SIDEBAR_COOKIE_NAME}=true`))).toBe(true);
  });

  it('is not fooled by another cookie whose name ends the same', () => {
    expect(sidebarOpenFrom(withCookie(`other_${SIDEBAR_COOKIE_NAME}=false`))).toBe(true);
  });
});
