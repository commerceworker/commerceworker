import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
} from '@commerceworker/content-admin/components/layout/nav';
import { Settings } from '@commerceworker/content-admin/components/Settings';
import { useClient } from '@commerceworker/content-admin/lib/client-context';
import { CmsPage } from '@commerceworker/content-admin/providers';
import { Navigate, redirect, useNavigate, useParams } from 'react-router';
import type { Route } from './+types/settings';

/** `/settings` (no section) lands on the first one. */
export function loader({ params }: Route.LoaderArgs) {
  if (!params.section) throw redirect(`/settings/${DEFAULT_SETTINGS_SECTION}`);
  return null;
}

function SettingsScreen() {
  const { client } = useClient();
  const { section = DEFAULT_SETTINGS_SECTION } = useParams();
  const navigate = useNavigate();
  // An unknown section (an old link, a typo) lands on the first one.
  if (!SETTINGS_SECTIONS.some((s) => s.id === section)) {
    return <Navigate to={`/settings/${DEFAULT_SETTINGS_SECTION}`} replace />;
  }
  return (
    <Settings client={client} section={section} onSection={(s) => navigate(`/settings/${s}`)} />
  );
}

export default function SettingsRoute() {
  return (
    <CmsPage title="Settings">
      <SettingsScreen />
    </CmsPage>
  );
}
