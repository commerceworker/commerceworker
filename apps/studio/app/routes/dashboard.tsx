import { Dashboard } from '@commerceworker/content-admin/components/Dashboard';
import { CmsPage } from '@commerceworker/content-admin/providers';

/** The overview: the day's work, throughput and live activity for the current space. */
export default function DashboardRoute() {
  return (
    <CmsPage title="Overview">
      <Dashboard />
    </CmsPage>
  );
}
