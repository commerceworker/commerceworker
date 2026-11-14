import { AssetLibrary } from '@commerceworker/content-admin/components/AssetLibrary';
import { useClient } from '@commerceworker/content-admin/lib/client-context';
import { CmsPage } from '@commerceworker/content-admin/providers';

function Assets() {
  const { conn } = useClient();
  return <AssetLibrary locale={conn.locale} />;
}

export default function AssetsRoute() {
  return (
    <CmsPage title="Assets">
      <Assets />
    </CmsPage>
  );
}
