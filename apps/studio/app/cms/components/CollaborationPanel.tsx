import type { Comment, Task } from '@commerceworker/domain';
import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import { Checkbox } from '@commerceworker/ui/checkbox';
import { Input } from '@commerceworker/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@commerceworker/ui/tabs';
import { Textarea } from '@commerceworker/ui/textarea';
import { CheckSquare, GitBranch, MessageSquare, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Ago } from '~/cms/components/ago';
import { CollapsibleCard } from '~/cms/components/CollapsibleCard';
import { ConfirmButton } from '~/cms/components/InlineConfirm';
import { useClient, useLocalRun } from '../lib/client-context';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** Comments + tasks + workflow status for one entry — the P13 editorial sidebar. */
export function CollaborationPanel(props: { entryId: string }) {
  const { entryId } = props;
  return (
    <CollapsibleCard defaultOpen title="Collaboration">
      <Tabs defaultValue="comments">
        <TabsList>
          <TabsTrigger value="comments">
            <MessageSquare className="size-4" />
            Comments
          </TabsTrigger>
          <TabsTrigger value="tasks">
            <CheckSquare className="size-4" />
            Tasks
          </TabsTrigger>
          <TabsTrigger value="workflow">
            <GitBranch className="size-4" />
            Workflow
          </TabsTrigger>
        </TabsList>
        <TabsContent value="comments" className="mt-4">
          <CommentsTab entryId={entryId} />
        </TabsContent>
        <TabsContent value="tasks" className="mt-4">
          <TasksTab entryId={entryId} />
        </TabsContent>
        <TabsContent value="workflow" className="mt-4">
          <WorkflowTab entryId={entryId} />
        </TabsContent>
      </Tabs>
    </CollapsibleCard>
  );
}

function CommentsTab(props: { entryId: string }) {
  const { client } = useClient();
  const { busy, run } = useLocalRun();
  const toast = useToast();
  const invalidate = useInvalidate();
  const commentsQuery = useScopedQuery(['comments', props.entryId], () =>
    client.listComments(props.entryId),
  );
  const comments = commentsQuery.data ?? [];
  const [draft, setDraft] = useState('');

  const add = (parentId: string | null, body: string) =>
    run(async () => {
      await client.addComment(props.entryId, { body, parentId });
      await invalidate(['comments', props.entryId]);
    });

  const remove = (id: string) =>
    run(async () => {
      await client.deleteComment(id);
      toast.success('Comment deleted');
      await invalidate(['comments', props.entryId]);
    });

  const roots = comments.filter((c) => !c.parentId);
  const repliesOf = (id: string) => comments.filter((c) => c.parentId === id);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Leave a comment…"
          rows={2}
        />
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={!draft.trim() || busy}
            onClick={() => {
              add(null, draft.trim());
              setDraft('');
            }}
          >
            Comment
          </Button>
        </div>
      </div>

      {roots.length === 0 ? (
        <p className="text-muted-foreground text-sm">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {roots.map((c) => (
            <li key={c.id} className="space-y-2">
              <CommentRow comment={c} onDelete={() => remove(c.id)} busy={busy} />
              <div className="space-y-2 border-muted border-l pl-4">
                {repliesOf(c.id).map((r) => (
                  <CommentRow key={r.id} comment={r} onDelete={() => remove(r.id)} busy={busy} />
                ))}
                <ReplyBox onReply={(body) => add(c.id, body)} busy={busy} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CommentRow(props: { comment: Comment; onDelete: () => void; busy: boolean }) {
  const { comment } = props;
  return (
    <div className="group flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{comment.author}</span>
          <span className="text-muted-foreground text-xs">
            <Ago at={comment.createdAt} />
          </span>
        </div>
        <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
      </div>
      <ConfirmButton
        message="Delete this comment?"
        note="This can’t be undone."
        confirmLabel="Delete comment"
        busy={props.busy}
        onConfirm={props.onDelete}
      >
        {(ask) => (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
            aria-label={`Delete comment by ${comment.author}`}
            onClick={ask}
            disabled={props.busy}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </ConfirmButton>
    </div>
  );
}

function ReplyBox(props: { onReply: (body: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  if (!open) {
    return (
      <button
        type="button"
        className="text-muted-foreground text-xs hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        Reply
      </button>
    );
  }
  return (
    <div className="space-y-2">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        placeholder="Reply…"
      />
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!body.trim() || props.busy}
          onClick={() => {
            props.onReply(body.trim());
            setBody('');
            setOpen(false);
          }}
        >
          Reply
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function TasksTab(props: { entryId: string }) {
  const { client } = useClient();
  const { busy, run } = useLocalRun();
  const toast = useToast();
  const invalidate = useInvalidate();
  const tasksQuery = useScopedQuery(['tasks', props.entryId], () =>
    client.listTasks(props.entryId),
  );
  const tasks = tasksQuery.data ?? [];
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');

  const create = () =>
    run(async () => {
      await client.createTask(props.entryId, {
        body: body.trim(),
        assignee: assignee.trim() || undefined,
      });
      setBody('');
      setAssignee('');
      await invalidate(['tasks', props.entryId]);
    });

  const toggle = (task: Task) =>
    run(async () => {
      await client.updateTask(task.id, {
        status: task.status === 'resolved' ? 'open' : 'resolved',
      });
      await invalidate(['tasks', props.entryId]);
    });

  const remove = (id: string) =>
    run(async () => {
      await client.deleteTask(id);
      toast.success('Task deleted');
      await invalidate(['tasks', props.entryId]);
    });

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Task, e.g. write alt text"
        />
        <div className="flex gap-2">
          <Input
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="Assignee (optional)"
            className="flex-1"
          />
          <Button type="button" size="sm" disabled={!body.trim() || busy} onClick={create}>
            Add task
          </Button>
        </div>
      </div>

      {tasks.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tasks yet.</p>
      ) : (
        <ul className="space-y-1">
          {tasks.map((t) => (
            <li
              key={t.id}
              className="group flex flex-wrap items-start gap-2 rounded-md px-1 py-1.5"
            >
              <Checkbox
                checked={t.status === 'resolved'}
                onCheckedChange={() => toggle(t)}
                aria-label="Toggle task"
                className="mt-0.5"
              />
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm ${t.status === 'resolved' ? 'text-muted-foreground line-through' : ''}`}
                >
                  {t.body}
                </p>
                {t.assignee && (
                  <Badge variant="outline" className="mt-1">
                    {t.assignee}
                  </Badge>
                )}
              </div>
              <ConfirmButton
                message="Delete this task?"
                note="This can’t be undone."
                confirmLabel="Delete task"
                busy={busy}
                onConfirm={() => void remove(t.id)}
              >
                {(ask) => (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label="Delete task"
                    onClick={ask}
                    disabled={busy}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WorkflowTab(props: { entryId: string }) {
  const { client } = useClient();
  const { busy, run } = useLocalRun();
  const toast = useToast();
  const invalidate = useInvalidate();
  const workflowsQuery = useScopedQuery(['workflows'], () => client.listWorkflows());
  const stateQuery = useScopedQuery(['workflow-state', props.entryId], () =>
    client.getEntryWorkflowState(props.entryId),
  );
  const workflows = workflowsQuery.data ?? [];
  const state = stateQuery.data ?? null;
  const [workflowId, setWorkflowId] = useState('');
  const [stepId, setStepId] = useState('');

  // Seed the pickers once both queries land (and re-seed after a transition).
  useEffect(() => {
    if (!workflowsQuery.data || stateQuery.data === undefined) return;
    const wfs = workflowsQuery.data;
    const st = stateQuery.data;
    if (st) {
      setWorkflowId(st.workflowId);
      setStepId(st.currentStepId);
    } else if (wfs[0]) {
      setWorkflowId(wfs[0].id);
      setStepId(wfs[0].steps[0]?.id ?? '');
    }
  }, [workflowsQuery.data, stateQuery.data]);

  const selected = workflows.find((w) => w.id === workflowId);
  const currentWorkflow = workflows.find((w) => w.id === state?.workflowId);
  const currentStep = currentWorkflow?.steps.find((s) => s.id === state?.currentStepId);

  const move = () =>
    run(async () => {
      await client.transitionEntry(props.entryId, { workflowId, toStepId: stepId });
      toast.success('Workflow updated');
      await invalidate(['workflow-state', props.entryId]);
    });

  if (workflows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No workflows defined. Create one under the Workflows section to track editorial status.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-sm">
        <span className="text-muted-foreground">Current: </span>
        {currentStep ? (
          <Badge variant="secondary">{currentStep.name}</Badge>
        ) : (
          <span className="text-muted-foreground">not in any workflow</span>
        )}
      </div>

      <div className="space-y-2">
        <Select
          value={workflowId}
          onValueChange={(v) => {
            setWorkflowId(v);
            setStepId(workflows.find((w) => w.id === v)?.steps[0]?.id ?? '');
          }}
        >
          <SelectTrigger aria-label="Workflow">
            <SelectValue placeholder="Workflow" />
          </SelectTrigger>
          <SelectContent>
            {workflows.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex gap-2">
          <Select value={stepId} onValueChange={setStepId}>
            <SelectTrigger aria-label="Workflow step" className="flex-1">
              <SelectValue placeholder="Step" />
            </SelectTrigger>
            <SelectContent>
              {selected?.steps.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" disabled={!stepId || busy} onClick={move}>
            Move
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Moving into a step requires its configured permission scope.
        </p>
      </div>
    </div>
  );
}
