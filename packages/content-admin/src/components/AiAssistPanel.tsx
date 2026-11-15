import {
  Confirmation,
  ProposedValue,
} from '@commerceworker/content-admin/components/ai/Confirmation';
import { Task, TaskItem } from '@commerceworker/content-admin/components/ai/Task';
import { CollapsibleCard } from '@commerceworker/content-admin/components/CollapsibleCard';
import { ToneBadge } from '@commerceworker/content-admin/components/status';
import { humanize } from '@commerceworker/content-admin/lib/format';
import type { ContentType, EntryFields } from '@commerceworker/domain';
import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import { type ComposeIcon, ComposeLoader, composeIcons } from '@commerceworker/ui/compose-loader';
import { Label } from '@commerceworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { useState } from 'react';
import { useClient } from '../lib/client-context';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

type Finding = {
  field?: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  suggestedAction: string;
};
const SEVERITY_TONE = {
  error: 'bad',
  warning: 'wait',
  info: 'idle',
} as const;

const TEXT_TYPES = new Set(['Symbol', 'Text']);
const SCALAR_TYPES = new Set(['Symbol', 'Text', 'Integer', 'Number', 'Boolean', 'Date']);

/**
 * An AI result awaiting the editor's review — nothing is written until Apply.
 * `operation` + `steps` are its provenance: which assist ran and what it did,
 * so the editor can judge the proposal, not just its output.
 */
type Proposal = { operation: string; steps: string[] } & (
  | {
      kind: 'fields';
      title: string;
      items: { label: string; preview: string }[];
      patch: EntryFields;
    }
  | { kind: 'tags'; title: string; tagIds: string[]; newTags: string[] }
);

function previewOf(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

/**
 * AI Content OS panel for an entry: translate localized fields, summarize into a
 * field, autofill a field, or suggest taxonomy tags. Each op runs through the
 * same governed use-cases as the API — always as a proposal first: the result is
 * shown for review and only merged into the editor form (or, for tags, applied
 * server-side) when the editor clicks Apply.
 */
export function AiAssistPanel(props: {
  entryId: string;
  contentType: ContentType;
  locales: readonly string[];
  defaultLocale: string;
  /** Merges reviewed field values into the live editor form (unsaved). */
  onMergeFields: (fields: EntryFields) => void;
}) {
  const { entryId, contentType, locales, defaultLocale, onMergeFields } = props;
  const { client } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  // Vocabulary names, so a tags proposal is reviewable (ids alone are not).
  const tagsQuery = useScopedQuery(['tags'], () => client.listTags());
  const tagName = (id: string) => tagsQuery.data?.find((t) => t.id === id)?.name ?? id;
  const otherLocales = locales.filter((l) => l !== defaultLocale);
  const textFields = contentType.fields.filter((f) => TEXT_TYPES.has(f.type));
  const scalarFields = contentType.fields.filter((f) => SCALAR_TYPES.has(f.type));
  const fieldName = (apiId: string) =>
    contentType.fields.find((f) => f.apiId === apiId)?.name ?? apiId;

  const [target, setTarget] = useState(otherLocales[0] ?? '');
  const [summaryField, setSummaryField] = useState(textFields[0]?.apiId ?? '');
  const [autofill, setAutofill] = useState(scalarFields[0]?.apiId ?? '');
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const working = busy !== null && busy !== 'apply';
  /** The loader for a task's button while that task runs. */
  const runs = (label: string, icon: ComposeIcon) =>
    busy === label ? <ComposeLoader icon={icon} /> : null;

  const ok = (label: string, fn: () => Promise<void>) => async () => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const translate = ok('translate', async () => {
    const r = await client.translateEntry(entryId, { targetLocale: target, apply: false });
    if (r.translatedFields.length === 0) {
      toast.success('Nothing to translate');
      return;
    }
    const patch: EntryFields = {};
    const items: { label: string; preview: string }[] = [];
    for (const apiId of r.translatedFields) {
      const value = r.fields[apiId]?.[target];
      if (value === undefined) continue;
      patch[apiId] = { [target]: value };
      items.push({ label: `${fieldName(apiId)} (${target})`, preview: previewOf(value) });
    }
    setProposal({
      kind: 'fields',
      operation: `Translate → ${target}`,
      steps: [
        `Read the entry's localized text fields (${defaultLocale})`,
        `Translated ${items.length} ${items.length === 1 ? 'field' : 'fields'} into ${target}`,
        'Proposes the translations below; nothing was written',
      ],
      title: `Apply ${items.length} translated ${items.length === 1 ? 'field' : 'fields'}?`,
      items,
      patch,
    });
  });

  const summarize = ok('summarize', async () => {
    const r = await client.summarizeEntry(entryId, { targetField: summaryField, apply: false });
    setProposal({
      kind: 'fields',
      operation: `Summarize → ${fieldName(summaryField)}`,
      steps: [
        'Read the entry draft',
        `Wrote a summary for ${fieldName(summaryField)} (${defaultLocale})`,
        'Proposes the value below; nothing was written',
      ],
      title: `Apply summary to ${fieldName(summaryField)}?`,
      items: [
        { label: `${fieldName(summaryField)} (${defaultLocale})`, preview: previewOf(r.summary) },
      ],
      patch: { [summaryField]: { [defaultLocale]: r.summary } },
    });
  });

  const fill = ok('autofill', async () => {
    const r = await client.autofillField(entryId, { field: autofill, apply: false });
    setProposal({
      kind: 'fields',
      operation: `Autofill → ${fieldName(r.field)}`,
      steps: [
        'Read the entry draft and the field definition',
        `Generated a value for ${fieldName(r.field)} (${defaultLocale})`,
        'Proposes the value below; nothing was written',
      ],
      title: `Apply value to ${fieldName(r.field)}?`,
      items: [{ label: `${fieldName(r.field)} (${defaultLocale})`, preview: previewOf(r.value) }],
      patch: { [r.field]: { [defaultLocale]: r.value } },
    });
  });

  const tag = ok('tags', async () => {
    const r = await client.suggestEntryTags(entryId, { apply: false });
    if (r.tagIds.length === 0 && r.newTags.length === 0) {
      toast.success('No tags suggested');
      return;
    }
    const count = r.tagIds.length + r.newTags.length;
    setProposal({
      kind: 'tags',
      operation: 'Classify',
      steps: [
        'Read the entry and the space taxonomy',
        `Matched ${r.tagIds.length} existing ${r.tagIds.length === 1 ? 'tag' : 'tags'}`,
        ...(r.newTags.length
          ? [`Suggested ${r.newTags.length} new ${r.newTags.length === 1 ? 'tag' : 'tags'}`]
          : []),
      ],
      title: `Apply ${count} ${count === 1 ? 'tag' : 'tags'}?`,
      tagIds: r.tagIds,
      newTags: r.newTags,
    });
  });

  const applyProposal = ok('apply', async () => {
    if (!proposal) return;
    if (proposal.kind === 'fields') {
      onMergeFields(proposal.patch);
      toast.success('Applied to the form. Save the draft to keep it');
    } else {
      // Persist EXACTLY the reviewed suggestion — never re-run the model at
      // apply time, or what lands could differ from what was approved.
      const r = await client.applyEntryTags(entryId, {
        tagIds: [...proposal.tagIds],
        newTags: [...proposal.newTags],
      });
      // The metadata panel's chips and the vocabulary both changed server-side;
      // without invalidation its stale Save would silently un-apply the tags.
      await invalidate(['entry-metadata', entryId], ['tags']);
      toast.success(
        r.createdTags.length
          ? `Tagged · new: ${r.createdTags.map((t) => t.name).join(', ')}`
          : `Applied ${r.tagIds.length} tag(s)`,
      );
    }
    setProposal(null);
  });

  const audit = ok('audit', async () => {
    const r = await client.auditEntry(entryId);
    setFindings(r.findings);
    toast.success(`${r.findings.length} finding(s)`);
  });

  const createTasks = ok('tasks-create', async () => {
    const r = await client.auditEntry(entryId, { createTasks: true, taskSeverity: 'warning' });
    setFindings(r.findings);
    toast.success(`Created ${r.taskIds.length} work-package task(s)`);
  });

  return (
    <CollapsibleCard
      title={
        <>
          {/* The mark at rest; it composes itself while a task runs. */}
          <ComposeLoader playing={working} className="text-ai" /> AI assist
        </>
      }
      description="Translate, summarize, autofill, and classify. Every result is proposed for your review before anything is written."
      contentClassName="space-y-3"
    >
      {otherLocales.length > 0 && (
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label className="text-muted-foreground text-xs">Translate to</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger aria-label="Translate to" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {otherLocales.map((l) => (
                  <SelectItem key={l} value={l}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" size="sm" disabled={!target || busy !== null} onClick={translate}>
            {runs('translate', composeIcons.write)}
            {busy === 'translate' ? 'Translating…' : 'Translate'}
          </Button>
        </div>
      )}

      {textFields.length > 0 && (
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label className="text-muted-foreground text-xs">Summarize into</Label>
            <Select value={summaryField} onValueChange={setSummaryField}>
              <SelectTrigger aria-label="Summarize into" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {textFields.map((f) => (
                  <SelectItem key={f.apiId} value={f.apiId}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={!summaryField || busy !== null}
            onClick={summarize}
          >
            {runs('summarize', composeIcons.write)}
            {busy === 'summarize' ? 'Summarizing…' : 'Summarize'}
          </Button>
        </div>
      )}

      {scalarFields.length > 0 && (
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label className="text-muted-foreground text-xs">Autofill field</Label>
            <Select value={autofill} onValueChange={setAutofill}>
              <SelectTrigger aria-label="Autofill field" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {scalarFields.map((f) => (
                  <SelectItem key={f.apiId} value={f.apiId}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" size="sm" disabled={!autofill || busy !== null} onClick={fill}>
            {runs('autofill', composeIcons.schema)}
            {busy === 'autofill' ? 'Autofilling…' : 'Autofill'}
          </Button>
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        disabled={busy !== null}
        onClick={tag}
      >
        {runs('tags', composeIcons.search)}
        {busy === 'tags' ? 'Classifying…' : 'Suggest taxonomy tags'}
      </Button>

      {proposal && (
        <Confirmation
          title={proposal.title}
          note={
            proposal.kind === 'fields'
              ? 'Fills the form; nothing is saved until you save the draft.'
              : 'Assigns the tags to this entry now.'
          }
          provenance={
            <Task title={`AI assist · ${proposal.operation}`}>
              {proposal.steps.map((step) => (
                <TaskItem key={step}>{step}</TaskItem>
              ))}
            </Task>
          }
          busy={busy !== null}
          applyLabel={busy === 'apply' ? 'Applying…' : 'Apply'}
          onApply={applyProposal}
          onDismiss={() => setProposal(null)}
        >
          {proposal.kind === 'fields' ? (
            <div className="space-y-2">
              {proposal.items.map((item) => (
                <ProposedValue key={item.label} label={item.label}>
                  {item.preview}
                </ProposedValue>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {proposal.newTags.map((t) => (
                <Badge key={t} variant="secondary">
                  {t} (new)
                </Badge>
              ))}
              {proposal.tagIds.map((id) => (
                <Badge key={id} variant="outline">
                  {tagName(id)}
                </Badge>
              ))}
            </div>
          )}
        </Confirmation>
      )}

      <div className="space-y-2 border-t pt-3">
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={busy !== null}
            onClick={audit}
          >
            {runs('audit', composeIcons.search)}
            {busy === 'audit' ? 'Auditing…' : 'Audit entry'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={busy !== null}
            onClick={createTasks}
          >
            {runs('tasks-create', composeIcons.workflow)}
            {busy === 'tasks-create' ? 'Creating…' : 'Audit → tasks'}
          </Button>
        </div>
        {findings && findings.length === 0 && (
          <p className="text-muted-foreground text-sm">No issues found.</p>
        )}
        {findings && findings.length > 0 && (
          <ul className="space-y-1.5">
            {findings.map((f) => (
              <li key={`${f.severity}:${f.message}`} className="text-sm">
                <div className="flex items-center gap-1.5">
                  <ToneBadge tone={SEVERITY_TONE[f.severity]} label={humanize(f.severity)} />
                  {f.field && (
                    <span className="font-mono text-muted-foreground text-xs">{f.field}</span>
                  )}
                </div>
                <p>{f.message}</p>
                <p className="text-muted-foreground text-xs">→ {f.suggestedAction}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </CollapsibleCard>
  );
}
