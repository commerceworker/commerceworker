import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  route('login/two-factor', 'routes/login-two-factor.tsx'),
  route('login/passkey', 'routes/login-passkey.ts'),
  // Self-service password reset by an emailed code (lib/password-reset.server.ts). Public.
  // `/login/reset/<id>.<code>` (the emailed link) moves the code into a cookie and redirects.
  route('login/forgot', 'routes/login-forgot.tsx'),
  route('login/reset/:token?', 'routes/login-reset.tsx'),
  // Single sign-on with the deployment's identity provider (lib/sso.server.ts).
  route('login/sso', 'routes/login-sso.ts'),
  route('login/sso/callback', 'routes/login-sso-callback.ts'),
  route('login/sso/link', 'routes/login-sso-link.tsx'),
  route('logout', 'routes/logout.tsx'),
  // A new deployment's first admin, from its one-time setup code (lib/setup.server.ts).
  route('setup', 'routes/setup.tsx'),
  // Its second step: two-factor sign-in alone, before the first space (open while it is due).
  route('setup/two-factor', 'routes/setup-two-factor.tsx'),
  // Accepting an invitation to the team (lib/invites.server.ts): public, the link is the credential.
  // `/invite/<token>` moves the token into a cookie and redirects to `/invite`.
  route('invite/:token?', 'routes/invite.tsx'),
  layout('routes/shell.tsx', [
    // Setup's last step: the first space, set up with Coworker. Signed in, but a page of its own
    // (no sidebar or header: the shell draws it bare, `handle.bare`).
    route('setup/space', 'routes/setup-space.tsx'),
    // An error boundary inside the shell, so a refused or missing page keeps the app around it.
    layout('routes/in-app.tsx', [
      // Signed in, `/` is the dashboard.
      index('routes/home.tsx'),
      route('dashboard', 'routes/dashboard.tsx'),
      // The CMS screens (app/cms, ported from the Vite admin). Each runs on TanStack Query in the
      // browser, scoped to the space / environment / locale chosen in the header.
      route('content', 'routes/content.tsx', { id: 'content-layout' }, [
        index('routes/content-types.tsx', { id: 'content' }),
        // A whole space export, before any content type exists. A hyphen can't be in an apiId, so
        // this never shadows a content type's entries.
        route('space-import', 'routes/content-import.tsx', { id: 'content-space-import' }),
        route(':typeId', 'routes/content-entries.tsx', { id: 'content-type' }),
        route(':typeId/new', 'routes/content-entry.tsx', { id: 'content-new' }),
        route(':typeId/import', 'routes/content-import.tsx', { id: 'content-import' }),
        // A singleton type's one entry, wherever it is: the sidebar's link for such a type. An
        // entry id is a UUID, so it never shadows one.
        route(':typeId/entry', 'routes/content-singleton.tsx', { id: 'content-singleton' }),
        route(':typeId/:entryId', 'routes/content-entry.tsx', { id: 'content-entry' }),
      ]),
      route('approvals', 'routes/approvals.tsx', { id: 'approvals' }),
      route('releases', 'routes/releases.tsx', { id: 'releases' }),
      route('workflows', 'routes/workflows.tsx', { id: 'workflows' }),
      route('workflows/:id', 'routes/workflow.tsx', { id: 'workflow' }),
      route('taxonomy', 'routes/taxonomy.tsx', { id: 'taxonomy' }),
      route('assets', 'routes/assets.tsx', { id: 'assets' }),
      // The screen's old address: bookmarks and links keep working.
      route('media', 'routes/media-redirect.ts'),
      route('settings/:section?', 'routes/settings.tsx', { id: 'settings' }),
      // The deployment's people, single sign-on and SCIM (admins).
      route('team', 'routes/team.tsx'),
      route('audit', 'routes/audit.tsx'),
      route('account', 'routes/account.tsx'),
    ]),
  ]),
  route('account/passkeys', 'routes/account-passkeys.ts'),
] satisfies RouteConfig;
