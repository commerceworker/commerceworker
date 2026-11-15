/** Host routing for the content screens. Studio uses the original paths; Web mounts them under /content. */
import { createContext, useCallback, useContext } from 'react';
import {
  type LinkProps,
  type NavigateFunction,
  type NavigateOptions,
  type NavigateProps,
  type NavLinkProps,
  Link as RouterLink,
  Navigate as RouterNavigate,
  NavLink as RouterNavLink,
  type To,
  useLocation as useRouterLocation,
  useNavigate as useRouterNavigate,
} from 'react-router';

export * from 'react-router';

export const ContentHost = createContext({ unified: false, apiPrefix: '' });

export function contentPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path;
  if (/^\/(account|team|logout|login)(\/|\?|#|$)/.test(path)) return path;
  if (path === '/' || path === '/dashboard') return '/content';
  if (/^\/content(\/|\?|#|$)/.test(path)) return path.replace(/^\/content/, '/content/entries');
  return `/content${path}`;
}

const target = (to: To, unified: boolean): To =>
  !unified
    ? to
    : typeof to === 'string'
      ? contentPath(to)
      : to.pathname
        ? { ...to, pathname: contentPath(to.pathname) }
        : to;

export function Link(props: LinkProps) {
  const { unified } = useContext(ContentHost);
  return <RouterLink {...props} to={target(props.to, unified)} />;
}

export function NavLink(props: NavLinkProps) {
  const { unified } = useContext(ContentHost);
  return <RouterNavLink {...props} to={target(props.to, unified)} />;
}

export function Navigate(props: NavigateProps) {
  const { unified } = useContext(ContentHost);
  return <RouterNavigate {...props} to={target(props.to, unified)} />;
}

export function useNavigate(): NavigateFunction {
  const navigate = useRouterNavigate();
  const { unified } = useContext(ContentHost);
  return useCallback(
    ((to: To | number, options?: NavigateOptions) =>
      typeof to === 'number'
        ? navigate(to)
        : options === undefined
          ? navigate(target(to, unified))
          : navigate(target(to, unified), options)) as NavigateFunction,
    [navigate, unified],
  );
}

export function useLocation() {
  const location = useRouterLocation();
  const { unified } = useContext(ContentHost);
  if (!unified) return location;
  const pathname =
    location.pathname === '/content'
      ? '/dashboard'
      : /^\/content\/entries(\/|$)/.test(location.pathname)
        ? location.pathname.replace(/^\/content\/entries/, '/content')
        : location.pathname.replace(/^\/content(?=\/)/, '');
  return { ...location, pathname };
}
