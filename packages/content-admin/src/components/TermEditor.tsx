import {
  DiscardAsk,
  type DiscardGuard,
  GuardCancel,
  useDiscardGuard,
} from '@commerceworker/content-admin/components/discard-guard';
import { ResponsiveSheetContent } from '@commerceworker/content-admin/components/responsive-sheet';
import type { TermFields } from '@commerceworker/content-admin/lib/management';
import type { TermUsageSummary } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { DialogError } from '@commerceworker/ui/dialog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@commerceworker/ui/sheet';
import { Textarea } from '@commerceworker/ui/textarea';
import { useEffect, useId, useState } from 'react';

/** A tag or concept as the editor shows it: its own label is the default locale's. */
export interface EditableTerm {
  readonly label: string;
  readonly slug: string;
  readonly description: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly usage: TermUsageSummary;
}

/** What Save sends: the label, and only the term fields that changed. */
export type TermChanges = { label?: string } & TermFields;

/** What changed between the term as loaded and the form. */
export function termChanges(
  term: EditableTerm,
  form: { label: string; slug: string; description: string; labels: Record<string, string> },
): TermChanges {
  const out: { -readonly [K in keyof TermChanges]: TermChanges[K] } = {};
  if (form.label.trim() !== term.label) out.label = form.label.trim();
  if (form.slug.trim() !== term.slug) out.slug = form.slug.trim();
  if (form.description.trim() !== (term.description ?? '')) {
    out.description = form.description.trim() || null;
  }
  const labels = Object.fromEntries(
    Object.entries(form.labels)
      .map(([locale, label]) => [locale, label.trim()] as const)
      .filter(([, label]) => label),
  );
  const same =
    Object.keys(labels).length === Object.keys(term.labels).length &&
    Object.entries(labels).every(([locale, label]) => term.labels[locale] === label);
  if (!same) out.labels = labels;
  return out;
}

/**
 * Edits a tag's or concept's label, slug, description and its labels in the space's other
 * locales, in a sheet from the side (from the bottom on a phone). It says how many published
 * entries carry the term, and that the slug, which archive URLs use, stays when the label changes.
 */
export function TermEditor({
  kind,
  term,
  locales,
  defaultLocale,
  busy,
  onSave,
  onOpenChange,
}: {
  kind: 'tag' | 'concept';
  /** The term being edited, or null when the sheet is closed. */
  term: EditableTerm | null;
  /** The space's locales; the default's label is the term's own. */
  locales: readonly string[];
  defaultLocale: string;
  busy: boolean;
  onSave: (changes: TermChanges) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
}) {
  const [dirty, setDirty] = useState(false);
  // Its own write, not `busy`, which any action on the page sets.
  const [saving, setSaving] = useState(false);
  const guard = useDiscardGuard({ open: term !== null, dirty, saving, onOpenChange });
  const [error, setError] = useState<string>();
  const save = async (changes: TermChanges) => {
    setSaving(true);
    setError(undefined);
    try {
      await onSave(changes);
    } catch (err) {
      setError(guard.saveFailed(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Sheet open={term !== null} onOpenChange={guard.onOpenChange}>
      <ResponsiveSheetContent className="sm:max-w-md" bodyClassName="gap-0">
        <SheetHeader className="gap-1 border-b pt-4 pb-3">
          <SheetTitle>{term ? `Edit “${term.label}”` : 'Edit'}</SheetTitle>
          <SheetDescription className="text-xs">
            {term ? usageLine(term.usage) : null}
          </SheetDescription>
        </SheetHeader>
        {term ? (
          // Keyed by the term, so opening another starts from its values.
          <TermForm
            key={`${term.slug}:${term.label}`}
            kind={kind}
            term={term}
            locales={locales}
            defaultLocale={defaultLocale}
            busy={busy}
            onSave={(changes) => void save(changes)}
            guard={guard}
            error={error}
            onDirty={setDirty}
          />
        ) : null}
      </ResponsiveSheetContent>
    </Sheet>
  );
}

/** "Carried by 3 published entries: 2 Article, 1 Page", or that none carries it yet. */
export function usageLine(usage: TermUsageSummary): string {
  if (usage.count === 0) return 'No published entry carries it yet.';
  const by = Object.entries(usage.byContentType)
    .map(([type, n]) => `${n} ${type}`)
    .join(', ');
  return `Carried by ${usage.count} published ${usage.count === 1 ? 'entry' : 'entries'}: ${by}.`;
}

function TermForm({
  kind,
  term,
  locales,
  defaultLocale,
  busy,
  onSave,
  guard,
  error,
  onDirty,
}: {
  kind: 'tag' | 'concept';
  term: EditableTerm;
  locales: readonly string[];
  defaultLocale: string;
  busy: boolean;
  onSave: (changes: TermChanges) => void;
  guard: DiscardGuard;
  error: string | undefined;
  onDirty: (dirty: boolean) => void;
}) {
  const id = useId();
  const [label, setLabel] = useState(term.label);
  const [slug, setSlug] = useState(term.slug);
  const [description, setDescription] = useState(term.description ?? '');
  const [labels, setLabels] = useState<Record<string, string>>({ ...term.labels });
  const others = locales.filter((l) => l !== defaultLocale);
  const changes = termChanges(term, { label, slug, description, labels });
  const changed = Object.keys(changes).length > 0;
  useEffect(() => {
    onDirty(changed);
    return () => onDirty(false);
  }, [changed, onDirty]);

  return (
    <form
      className="space-y-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && label.trim()) onSave(changes);
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-label`}>
          {kind === 'tag' ? 'Name' : 'Preferred label'}{' '}
          <span className="font-mono text-muted-foreground text-xs">{defaultLocale}</span>
        </Label>
        <Input
          id={`${id}-label`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-slug`}>Slug</Label>
        <Input
          id={`${id}-slug`}
          className="font-mono"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          aria-describedby={`${id}-slug-hint`}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <p id={`${id}-slug-hint`} className="max-w-measure text-muted-foreground text-xs">
          Archive pages find the {kind} by it. It stays when the {kind === 'tag' ? 'name' : 'label'}{' '}
          changes; changing it moves those pages.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-description`}>Description</Label>
        <Textarea
          id={`${id}-description`}
          value={description}
          rows={3}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      {others.length > 0 ? (
        <fieldset className="space-y-3">
          <legend className="caption mb-2 text-muted-foreground">Labels in other locales</legend>
          {others.map((locale) => (
            <div key={locale} className="space-y-1.5">
              <Label htmlFor={`${id}-label-${locale}`} className="font-mono">
                {locale}
              </Label>
              <Input
                id={`${id}-label-${locale}`}
                value={labels[locale] ?? ''}
                placeholder={label}
                onChange={(e) => setLabels((l) => ({ ...l, [locale]: e.target.value }))}
              />
            </div>
          ))}
          <p className="max-w-measure text-muted-foreground text-xs">
            Left empty, a locale shows its fallback’s label, then the {defaultLocale} one.
          </p>
        </fieldset>
      ) : null}
      {error && <DialogError>{error}</DialogError>}
      <SheetFooter className="-mx-4 -mb-4">
        <DiscardAsk guard={guard} message={`Discard your changes to “${term.label}”?`}>
          <GuardCancel guard={guard} />
          <Button type="submit" disabled={!changed || !label.trim() || busy}>
            Save {kind}
          </Button>
        </DiscardAsk>
      </SheetFooter>
    </form>
  );
}
