import {
  builtinNodeRegistry,
  type GraphIssue,
  validateGraph,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowVersion,
} from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent } from '@commerceworker/ui/card';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@commerceworker/ui/dropdown-menu';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@commerceworker/ui/field';
import { Input } from '@commerceworker/ui/input';
import { Item, ItemContent, ItemMedia, ItemTitle } from '@commerceworker/ui/item';
import { cn } from '@commerceworker/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Skeleton } from '@commerceworker/ui/skeleton';
import { Switch } from '@commerceworker/ui/switch';
import { Textarea } from '@commerceworker/ui/textarea';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Redo2,
  Rocket,
  Save,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useParams } from 'react-router';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { LoadingStatus } from '~/cms/components/loading';
import { Body, PageHeader, Section } from '~/cms/components/page';
import { When } from '~/cms/components/when';
import { Connections } from '~/cms/components/workflow/Connections';
import { CopilotDialog } from '~/cms/components/workflow/CopilotDialog';
import { FlowCanvas } from '~/cms/components/workflow/FlowCanvas';
import { graphChanges, makeNode } from '~/cms/components/workflow/graph';
import { useEditHistory } from '~/cms/components/workflow/history';
import { Inspector, type InspectorOptions } from '~/cms/components/workflow/Inspector';
import { Palette } from '~/cms/components/workflow/Palette';
import { ProposalBanner, type WorkflowProposal } from '~/cms/components/workflow/ProposalBanner';
import { useAssistantIfAny } from '~/cms/lib/assistant';
import { useClient } from '~/cms/lib/client-context';
import { useMedia, WIDE } from '~/cms/lib/device';
import { plural } from '~/cms/lib/format';
import type { WorkflowSummary } from '~/cms/lib/management';
import { useContentTypesQuery, useInvalidate, useScopedQuery } from '~/cms/lib/queries';
import { type ShortcutGroup, useModKeyLabel, usePageShortcuts } from '~/cms/lib/shortcuts';

/*
 * The workflow editor: palette, canvas and inspector side by side at lg; the checks list (the
 * same `validateGraph` the server runs) with every error also flagged on its node; edit history in
 * 400 ms bursts (⌘Z / ⇧⌘Z); ⌘S saves the draft; leaving with unsaved changes asks first. Below lg
 * it is review-only and says so.
 *
 * - Save and Publish call the workflow routes directly (assistant-driven writes are PR 11).
 *   Publish asks in place, bound to the draft on screen: any edit while it is open withdraws the
 *   question. With errors it is refused and the errors are listed, rather than silently disabled.
 * - The settings are the content types the workflow covers and whether it gates single-entry
 *   publishing.
 * - A version picker shows any published version read-only.
 * - "Test run" waits for runs in the admin (PR 8); "Change with AI" calls the copilot route and
 *   previews its proposal on the canvas under the `ProposalBanner` (the seam PR 11's
 *   `propose_workflow_change` uses).
 */

/** The editable part of a workflow. */
interface Draft {
  name: string;
  description: string;
  contentTypes: string[];
  gatesPublish: boolean;
  graph: WorkflowGraph;
}

const toDraft = (w: WorkflowSummary): Draft => ({
  name: w.name,
  description: w.description,
  contentTypes: [...w.contentTypes],
  gatesPublish: w.gatesPublish,
  graph: w.graph,
});

export const WORKFLOW_EDITOR_SHORTCUTS: ShortcutGroup = {
  id: 'workflow-editor',
  title: 'Workflow editor',
  items: [
    { keys: ['Mod', 'S'], chord: true, label: 'Save draft' },
    { keys: ['Mod', 'Z'], chord: true, label: 'Undo' },
    { keys: ['Shift', 'Mod', 'Z'], chord: true, label: 'Redo' },
    { keys: ['Delete'], label: 'Delete the selected step or connection' },
    { keys: ['L'], label: 'Tidy layout' },
    { keys: ['Shift', '1'], chord: true, label: 'Fit view' },
    { keys: ['F'], label: 'Expand or collapse the canvas' },
    { keys: ['Esc'], label: 'Deselect' },
  ],
};

export function WorkflowEditor() {
  const { id = '' } = useParams();
  const { client } = useClient();
  const query = useScopedQuery(['workflow', id], () => client.getWorkflow(id));
  if (query.isPending) {
    return <EditorSkeleton />;
  }
  if (!query.data) {
    return (
      <Body>
        <PageHeader
          title="Workflow not available"
          description="It may have been deleted, or it isn’t in this environment."
        />
        <Link to="/workflows" className="text-link text-sm hover:underline">
          Back to workflows
        </Link>
      </Body>
    );
  }
  return <Editor key={query.data.id} loaded={query.data} />;
}

/** The editor's frame while the workflow loads: its header, then palette, canvas and inspector. */
export function EditorSkeleton() {
  return (
    <div className="flex flex-col lg:h-[calc(100dvh-var(--shell-h))] lg:pb-safe-0" aria-busy="true">
      <LoadingStatus>Loading the workflow</LoadingStatus>
      <div className="flex items-center gap-3 border-b px-4 py-2.5 sm:px-5">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-40" />
        <Skeleton className="ml-auto hidden h-8 w-48 lg:block" />
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[220px_minmax(0,1fr)_340px]">
        <div className="hidden min-h-0 border-r p-3 lg:block">
          <Skeleton className="h-full" />
        </div>
        <div className="h-[60vh] min-h-[360px] p-3 lg:h-auto lg:min-h-0">
          <Skeleton className="h-full" />
        </div>
        <div className="hidden min-h-0 border-l p-4 lg:block">
          <Skeleton className="h-full" />
        </div>
      </div>
    </div>
  );
}

function Editor({ loaded }: { loaded: WorkflowSummary }) {
  const { client } = useClient();
  const invalidate = useInvalidate();
  const mod = useModKeyLabel();
  usePageShortcuts(WORKFLOW_EDITOR_SHORTCUTS);
  // Narrower screens get a review-only view: nothing there can change the workflow, since its
  // Save and Publish live in the full editor.
  const wide = useMedia(WIDE);

  const history = useEditHistory<Draft>(toDraft(loaded));
  const { value: flow, set: setFlow, undo, redo, ref: flowRef } = history;
  const [baseline, setBaseline] = useState(() => JSON.stringify(toDraft(loaded)));
  const dirty = JSON.stringify(flow) !== baseline;
  const [selected, setSelected] = useState<string | null>(null);
  const [latest, setLatest] = useState(loaded.latestVersion);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [working, setWorking] = useState<null | 'save' | 'publish'>(null);
  const [proposal, setProposal] = useState<WorkflowProposal | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  /** The draft (as JSON) the open Publish question is about; null when it isn't open. */
  const [publishFor, setPublishFor] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<readonly GraphIssue[] | null>(null);
  /** A published version being looked at, read-only; null shows the draft. */
  const [viewing, setViewing] = useState<number | null>(null);
  const publishStatusId = useId();
  const descriptionId = useId();
  const gatesId = useId();
  const gatesHintId = useId();
  const refusalRef = useRef<HTMLDivElement>(null);

  const versionsQuery = useScopedQuery(['workflow', loaded.id, 'versions'], () =>
    client.listWorkflowVersions(loaded.id),
  );
  const versions = versionsQuery.data ?? [];
  const latestPublished = versions.find((v) => v.version === latest) ?? null;
  const viewedQuery = useScopedQuery(
    ['workflow', loaded.id, 'versions', viewing],
    () => client.getWorkflowVersion(loaded.id, viewing as number),
    { enabled: viewing !== null },
  );
  const viewed: WorkflowVersion | null = viewing !== null ? (viewedQuery.data ?? null) : null;

  const typesQuery = useContentTypesQuery();
  const releasesQuery = useScopedQuery(['releases'], () => client.listReleases());
  const options: InspectorOptions = useMemo(() => {
    const types = typesQuery.data ?? [];
    const covered = flow.contentTypes.length
      ? types.filter((t) => flow.contentTypes.includes(t.apiId))
      : types;
    return {
      contentTypes: types.map((t) => ({ apiId: t.apiId, name: t.name })),
      fields: covered.flatMap((t) =>
        t.fields.map((f) => ({ apiId: f.apiId, name: f.name, contentType: t.name })),
      ),
      releases: (releasesQuery.data ?? [])
        .filter((r) => r.status !== 'published')
        .map((r) => ({ id: r.id, title: r.title })),
    };
  }, [typesQuery.data, releasesQuery.data, flow.contentTypes]);

  const nodes = builtinNodeRegistry;
  const issues = useMemo(() => validateGraph(flow.graph, nodes), [flow.graph]);
  const nodeIssues = useMemo(() => {
    const byNode: Record<string, string[]> = {};
    for (const e of issues.errors) {
      if (!e.nodeId) continue;
      byNode[e.nodeId] = [...(byNode[e.nodeId] ?? []), e.message];
    }
    return byNode;
  }, [issues]);
  const firstIssue = useMemo(
    () => Object.fromEntries(Object.entries(nodeIssues).map(([k, v]) => [k, v[0] ?? ''])),
    [nodeIssues],
  );
  const node = selected
    ? (viewed ? viewed.graph : flow.graph).nodes.find((n) => n.id === selected)
    : undefined;
  // With Coworker open, the inspector gives the canvas its width until a step is picked.
  const inspectorCollapsed = Boolean(useAssistantIfAny()?.open) && !node;

  const setGraph = useCallback(
    (g: WorkflowGraph) => setFlow((f) => ({ ...f, graph: g })),
    [setFlow],
  );

  // Any edit withdraws an open Publish question: it was asked about the draft as it was.
  useEffect(() => {
    if (publishFor !== null && publishFor !== JSON.stringify(flow)) setPublishFor(null);
  }, [flow, publishFor]);

  const save = useCallback(async (): Promise<boolean> => {
    const f = flowRef.current;
    setWorking('save');
    setNotice(null);
    try {
      const { validation } = await client.saveWorkflowDraft(loaded.id, f);
      setBaseline(JSON.stringify(f));
      setNotice({
        tone: validation.errors.length ? 'warn' : 'ok',
        text: validation.errors.length
          ? `Draft saved · ${plural(validation.errors.length, 'check')} to fix before publishing`
          : 'Draft saved',
      });
      await invalidate(['workflows'], ['workflow', loaded.id]);
      return true;
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      setWorking(null);
    }
  }, [client, flowRef, invalidate, loaded.id]);

  const askPublish = () => {
    setNotice(null);
    if (issues.errors.length) {
      setPublishFor(null);
      setRefusal(issues.errors);
      requestAnimationFrame(() => refusalRef.current?.focus());
      return;
    }
    setRefusal(null);
    setPublishFor(JSON.stringify(flowRef.current));
  };

  const publish = async () => {
    const asked = publishFor;
    setPublishFor(null);
    if (asked === null || asked !== JSON.stringify(flowRef.current)) return;
    // Saving first is what binds the publish to the draft on screen: the route publishes the
    // saved draft.
    if (asked !== baseline && !(await save())) return;
    setWorking('publish');
    try {
      const v = await client.publishWorkflowVersion(loaded.id);
      setLatest(v.version);
      setNotice({ tone: 'ok', text: `Published v${v.version}` });
      await invalidate(['workflows'], ['workflow', loaded.id]);
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setWorking(null);
    }
  };

  // ⌘S saves, ⌘Z / ⇧⌘Z undo and redo graph edits (text fields keep their own undo), Escape
  // deselects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
      if (!wide || viewing !== null) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
        return;
      }
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, select');
      if (mod && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if (mod && e.key.toLowerCase() === 'y' && !typing) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, undo, redo, wide, viewing]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const changes = useMemo(
    () => graphChanges(latestPublished?.graph ?? null, flow.graph),
    [latestPublished, flow.graph],
  );
  const unpublished =
    !latest ||
    changes.total > 0 ||
    (latestPublished !== null &&
      (latestPublished.name !== flow.name ||
        latestPublished.description !== flow.description ||
        (latestPublished.gatesPublish ?? false) !== flow.gatesPublish ||
        latestPublished.contentTypes.join() !== flow.contentTypes.join()));

  const addNode = (type: string, position?: { x: number; y: number }) => {
    const g = flowRef.current.graph;
    const anchor = node ?? g.nodes.at(-1);
    const pos =
      position ??
      (anchor ? { x: anchor.position.x + 280, y: anchor.position.y } : { x: 56, y: 160 });
    const n = makeNode(nodes, g, type, pos);
    setFlow((f) => {
      const edges = [...f.graph.edges];
      // Picking a palette item with a step selected wires it in after that step, when the step's
      // default output is still free.
      if (!position && node && node.type !== 'control.end') {
        const outs = nodes.outputs(node.type, nodes.withDefaults(node.type, node.config));
        const free = outs.length === 1 && !f.graph.edges.some((e) => e.source === node.id);
        if (free && !n.type.startsWith('trigger.')) {
          const handle = outs[0] === 'out' ? null : (outs[0] ?? null);
          edges.push({
            id: `${node.id}${handle ? `.${handle}` : ''}-${n.id}`,
            source: node.id,
            target: n.id,
            sourceHandle: handle,
            targetHandle: null,
          });
        }
      }
      return { ...f, graph: { nodes: [...f.graph.nodes, n], edges } };
    });
    setSelected(n.id);
  };

  const updateNode = (n: WorkflowNode) =>
    setFlow((f) => ({
      ...f,
      graph: { ...f.graph, nodes: f.graph.nodes.map((x) => (x.id === n.id ? n : x)) },
    }));
  const deleteNode = (nodeId: string) => {
    setFlow((f) => ({
      ...f,
      graph: {
        nodes: f.graph.nodes.filter((n) => n.id !== nodeId),
        edges: f.graph.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      },
    }));
    setSelected(null);
  };

  const readOnly = !wide || viewing !== null;
  const shownGraph = viewed ? viewed.graph : proposal ? proposal.graph : flow.graph;
  const types = typesQuery.data ?? [];

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-var(--shell-h))] lg:pb-safe-0">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5 sm:px-5">
        <div className="min-w-0">
          {/* From md the shell's breadcrumbs hold the way back; below it this does. */}
          <div className="caption md:hidden">
            <Link to="/workflows" className="hover:text-foreground hover:underline">
              Workflows
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={flow.name}
              onChange={(e) => setFlow((f) => ({ ...f, name: e.target.value }))}
              readOnly={readOnly}
              className="h-8 w-full border-transparent bg-transparent px-1 font-semibold text-lg tracking-title hover:border-input sm:w-64"
              aria-label="Workflow name"
            />
            {/* The content types the trigger covers: one control instead of a row of toggles. */}
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex h-8 max-w-72 items-center gap-1.5 rounded-4xl border border-input bg-input/30 px-3 text-xs hover:bg-input/50">
                <span className="text-muted-foreground">Covers:</span>
                <span className="truncate">
                  {flow.contentTypes.length
                    ? flow.contentTypes
                        .map((c) => types.find((t) => t.apiId === c)?.name ?? c)
                        .join(', ')
                    : 'Every content type'}
                </span>
                <ChevronDown
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {types.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.apiId}
                    checked={flow.contentTypes.includes(t.apiId)}
                    disabled={readOnly}
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={(on) =>
                      setFlow((f) => ({
                        ...f,
                        contentTypes: on
                          ? types
                              .map((x) => x.apiId)
                              .filter((x) => x === t.apiId || f.contentTypes.includes(x))
                          : f.contentTypes.filter((x) => x !== t.apiId),
                      }))
                    }
                  >
                    {t.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <VersionPicker
              versions={versions}
              viewing={viewing}
              onView={(v) => {
                setViewing(v);
                setSelected(null);
              }}
            />
            {/* Also why Publish refuses: screen readers get it from here. */}
            <span id={publishStatusId} className="text-muted-foreground text-xs">
              {latest ? `Published v${latest}` : 'Not published'}
              {issues.errors.length
                ? ' · fix the checks to publish'
                : latest
                  ? unpublished
                    ? ' · changes not published'
                    : ' · up to date'
                  : ''}
            </span>
            {dirty ? (
              <span className="rounded-full bg-wait/15 px-1.5 py-0.5 font-medium text-wait text-xs">
                Unsaved
              </span>
            ) : null}
          </div>
        </div>
        <h1 className="sr-only">{flow.name}</h1>
        <span className="sr-only" aria-live="polite">
          {history.announce}
        </span>
        {/* Editing actions need the full editor; narrower screens get a review-only view. */}
        {wide && viewing === null ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {notice ? (
              <span
                role="status"
                className={cn(
                  'text-sm',
                  notice.tone === 'ok'
                    ? 'text-ok'
                    : notice.tone === 'warn'
                      ? 'text-wait'
                      : 'text-bad',
                )}
              >
                {notice.text}
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCopilotOpen(true)}
              disabled={!!proposal}
            >
              Change with AI
            </Button>
            <div className="flex">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={!history.canUndo}
                onClick={undo}
                aria-label={`Undo (${mod}Z)`}
                title={`Undo (${mod}Z)`}
              >
                <Undo2 aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={!history.canRedo}
                onClick={redo}
                aria-label={`Redo (⇧${mod}Z)`}
                title={`Redo (⇧${mod}Z)`}
              >
                <Redo2 aria-hidden="true" />
              </Button>
            </div>
            {/* Only while there is something to discard: a dead button beside Save reads as noise. */}
            {dirty ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setFlow(JSON.parse(baseline) as Draft)}
                title="Back to the last saved draft (undoable)"
              >
                Discard changes
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!!working}
              onClick={() => void save()}
              title={`Save draft (${mod}S)`}
            >
              <Save aria-hidden="true" /> {working === 'save' ? 'Saving…' : 'Save draft'}
            </Button>
            <Button
              type="button"
              size="sm"
              id="workflow-publish"
              disabled={!!working || (!unpublished && !dirty)}
              onClick={askPublish}
              aria-describedby={publishStatusId}
              aria-expanded={publishFor !== null}
              title={
                !unpublished && !dirty ? `Nothing new to publish: v${latest} is up to date` : ''
              }
            >
              <Rocket aria-hidden="true" /> {working === 'publish' ? 'Publishing…' : 'Publish'}
            </Button>
          </div>
        ) : null}
      </header>

      {publishFor !== null ? (
        <InlineConfirm
          className="rounded-none border-b px-5"
          message={`Publish “${flow.name}” as v${(latest ?? 0) + 1}?`}
          note={
            latest
              ? `${changes.summary || 'Settings changed'}. Runs already started stay on the version they began with.`
              : 'Runs start on it from now on.'
          }
          onCancel={() => setPublishFor(null)}
          returnFocus={() => document.getElementById('workflow-publish')}
        >
          <Button type="button" size="sm" onClick={() => void publish()}>
            {dirty ? 'Save and publish' : 'Publish'}
          </Button>
        </InlineConfirm>
      ) : null}

      {refusal ? (
        <div
          ref={refusalRef}
          tabIndex={-1}
          role="alert"
          className="border-b bg-bad/10 px-5 py-2.5 text-sm outline-none"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium text-bad">
              Can’t publish yet: {plural(refusal.length, 'check')} to fix.
            </p>
            <Button type="button" size="xs" variant="ghost" onClick={() => setRefusal(null)}>
              Dismiss
            </Button>
          </div>
          {/* However many checks fail, the canvas keeps its row: the list scrolls, the page doesn't. */}
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-bad lg:max-h-40 lg:overflow-y-auto">
            {refusal.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: issues can repeat a message
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {blocker.state === 'blocked' ? (
        <InlineConfirm
          className="rounded-none border-b bg-wait/10 px-5"
          message="This workflow has unsaved changes. Leave without saving them?"
          cancelLabel="Stay"
          onCancel={() => blocker.reset?.()}
        >
          <Button type="button" size="sm" variant="outline" onClick={() => blocker.proceed?.()}>
            Leave without saving
          </Button>
        </InlineConfirm>
      ) : null}

      {!wide ? (
        <p className="border-b bg-muted/50 px-4 py-2 text-muted-foreground text-sm">
          Building workflows needs a wider screen. Here you can review the graph and its settings.
        </p>
      ) : null}

      {viewing !== null ? (
        <div className="flex flex-wrap items-center gap-3 border-b bg-muted/50 px-5 py-2 text-sm">
          <span>
            Viewing <b className="font-semibold">v{viewing}</b>, read-only
            {viewed?.publishedAt ? (
              <>
                {' '}
                · published <When at={viewed.publishedAt} />
              </>
            ) : null}
            . Runs that started on it keep it.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => setViewing(null)}
          >
            Back to the draft
          </Button>
        </div>
      ) : null}

      {proposal && viewing === null ? (
        <div className="border-b px-5 py-2">
          <ProposalBanner
            proposal={proposal}
            base={flow.graph}
            onApply={() => {
              setGraph(proposal.graph);
              setProposal(null);
            }}
            onDismiss={() => setProposal(null)}
          />
        </div>
      ) : null}

      <div
        className={cn(
          'grid min-h-0 flex-1',
          wide && viewing === null
            ? inspectorCollapsed
              ? 'lg:grid-cols-[220px_minmax(0,1fr)]'
              : 'lg:grid-cols-[220px_minmax(0,1fr)_340px]'
            : inspectorCollapsed
              ? 'lg:grid-cols-[minmax(0,1fr)]'
              : 'lg:grid-cols-[minmax(0,1fr)_340px]',
        )}
      >
        {wide && viewing === null ? (
          <aside className="min-h-0 border-r p-3" aria-label="Palette">
            <Palette onPick={(t) => addNode(t)} />
          </aside>
        ) : null}
        <div className="h-[60vh] min-h-[360px] p-3 lg:h-auto lg:min-h-0">
          <FlowCanvas
            className="lg:min-h-0"
            graph={shownGraph}
            editable={!readOnly && !proposal}
            issues={proposal || viewed ? undefined : firstIssue}
            selectedId={selected}
            onSelect={setSelected}
            onChange={setGraph}
            onAddNode={(t, p) => addNode(t, p)}
            onRefuse={(m) => setNotice({ tone: 'warn', text: m })}
          />
        </div>
        <aside
          className={cn(
            'min-h-0 overflow-y-auto border-t p-4 lg:border-t-0 lg:border-l',
            inspectorCollapsed && 'lg:hidden',
          )}
          aria-label={node ? 'Step settings' : 'Workflow settings'}
        >
          {node && !proposal ? (
            <div className="flex flex-col gap-4">
              <Card className="min-w-0 [--card-spacing:--spacing(5)]">
                <CardContent>
                  <Inspector
                    node={node}
                    issues={viewed ? [] : (nodeIssues[node.id] ?? [])}
                    options={options}
                    onChange={readOnly ? undefined : updateNode}
                  />
                </CardContent>
              </Card>
              {!readOnly ? (
                <>
                  <Connections node={node} graph={flow.graph} onChange={setGraph} />
                  <div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-bad hover:text-bad"
                      onClick={() => deleteNode(node.id)}
                    >
                      <Trash2 aria-hidden="true" /> Delete step
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {viewing === null ? (
                <Section
                  title="Checks"
                  description="Errors block publishing; pick one to select its step."
                >
                  {issues.errors.length === 0 ? (
                    <div className="flex items-center gap-1.5 text-ok text-sm">
                      <CheckCircle2 className="size-4" aria-hidden="true" />{' '}
                      {unpublished ? 'Ready to publish' : `All checks pass; v${latest} is live`}
                    </div>
                  ) : null}
                  {issues.errors.length || issues.warnings.length ? (
                    <ul className="flex flex-col gap-1" aria-label="Checks">
                      {issues.errors.map((e, i) => (
                        <CheckItem
                          // biome-ignore lint/suspicious/noArrayIndexKey: issues can repeat a message
                          key={`e${i}`}
                          tone="bad"
                          message={e.message}
                          onPick={() => e.nodeId && setSelected(e.nodeId)}
                        />
                      ))}
                      {issues.warnings.map((e, i) => (
                        <CheckItem
                          // biome-ignore lint/suspicious/noArrayIndexKey: issues can repeat a message
                          key={`w${i}`}
                          tone="wait"
                          message={e.message}
                          onPick={() => e.nodeId && setSelected(e.nodeId)}
                        />
                      ))}
                    </ul>
                  ) : null}
                </Section>
              ) : null}
              <Card className="min-w-0 [--card-spacing:--spacing(5)]">
                <CardContent className="flex flex-col gap-4">
                  <Field className="gap-1.5">
                    <FieldLabel htmlFor={descriptionId} className="section-title">
                      Description
                    </FieldLabel>
                    <Textarea
                      id={descriptionId}
                      value={viewed ? viewed.description : flow.description}
                      onChange={(e) => setFlow((f) => ({ ...f, description: e.target.value }))}
                      readOnly={readOnly}
                      rows={4}
                    />
                  </Field>
                  <Field orientation="horizontal" className="items-start justify-between">
                    <FieldContent className="min-w-0">
                      <FieldLabel htmlFor={gatesId}>Gate publishing</FieldLabel>
                      <FieldDescription id={gatesHintId} className="text-xs leading-snug">
                        Entries it covers publish only through a run of this workflow.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id={gatesId}
                      checked={viewed ? (viewed.gatesPublish ?? false) : flow.gatesPublish}
                      disabled={readOnly}
                      onCheckedChange={(v) => setFlow((f) => ({ ...f, gatesPublish: v }))}
                      aria-describedby={gatesHintId}
                      className="mt-0.5"
                    />
                  </Field>
                </CardContent>
              </Card>
              <div className="max-w-[65ch] space-y-2 px-1 text-muted-foreground text-sm leading-relaxed">
                <p className="touch:hidden">
                  Drag steps from the palette, connect an output dot to an input, and press Delete
                  to remove a selection. From the keyboard: Enter on a palette item adds it after
                  the selected step, and a step’s Connections list wires its outputs.
                </p>
                <p className="hidden touch:block">
                  Tap a palette item to add it after the selected step. Drag from an output dot to
                  an input to connect, or use a step’s Connections list; Delete step is at the foot
                  of its settings.
                </p>
                <p>
                  Branches are the labelled outputs on each step. To repeat steps, use a{' '}
                  <b className="font-semibold">Loop</b> and connect the end of its body to its{' '}
                  <b className="font-semibold">next</b> input, the ring under the step.
                </p>
                <p>Publishing snapshots a new version. Runs keep the version they started on.</p>
              </div>
            </div>
          )}
        </aside>
      </div>

      <CopilotDialog
        open={copilotOpen}
        onOpenChange={setCopilotOpen}
        graph={flow.graph}
        contentTypes={flow.contentTypes}
        onProposal={setProposal}
      />
    </div>
  );
}

/** Pick a published version to look at read-only, or the draft to edit. */
function VersionPicker({
  versions,
  viewing,
  onView,
}: {
  versions: readonly WorkflowVersion[];
  viewing: number | null;
  onView: (v: number | null) => void;
}) {
  if (!versions.length) return null;
  return (
    <NativeSelect
      value={viewing === null ? '' : String(viewing)}
      onChange={(e) => onView(e.target.value ? Number(e.target.value) : null)}
      className="h-8 text-xs"
      aria-label="Version"
    >
      <NativeSelectOption value="">Draft</NativeSelectOption>
      {versions.map((v) => (
        <NativeSelectOption key={v.version} value={String(v.version)}>
          v{v.version} (published)
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

/** A check, as a row: picking it selects the step it is about. */
function CheckItem({
  tone,
  message,
  onPick,
}: {
  tone: 'bad' | 'wait';
  message: string;
  onPick: () => void;
}) {
  return (
    <Item
      asChild
      variant={tone === 'bad' ? 'muted' : 'default'}
      size="xs"
      className="relative flex-nowrap items-start hover:bg-muted touch:py-3 has-focus-visible:ring-2 has-focus-visible:ring-ring"
    >
      <li>
        <ItemMedia variant="icon" className={tone === 'bad' ? 'text-bad' : 'text-wait'}>
          <AlertTriangle className="size-3.5" aria-hidden="true" />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle
            className={cn('line-clamp-none font-normal', tone === 'bad' ? 'text-bad' : 'text-wait')}
          >
            <button
              type="button"
              onClick={onPick}
              className="text-left after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:outline-none"
            >
              {message}
            </button>
          </ItemTitle>
        </ItemContent>
      </li>
    </Item>
  );
}
