import { CmsPage } from '@commerceworker/content-admin/providers';
import {
  EditorSkeleton,
  WorkflowEditor,
} from '@commerceworker/content-admin/routes/WorkflowEditor';
import '@xyflow/react/dist/style.css';

/** One workflow's graph editor (React Flow loads with this route only). */
export default function WorkflowRoute() {
  return (
    <CmsPage title="Workflow" bare skeleton={<EditorSkeleton />}>
      <WorkflowEditor />
    </CmsPage>
  );
}
