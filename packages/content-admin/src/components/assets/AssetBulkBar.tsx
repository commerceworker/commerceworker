import { ConfirmButton } from '@commerceworker/content-admin/components/InlineConfirm';
import { folderLabel, folderRows } from '@commerceworker/content-admin/lib/assets';
import { plural } from '@commerceworker/content-admin/lib/format';
import type { AssetCollection, AssetFolder } from '@commerceworker/domain';
import { BulkBar } from '@commerceworker/ui/bulk-bar';
import { Button } from '@commerceworker/ui/button';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import {
  Archive,
  CircleSlash,
  Download,
  FolderInput,
  GalleryVerticalEnd,
  Send,
  Tag as TagIcon,
} from 'lucide-react';
import { useState } from 'react';

const ROOT = '__root__';

/**
 * What can be done to the selected assets at once: publish or unpublish them, archive them, file
 * them, tag or untag them, add them to a collection, or download them as one zip. Labelled as the
 * entries list labels its selection ("2 selected", "Publish selected"). Archiving and unpublishing several ask first, in place: both take assets
 * out of Delivery at once, and undoing either means acting on each again.
 */
export function AssetBulkBar(props: {
  count: number;
  folders: readonly AssetFolder[];
  tags: readonly { readonly id: string; readonly name: string }[];
  busy: boolean;
  onMove: (folderId: string | null) => void;
  onTag: (tagId: string, change: 'add' | 'remove') => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onArchive: () => void;
  collections?: readonly AssetCollection[];
  onAddToCollection?: (collectionId: string) => void;
  onZip?: () => void;
  /** A zip is being asked for: Download as zip waits for the answer (no second zip). */
  zipStarting?: boolean;
  onClear: () => void;
}) {
  const [target, setTarget] = useState(ROOT);
  const [tag, setTag] = useState('');
  const [collection, setCollection] = useState('');
  const collections = props.collections ?? [];
  if (props.count === 0) return null;
  const noun = plural(props.count, 'asset');
  return (
    <BulkBar label="Selected assets" count={props.count} onClear={props.onClear}>
      <Button type="button" size="sm" disabled={props.busy} onClick={props.onPublish}>
        <Send aria-hidden="true" />
        Publish selected
      </Button>
      <ConfirmButton
        message={`Unpublish ${noun}?`}
        note="They stop being delivered at once. Publishing them again restores what was live."
        confirmLabel={`Unpublish ${noun}`}
        busy={props.busy}
        onConfirm={props.onUnpublish}
      >
        {(ask) => (
          <Button type="button" size="sm" variant="outline" disabled={props.busy} onClick={ask}>
            <CircleSlash aria-hidden="true" />
            Unpublish selected
          </Button>
        )}
      </ConfirmButton>
      <ConfirmButton
        message={`Archive ${noun}?`}
        note="They stop being delivered at once. Restore brings each one back as a draft."
        confirmLabel={`Archive ${noun}`}
        busy={props.busy}
        onConfirm={props.onArchive}
      >
        {(ask) => (
          <Button type="button" size="sm" variant="outline" disabled={props.busy} onClick={ask}>
            <Archive aria-hidden="true" />
            Archive selected
          </Button>
        )}
      </ConfirmButton>
      <div className="flex flex-wrap items-center gap-1">
        <NativeSelect
          size="sm"
          aria-label="Move to folder"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <NativeSelectOption value={ROOT}>Not in a folder</NativeSelectOption>
          {folderRows(props.folders).map(({ folder }) => (
            <NativeSelectOption key={folder.id} value={folder.id}>
              {folderLabel(folder, props.folders)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.onMove(target === ROOT ? null : target)}
        >
          <FolderInput aria-hidden="true" />
          Move selected
        </Button>
      </div>
      {props.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <NativeSelect
            size="sm"
            aria-label="Tag to add or remove"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          >
            <NativeSelectOption value="">Choose a tag</NativeSelectOption>
            {props.tags.map((t) => (
              <NativeSelectOption key={t.id} value={t.id}>
                {t.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.busy || !tag}
            onClick={() => props.onTag(tag, 'add')}
          >
            <TagIcon aria-hidden="true" />
            Add tag
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={props.busy || !tag}
            onClick={() => props.onTag(tag, 'remove')}
          >
            Remove tag
          </Button>
        </div>
      )}
      {props.onAddToCollection && collections.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <NativeSelect
            size="sm"
            aria-label="Collection to add to"
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
          >
            <NativeSelectOption value="">Choose a collection</NativeSelectOption>
            {collections.map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {c.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.busy || !collection}
            onClick={() => props.onAddToCollection?.(collection)}
          >
            <GalleryVerticalEnd aria-hidden="true" />
            Add to collection
          </Button>
        </div>
      )}
      {props.onZip && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.busy || props.zipStarting}
          aria-busy={props.zipStarting || undefined}
          onClick={props.onZip}
        >
          <Download aria-hidden="true" />
          Download as zip
        </Button>
      )}
    </BulkBar>
  );
}
