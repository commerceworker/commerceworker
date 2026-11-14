import { CmsPage } from '@commerceworker/content-admin/providers';
import { Approvals } from '@commerceworker/content-admin/routes/Approvals';

export default function ApprovalsRoute() {
  return (
    <CmsPage title="Approvals">
      <Approvals />
    </CmsPage>
  );
}
