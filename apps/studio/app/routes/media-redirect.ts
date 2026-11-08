import { redirect } from 'react-router';
import type { Route } from './+types/media-redirect';

/** `/media` was the Assets screen's address before it was renamed; its query string carries over. */
export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return redirect(`/assets${url.search}`, 301);
}
