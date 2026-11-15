import { CmsPage } from '@commerceworker/content-admin/providers';
import { ContentLayout } from '@commerceworker/content-admin/routes/ContentLayout';

/** Content: the space's content types beside the entries list or the entry editor. */
export default function ContentRoute() {
  return (
    <CmsPage title="Content">
      <ContentLayout />
    </CmsPage>
  );
}
