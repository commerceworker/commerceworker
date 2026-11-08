import { Dashboard } from '~/cms/components/Dashboard';
import { CmsPage } from '~/cms/providers';

/** The overview: the day's work, throughput and live activity for the current space. */
export default function DashboardRoute() {
  return (
    <CmsPage title="Overview">
      <Dashboard />
    </CmsPage>
  );
}
