/**
 * The file a privacy export downloads: everything held about one person, as JSON. A POST from the
 * Privacy requests page (the address in the body, never the URL), admin only, audited, and never
 * stored by the browser or a cache.
 */
import { data } from 'react-router';
import { dataSubjectInput } from '~/lib/api-schemas';
import { requireUser } from '~/lib/auth.server';
import { exportSubject } from '~/lib/privacy.server';
import type { Route } from './+types/privacy-export';

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'admin');
  const parsed = dataSubjectInput.safeParse({
    email: String((await request.formData()).get('email') ?? ''),
  });
  if (!parsed.success) return data({ error: 'Enter the address the person is known by.' }, 400);
  const file = await exportSubject(request, me, parsed.data.email);
  return new Response(JSON.stringify(file, null, 2), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': 'attachment; filename="personal-data.json"',
      'cache-control': 'private, no-store',
    },
  });
}

/** Only the page's form posts here. */
export function loader() {
  return new Response('Not found', { status: 404 });
}
