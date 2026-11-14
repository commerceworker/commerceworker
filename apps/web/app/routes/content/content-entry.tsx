import { useParams } from '@commerceworker/content-admin/router';
import { EntryEditor } from '@commerceworker/content-admin/routes/EntryEditor';

/** The entry editor, for a new entry (`/content/:typeId/new`) or an existing one. */
export default function EntryRoute() {
  const { typeId, entryId } = useParams();
  // Keyed so moving between entries starts each with its own form state.
  return <EntryEditor key={`${typeId}/${entryId ?? 'new'}`} />;
}
