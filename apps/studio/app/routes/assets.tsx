import { AssetLibrary } from '~/cms/components/AssetLibrary';
import { useClient } from '~/cms/lib/client-context';
import { CmsPage } from '~/cms/providers';

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
