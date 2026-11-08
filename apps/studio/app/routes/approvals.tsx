import { CmsPage } from '~/cms/providers';
import { Approvals } from '~/cms/routes/Approvals';

export default function ApprovalsRoute() {
  return (
    <CmsPage title="Approvals">
      <Approvals />
    </CmsPage>
  );
}
