import { CmsPage } from '@commerceworker/content-admin/providers';
import { Workflows } from '@commerceworker/content-admin/routes/Workflows';

export default function WorkflowsRoute() {
  return (
    <CmsPage title="Workflows">
      <Workflows />
    </CmsPage>
  );
}
