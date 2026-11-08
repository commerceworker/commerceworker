import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@commerceworker/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@commerceworker/ui/chart';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts';
import type { AgentRun } from '../../lib/management';
import { bucketRunsByDay, formatTokens, tokenGrowth } from '../../lib/usage';

const chartConfig = {
  totalTokens: { label: 'Tokens', color: 'var(--primary)' },
} satisfies ChartConfig;

/**
 * Total agent tokens over the last 14 days as a flat area chart, with a
 * last-7-vs-previous-7 change badge, fed by agent-run history (input + output
 * tokens bucketed by day). Deliberately quiet: it sits below the editor work.
 */
export function UsageTrendCard(props: { runs: readonly AgentRun[] }) {
  const data = bucketRunsByDay(props.runs, 14);
  const total = data.reduce((s, b) => s + b.totalTokens, 0);
  const { pct } = tokenGrowth(props.runs, 7);
  const up = (pct ?? 0) >= 0;
  const range = data.length > 0 ? `${data[0]!.label} – ${data[data.length - 1]!.label}` : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">Total tokens</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-xl font-semibold tabular-nums">{formatTokens(total)}</span>
          {pct !== null && (
            // Spend rising or falling isn't a state, so no status colour.
            <Badge variant="outline" className="gap-1">
              {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
              {up ? '+' : ''}
              {pct}%
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Last 14 days</p>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="aspect-auto h-30 w-full">
          <AreaChart accessibilityLayer data={data} margin={{ left: 12, right: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
            />
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
            <Area
              dataKey="totalTokens"
              type="monotone"
              fill="var(--color-totalTokens)"
              fillOpacity={0.12}
              stroke="var(--color-totalTokens)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {pct !== null ? (
            <>
              {up ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />}
              {up ? 'Up' : 'Down'} {Math.abs(pct)}% vs the previous 7 days
            </>
          ) : (
            <span>{range}</span>
          )}
        </div>
        <Button variant="ghost" size="sm" asChild className="w-full">
          <a href="#agent-runs">See agent runs</a>
        </Button>
      </CardFooter>
    </Card>
  );
}
