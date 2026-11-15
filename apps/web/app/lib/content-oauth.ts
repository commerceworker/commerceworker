/** Keep the legacy content OAuth issuer while its browser forms run in the unified admin. */
export function contentOAuthResponse(response: Response): Response {
  const out = new Response(response.body, response);
  const location = out.headers.get('location');
  if (location?.startsWith('/oauth/')) out.headers.set('location', `/content-api${location}`);
  if (out.headers.get('content-type')?.startsWith('text/html'))
    return new HTMLRewriter()
      .on('form[action]', {
        element(element) {
          const action = element.getAttribute('action');
          if (action?.startsWith('/oauth/'))
            element.setAttribute('action', `/content-api${action}`);
        },
      })
      .transform(out);
  return out;
}
