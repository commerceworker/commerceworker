import type { AssetCollection } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Textarea } from '@commerceworker/ui/textarea';
import { GalleryVerticalEnd, Plus } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { TreeButton } from '~/cms/components/assets/AssetFolderTree';

const NONE = '__none__';

/**
 * A collection's name and description, for making one or changing it. Escape closes the form
 * only (caught before an enclosing sheet sees it, as the folder name form does).
 */
export function CollectionForm(props: {
  initial?: { readonly name: string; readonly description?: string };
  submitLabel: string;
  /** Names the form for assistive tech: "New collection", "Edit “Launch”". */
  label: string;
  onSubmit: (values: { name: string; description: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.initial?.name ?? '');
  const [description, setDescription] = useState(props.initial?.description ?? '');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const onCancel = useRef(props.onCancel);
  onCancel.current = props.onCancel;
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !form.current?.contains(e.target as Node | null)) return;
      e.preventDefault();
      e.stopPropagation();
      onCancel.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await props.onSubmit({ name: name.trim(), description: description.trim() });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      ref={form}
      aria-label={props.label}
      onSubmit={submit}
      className="flex flex-col gap-2 px-1 py-1"
    >
      <div className="space-y-1">
        <Label htmlFor={`${id}-name`} className="text-xs">
          Name
        </Label>
        <Input
          id={`${id}-name`}
          value={name}
          autoFocus
          maxLength={128}
          onChange={(e) => setName(e.target.value)}
          className="h-8"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-description`} className="text-xs">
          Description <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id={`${id}-description`}
          value={description}
          maxLength={1000}
          rows={2}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="flex gap-1">
        <Button type="submit" size="xs" disabled={busy || !name.trim()}>
          {props.submitLabel}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The library's collections, under its folders: each one a row that opens it in place of the
 * library, then New collection. Unlike a folder, a collection is a curated, ordered set: an asset
 * may be in any number of them. On a phone, a select of collections beside New collection.
 */
export function AssetCollectionList(props: {
  collections: readonly AssetCollection[];
  /** The open collection's id, or null while the library is showing. */
  value: string | null;
  onOpen: (id: string | null) => void;
  /** Resolves to the new collection, or undefined when it wasn't made (the caller said why). */
  onCreate: (values: { name: string; description: string }) => Promise<AssetCollection | undefined>;
}) {
  const { collections, value } = props;
  const [creating, setCreating] = useState(false);
  const [returnFocus, setReturnFocus] = useState(false);
  const createBtn = useRef<HTMLButtonElement>(null);
  const phoneCreateBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (creating || !returnFocus) return;
    // Whichever New collection is on screen (the list's from md, the select's on a phone).
    const btn = [createBtn.current, phoneCreateBtn.current].find((b) => b?.offsetParent !== null);
    (btn ?? createBtn.current)?.focus();
    setReturnFocus(false);
  }, [creating, returnFocus]);

  const form = creating && (
    <CollectionForm
      label="New collection"
      submitLabel="Create collection"
      onCancel={() => {
        setCreating(false);
        setReturnFocus(true);
      }}
      onSubmit={async (values) => {
        const created = await props.onCreate(values);
        setCreating(false);
        // A new collection opens; its heading takes focus there.
        if (!created) setReturnFocus(true);
      }}
    />
  );

  return (
    <nav aria-label="Collections" className="min-w-0">
      {/* Phones: a select of collections, and New collection beside it. */}
      <div className="md:hidden">
        <div className="flex items-center gap-2">
          <NativeSelect
            aria-label="Collection"
            value={value ?? NONE}
            onChange={(e) => props.onOpen(e.target.value === NONE ? null : e.target.value)}
            wrapperClassName="min-w-0 flex-1"
          >
            <NativeSelectOption value={NONE}>No collection</NativeSelectOption>
            {collections.map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {c.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            ref={phoneCreateBtn}
            type="button"
            variant="outline"
            size="icon"
            aria-label="New collection"
            onClick={() => setCreating(true)}
          >
            <Plus aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* From md: a captioned list under the folder tree. */}
      <div className="hidden flex-col gap-0.5 md:flex">
        <p className="caption px-3 pb-1">Collections</p>
        {collections.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {collections.map((c) => (
              <li key={c.id}>
                <TreeButton
                  current={value === c.id}
                  icon={<GalleryVerticalEnd />}
                  // Named with its count; the visible name comes first (WCAG 2.5.3).
                  label={`${c.name}, ${c.itemCount === 1 ? '1 asset' : `${c.itemCount} assets`}`}
                  onClick={() => props.onOpen(c.id)}
                >
                  {c.name}
                </TreeButton>
              </li>
            ))}
          </ul>
        ) : (
          !creating && (
            <p className="px-3 text-muted-foreground text-xs">
              Gather assets from any folder into an ordered set to share or download together.
            </p>
          )
        )}
        {!creating && (
          <div className="mt-2 border-t pt-2">
            <Button
              ref={createBtn}
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setCreating(true)}
            >
              <Plus aria-hidden="true" />
              New collection
            </Button>
          </div>
        )}
      </div>
      {/* One form at any size: on a phone under the select, from md under the list. */}
      {form && <div className="mt-2 md:border-t md:pt-2">{form}</div>}
    </nav>
  );
}
