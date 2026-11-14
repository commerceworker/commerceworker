import { CmsPage } from '@commerceworker/content-admin/providers';
import { Taxonomy } from '@commerceworker/content-admin/routes/Taxonomy';

export default function TaxonomyRoute() {
  return (
    <CmsPage title="Taxonomy">
      <Taxonomy />
    </CmsPage>
  );
}
