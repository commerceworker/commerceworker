import { ConfirmDialog } from '@commerceworker/content-admin/components/ConfirmDialog';
import { EmptyState, PageHeader } from '@commerceworker/content-admin/components/page';
import {
  type EditableTerm,
  type TermChanges,
  TermEditor,
} from '@commerceworker/content-admin/components/TermEditor';
import type { Concept, Tag } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@commerceworker/ui/card';
import {
  Catalog,
  CatalogEmpty,
  CatalogFigure,
  CatalogRow,
  CatalogTile,
  ListSearch,
  ListToolbar,
} from '@commerceworker/ui/catalog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@commerceworker/ui/tabs';
import { Hash, Pencil, Tag as TagIcon, Tags, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useClient } from '../lib/client-context';
import type { WithUsage } from '../lib/management';
import { useInvalidate, useScopedQuery, useSpaceConfigQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

const NONE = '__none__';

/** The space's locales, for the localized labels; the connection's alone until config loads. */
function useLocales(): { locales: readonly string[]; defaultLocale: string } {
  const config = useSpaceConfigQuery().data;
  return config
    ? { locales: config.locales, defaultLocale: config.defaultLocale }
    : { locales: [], defaultLocale: '' };
}

/** "3 published", the figure an archive page shows; the sheet names the content types. */
const publishedCount = (n: number) => `${n} published`;

const tagTerm = (t: WithUsage<Tag>): EditableTerm => ({
  label: t.name,
  slug: t.slug,
  description: t.description,
  labels: t.labels,
  usage: t.usage,
});

const conceptTerm = (c: WithUsage<Concept>): EditableTerm => ({
  label: c.prefLabel,
  slug: c.slug,
  description: c.description,
  labels: c.labels,
  usage: c.usage,
});

/** Taxonomy admin: concept schemes + hierarchical concepts, and flat tags. */
export function Taxonomy() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Taxonomy"
        subtitle="Controlled vocabulary: hierarchical concept schemes and flat tags, each with the slug its archive page uses and how many published entries carry it."
      />
      <Tabs defaultValue="concepts">
        <TabsList>
          <TabsTrigger value="concepts">
            <Hash className="size-4" />
            Concepts
          </TabsTrigger>
          <TabsTrigger value="tags">
            <Tags className="size-4" />
            Tags
          </TabsTrigger>
        </TabsList>
        <TabsContent value="concepts" className="mt-4">
          <ConceptsTab />
        </TabsContent>
        <TabsContent value="tags" className="mt-4">
          <TagsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Consequence line for deleting a concept: names any narrower concepts under it. */
function narrowerNote(concepts: readonly Concept[], id: string): string {
  const narrower = concepts.filter((c) => c.broaderId === id).length;
  return narrower > 0
    ? `${narrower} narrower ${narrower === 1 ? 'concept sits' : 'concepts sit'} under it. This can’t be undone.`
    : 'This can’t be undone.';
}

/** Orders concepts as a depth-first tree and annotates each with its depth. */
function asTree<C extends Concept>(concepts: C[]): { concept: C; depth: number }[] {
  const byParent = new Map<string | null, C[]>();
  for (const c of concepts) {
    const key = c.broaderId ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), c]);
  }
  const out: { concept: C; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of byParent.get(parent) ?? []) {
      out.push({ concept: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function ConceptsTab() {
  const { client, busy, run } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [pickedSchemeId, setPickedSchemeId] = useState('');
  const [newScheme, setNewScheme] = useState('');
  const [label, setLabel] = useState('');
  const [broaderId, setBroaderId] = useState<string>(NONE);
  // The scheme or concept whose delete is awaiting an inline "are you sure?".
  // The concept open in the editor sheet.
  const [editing, setEditing] = useState<string | null>(null);
  const { locales, defaultLocale } = useLocales();

  const schemes = useScopedQuery(['schemes'], () => client.listSchemes()).data ?? [];
  // Default to the first scheme until the user picks one explicitly. The pick
  // must exist in the current list — after a delete or an environment switch a
  // stale pick would otherwise drive a concepts fetch for a missing scheme.
  const schemeId = schemes.some((s) => s.id === pickedSchemeId)
    ? pickedSchemeId
    : (schemes[0]?.id ?? '');
  const concepts =
    useScopedQuery(['concepts', schemeId], () => client.listConcepts(schemeId), {
      enabled: !!schemeId,
    }).data ?? [];

  const addScheme = () =>
    run(async () => {
      const created = await client.createScheme({ name: newScheme.trim() });
      setNewScheme('');
      toast.success('Scheme created');
      await invalidate(['schemes']);
      setPickedSchemeId(created.id);
    });

  const removeScheme = async (id: string) => {
    await client.deleteScheme(id);
    toast.success('Scheme deleted');
    setPickedSchemeId('');
    // Refetch schemes first: once the deleted scheme is gone from the list,
    // its concepts query is inactive, so the concepts invalidation can't
    // fire a doomed listConcepts() against the deleted scheme.
    await invalidate(['schemes']);
    await invalidate(['concepts']);
  };

  const addConcept = () =>
    run(async () => {
      await client.createConcept({
        schemeId,
        prefLabel: label.trim(),
        broaderId: broaderId === NONE ? null : broaderId,
      });
      setLabel('');
      setBroaderId(NONE);
      await invalidate(['concepts', schemeId]);
    });

  // A failure is thrown on, so the editor says it beside the form it kept.
  const saveConcept = async (id: string, changes: TermChanges) => {
    let failed: unknown;
    await run(async () => {
      try {
        const { label: prefLabel, ...fields } = changes;
        await client.updateConcept(id, { ...(prefLabel ? { prefLabel } : {}), ...fields });
        toast.success('Concept saved');
        setEditing(null);
        await invalidate(['concepts', schemeId]);
      } catch (err) {
        failed = err;
      }
    });
    if (failed !== undefined) throw failed;
  };

  const removeConcept = async (id: string) => {
    await client.deleteConcept(id);
    await invalidate(['concepts', schemeId]);
  };

  const tree = asTree(concepts);

  return (
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Schemes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={newScheme}
              onChange={(e) => setNewScheme(e.target.value)}
              placeholder="New scheme"
            />
            <Button
              type="button"
              size="sm"
              disabled={!newScheme.trim() || busy}
              onClick={addScheme}
            >
              Add
            </Button>
          </div>
          {schemes.length === 0 ? (
            <p className="text-muted-foreground text-sm">No schemes yet.</p>
          ) : (
            <ul className="space-y-1">
              {schemes.map((s) => (
                <li key={s.id} className="group flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    aria-current={s.id === schemeId ? 'true' : undefined}
                    className={`flex-1 truncate rounded-lg px-2.5 py-1 text-left text-sm ${
                      s.id === schemeId ? 'current-item bg-muted font-medium' : 'hover:bg-muted/60'
                    }`}
                    onClick={() => setPickedSchemeId(s.id)}
                  >
                    {s.name}
                  </button>
                  <ConfirmDialog
                    message={`Delete “${s.name}”?`}
                    note={
                      s.id === schemeId && concepts.length > 0
                        ? `It holds ${concepts.length} ${concepts.length === 1 ? 'concept' : 'concepts'}. This can’t be undone.`
                        : 'This can’t be undone.'
                    }
                    confirmLabel="Delete scheme"
                    busy={busy}
                    onConfirm={() => removeScheme(s.id)}
                  >
                    {(ask) => (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Delete “${s.name}”`}
                        onClick={ask}
                        disabled={busy}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </ConfirmDialog>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Concepts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!schemeId ? (
            <p className="text-muted-foreground text-sm">Select or create a scheme.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex-1 space-y-1.5">
                  <Label>Preferred label</Label>
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Cats"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Broader</Label>
                  <Select value={broaderId} onValueChange={setBroaderId}>
                    <SelectTrigger aria-label="Broader concept" className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>— top level —</SelectItem>
                      {concepts.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.prefLabel}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="button" disabled={!label.trim() || busy} onClick={addConcept}>
                  Add concept
                </Button>
              </div>

              {tree.length === 0 ? (
                <p className="text-muted-foreground text-sm">No concepts in this scheme yet.</p>
              ) : (
                <ul className="space-y-1">
                  {tree.map(({ concept, depth }) => (
                    <li
                      key={concept.id}
                      className="group flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                      style={{ paddingLeft: `${depth * 1.5 + 0.5}rem` }}
                    >
                      <span className="min-w-0 flex-1 text-sm">
                        {depth > 0 && <span className="text-muted-foreground">↳ </span>}
                        {concept.prefLabel}{' '}
                        <span className="font-mono text-muted-foreground text-xs">
                          {concept.slug}
                        </span>
                      </span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {publishedCount(concept.usage.count)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        id={`concept-edit-${concept.id}`}
                        aria-label={`Edit “${concept.prefLabel}”`}
                        onClick={() => setEditing(concept.id)}
                        disabled={busy}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <ConfirmDialog
                        message={`Delete “${concept.prefLabel}”?`}
                        note={narrowerNote(concepts, concept.id)}
                        confirmLabel="Delete concept"
                        busy={busy}
                        onConfirm={() => removeConcept(concept.id)}
                      >
                        {(ask) => (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label={`Delete “${concept.prefLabel}”`}
                            onClick={ask}
                            disabled={busy}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </ConfirmDialog>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <TermEditor
        kind="concept"
        term={(() => {
          const c = concepts.find((x) => x.id === editing);
          return c ? conceptTerm(c) : null;
        })()}
        locales={locales}
        defaultLocale={defaultLocale}
        busy={busy}
        onSave={(changes) => (editing ? saveConcept(editing, changes) : undefined)}
        onOpenChange={(open) => !open && setEditing(null)}
      />
    </div>
  );
}

function TagsTab() {
  const { client, busy, run } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  // The tag open in the editor sheet.
  const [editing, setEditing] = useState<string | null>(null);
  const { locales, defaultLocale } = useLocales();

  const tags = useScopedQuery(['tags'], () => client.listTags()).data ?? [];
  // The API returns every tag, so the filter is safe to run here.
  const needle = query.trim().toLowerCase();
  const shown = [...tags]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(
      (t) => !needle || `${t.name} ${t.slug} ${t.description ?? ''}`.toLowerCase().includes(needle),
    );

  const add = () =>
    run(async () => {
      await client.createTag({ name: name.trim() });
      setName('');
      await invalidate(['tags']);
    });

  // A failure is thrown on, so the editor says it beside the form it kept.
  const save = async (id: string, changes: TermChanges) => {
    let failed: unknown;
    await run(async () => {
      try {
        const { label, ...fields } = changes;
        await client.updateTag(id, { ...(label ? { name: label } : {}), ...fields });
        toast.success('Tag saved');
        setEditing(null);
        await invalidate(['tags']);
      } catch (err) {
        failed = err;
      }
    });
    if (failed !== undefined) throw failed;
  };

  const remove = async (id: string) => {
    await client.deleteTag(id);
    toast.success('Tag deleted');
    await invalidate(['tags']);
  };

  const open = tags.find((t) => t.id === editing);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tags</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 sm:max-w-sm">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New tag"
            aria-label="New tag"
          />
          <Button type="button" disabled={!name.trim() || busy} onClick={add}>
            Add tag
          </Button>
        </div>
        {tags.length === 0 ? (
          <EmptyState icon={Tags} title="No tags yet" description="Add a tag to label entries." />
        ) : (
          <>
            {/* The card's content is padded already, so these line up with the form above. */}
            <ListToolbar className="p-0" summary={`${shown.length} shown`}>
              <ListSearch
                label="Search tags"
                placeholder="Search tags"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClear={() => setQuery('')}
              />
            </ListToolbar>
            {shown.length === 0 ? (
              <CatalogEmpty className="p-0" onClear={() => setQuery('')}>
                No tags match “{query.trim()}”.
              </CatalogEmpty>
            ) : (
              <Catalog aria-label="Tags" className="p-0">
                {shown.map((t) => (
                  <CatalogRow
                    key={t.id}
                    media={
                      <CatalogTile>
                        <TagIcon aria-hidden="true" />
                      </CatalogTile>
                    }
                    title={t.name}
                    meta={
                      <span className="flex flex-wrap gap-x-2">
                        <span className="break-all font-mono">{t.slug}</span>
                        {t.description ? <span>{t.description}</span> : null}
                      </span>
                    }
                    aside={<CatalogFigure label="Published entries">{t.usage.count}</CatalogFigure>}
                    actions={
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          aria-label={`Edit “${t.name}”`}
                          onClick={() => setEditing(t.id)}
                          disabled={busy}
                        >
                          Edit
                        </Button>
                        <ConfirmDialog
                          message={`Delete the tag “${t.name}”?`}
                          note="This can’t be undone."
                          confirmLabel="Delete tag"
                          busy={busy}
                          onConfirm={() => remove(t.id)}
                        >
                          {(ask) => (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              aria-label={`Delete ${t.name}`}
                              onClick={ask}
                              disabled={busy}
                            >
                              Delete
                            </Button>
                          )}
                        </ConfirmDialog>
                      </div>
                    }
                  />
                ))}
              </Catalog>
            )}
          </>
        )}
      </CardContent>
      <TermEditor
        kind="tag"
        term={open ? tagTerm(open) : null}
        locales={locales}
        defaultLocale={defaultLocale}
        busy={busy}
        onSave={(changes) => (editing ? save(editing, changes) : undefined)}
        onOpenChange={(o) => !o && setEditing(null)}
      />
    </Card>
  );
}
