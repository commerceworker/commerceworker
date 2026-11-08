import { CmsPage } from '~/cms/providers';
import { Taxonomy } from '~/cms/routes/Taxonomy';

export default function TaxonomyRoute() {
  return (
    <CmsPage title="Taxonomy">
      <Taxonomy />
    </CmsPage>
  );
}
