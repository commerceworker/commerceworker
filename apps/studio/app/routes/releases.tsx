import { CmsPage } from '~/cms/providers';
import { Releases } from '~/cms/routes/Releases';

export default function ReleasesRoute() {
  return (
    <CmsPage title="Releases">
      <Releases />
    </CmsPage>
  );
}
