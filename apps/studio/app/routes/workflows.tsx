import { CmsPage } from '~/cms/providers';
import { Workflows } from '~/cms/routes/Workflows';

export default function WorkflowsRoute() {
  return (
    <CmsPage title="Workflows">
      <Workflows />
    </CmsPage>
  );
}
