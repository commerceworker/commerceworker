import { CmsPage } from '~/cms/providers';
import { ContentLayout } from '~/cms/routes/ContentLayout';

/** Content: the space's content types beside the entries list or the entry editor. */
export default function ContentRoute() {
  return (
    <CmsPage title="Content">
      <ContentLayout />
    </CmsPage>
  );
}
