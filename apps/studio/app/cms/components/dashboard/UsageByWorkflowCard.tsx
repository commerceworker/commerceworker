import { Card, CardContent, CardHeader, CardTitle } from '@commerceworker/ui/card';
import { type ChartConfig, ChartContainer } from '@commerceworker/ui/chart';
import { Bar, BarChart } from 'recharts';
import { Mark } from '~/components/mark';
import type { AgentRun } from '../../lib/management';
import { formatTokens, usageByWorkflow, type WorkflowUsage } from '../../lib/usage';

const sparkConfig = {
  runs: { label: 'Runs', color: 'var(--primary)' },
} satisfies ChartConfig;

/** The window every usage card reports on, so their totals agree. */
const WINDOW_DAYS = 14;

/** Runs created on or after the start of the day `days - 1` days ago. */
export function withinDays(runs: readonly AgentRun[], days: number, now = new Date()): AgentRun[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return runs.filter((r) => new Date(r.createdAt).getTime() >= start.getTime());
}

/**
 * Token spend per agent workflow over the same window as the other usage
 * cards, each row showing run count, total tokens, and a per-day sparkline.
 */
export function UsageByWorkflowCard(props: { runs: readonly AgentRun[]; days?: number }) {
  const days = props.days ?? WINDOW_DAYS;
  const rows = usageByWorkflow(withinDays(props.runs, days), days);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Tokens by workflow
        </CardTitle>
        <p className="text-xs text-muted-foreground">Last {days} days</p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
            <Mark className="size-6 text-ai" />
            No agent runs in the last {days} days.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <WorkflowRow key={row.workflow} row={row} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function WorkflowRow(props: { row: WorkflowUsage }) {
  const { row } = props;
  const data = row.spark.map((runs, i) => ({ i, runs }));
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="font-medium capitalize">{row.workflow}</div>
        <div className="text-xs text-muted-foreground">
          {row.runs} {row.runs === 1 ? 'run' : 'runs'}
        </div>
      </div>

      {/* Mini per-day activity sparkline (last 7 days), hidden on narrow cards. */}
      <ChartContainer config={sparkConfig} className="hidden aspect-auto h-8 w-28 flex-1 sm:block">
        <BarChart data={data} margin={{ top: 2, bottom: 0, left: 0, right: 0 }}>
          <Bar dataKey="runs" fill="var(--color-runs)" radius={1} />
        </BarChart>
      </ChartContainer>

      <div className="shrink-0 text-right tabular-nums">
        <div className="font-semibold">{formatTokens(row.totalTokens)}</div>
        <div className="text-xs text-muted-foreground">tokens</div>
      </div>
    </li>
  );
}
