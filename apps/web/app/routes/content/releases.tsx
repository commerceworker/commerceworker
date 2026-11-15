import { CmsPage } from '@commerceworker/content-admin/providers';
import { Releases } from '@commerceworker/content-admin/routes/Releases';

export default function ReleasesRoute() {
  return (
    <CmsPage title="Releases">
      <Releases />
    </CmsPage>
  );
}
