import { Card, CardContent, CardHeader, CardTitle } from '@commerceworker/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@commerceworker/ui/chart';
import { Separator } from '@commerceworker/ui/separator';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';
import type { AgentRun } from '../../lib/management';
import { bucketRunsByDay, formatTokens } from '../../lib/usage';

const chartConfig = {
  inputTokens: { label: 'Input', color: 'var(--chart-1)' },
  outputTokens: { label: 'Output', color: 'var(--chart-2)' },
} satisfies ChartConfig;

/**
 * "AI Throughput" — per-day input vs output tokens as a stacked bar chart, with
 * totals beneath. Mirrors the shadcn power-usage card; input (consumed) and
 * output (generated) map to its "using"/"generating" split.
 */
export function ThroughputCard(props: { runs: readonly AgentRun[] }) {
  const data = bucketRunsByDay(props.runs, 14);
  const input = data.reduce((s, b) => s + b.inputTokens, 0);
  const output = data.reduce((s, b) => s + b.outputTokens, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Input vs output tokens
        </CardTitle>
        <p className="text-xs text-muted-foreground">Last 14 days</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <ChartContainer config={chartConfig} className="aspect-auto h-24 w-full">
          <BarChart accessibilityLayer data={data} margin={{ left: 0, right: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
            />
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
            <Bar
              dataKey="inputTokens"
              stackId="t"
              fill="var(--color-inputTokens)"
              radius={[0, 0, 2, 2]}
            />
            <Bar
              dataKey="outputTokens"
              stackId="t"
              fill="var(--color-outputTokens)"
              radius={[2, 2, 0, 0]}
            />
          </BarChart>
        </ChartContainer>
        <Separator />
        <div className="flex items-center justify-between">
          <Metric icon={ArrowDownToLine} label="Input" value={formatTokens(input)} />
          <Metric icon={ArrowUpFromLine} label="Output" value={formatTokens(output)} />
        </div>
      </CardContent>
    </Card>
  );
}

function Metric(props: { icon: typeof ArrowDownToLine; label: string; value: string }) {
  const { icon: Icon } = props;
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" />
      <div>
        <div className="text-xs text-muted-foreground">{props.label}</div>
        <div className="text-lg font-semibold tabular-nums">{props.value}</div>
      </div>
    </div>
  );
}
