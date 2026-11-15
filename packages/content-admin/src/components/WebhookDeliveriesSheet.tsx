import { Ago } from '@commerceworker/content-admin/components/ago';
import { EmptyState } from '@commerceworker/content-admin/components/page';
import { ResponsiveSheetContent } from '@commerceworker/content-admin/components/responsive-sheet';
import { StatusBadge } from '@commerceworker/content-admin/components/status';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from '@commerceworker/ui/sheet';
import { Skeleton } from '@commerceworker/ui/skeleton';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@commerceworker/ui/table';
import { Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useClient } from '../lib/client-context';
import type { WebhookDeliveryRecord, WebhookSummary } from '../lib/management';
import { useToast } from '../lib/toast';

/** Reads of the log while a queued test or resend is on its way (about 15 s at the default). */
const MAX_POLLS = 10;

/** A queued delivery the sheet is waiting to see in the log. */
interface Awaited {
  readonly match: (d: WebhookDeliveryRecord) => boolean;
}

/**
 * Recent delivery attempts for a webhook (event, status, code, attempts, error, when), each of
 * which can be sent again. A test or resend is queued for the engine, so after one the sheet reads
 * the log again every `pollMs` until its attempt shows up (or it gives up and says so).
 * `awaitEventId` is a test just queued from the webhooks table.
 */
export function WebhookDeliveriesSheet(props: {
  webhook: WebhookSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  awaitEventId?: string;
  pollMs?: number;
}) {
  const { client } = useClient();
  const toast = useToast();
  const pollMs = props.pollMs ?? 1500;
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRecord[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState<number | null>(null);
  const [awaited, setAwaited] = useState<Awaited | null>(() =>
    props.awaitEventId ? { match: (d) => d.eventId === props.awaitEventId } : null,
  );
  const [notYet, setNotYet] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await client.webhookDeliveries(props.webhook.id, 50);
      setDeliveries(d);
      setFailed(null);
      return d;
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, [client, props.webhook.id]);

  useEffect(() => {
    if (props.open) void load();
  }, [props.open, load]);

  // While a queued attempt hasn't shown up, read the log again, a bounded number of times.
  useEffect(() => {
    if (!awaited || !props.open) return;
    let live = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const d = await load();
      tries += 1;
      if (!live) return;
      if (d?.some(awaited.match)) {
        setAwaited(null);
      } else if (tries >= MAX_POLLS) {
        setAwaited(null);
        setNotYet(true);
      } else {
        timer = setTimeout(tick, pollMs);
      }
    };
    timer = setTimeout(tick, pollMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [awaited, props.open, load, pollMs]);

  const resend = async (d: WebhookDeliveryRecord) => {
    setResending(d.id);
    try {
      await client.resendWebhookDelivery(props.webhook.id, d.id);
      const newest = Math.max(0, ...(deliveries ?? []).map((r) => r.id));
      setNotYet(false);
      setAwaited({ match: (r) => r.resendOf === d.id && r.id > newest });
      toast.success('Resend queued.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setResending(null);
    }
  };

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <ResponsiveSheetContent className="w-full sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Deliveries</SheetTitle>
          <SheetDescription className="break-all font-mono text-xs">
            {props.webhook.url}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-3 px-4 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs" role="status" aria-live="polite">
              {awaited
                ? 'Waiting for the engine to send it…'
                : notYet
                  ? 'Not sent yet. Refresh in a moment.'
                  : ''}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => {
                setNotYet(false);
                void load();
              }}
            >
              Refresh
            </Button>
          </div>
          {failed && (
            <Alert variant="destructive">
              <AlertTitle>The delivery log didn’t load</AlertTitle>
              <AlertDescription>
                <p>{failed}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void load()}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {deliveries === null ? (
            failed ? null : (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            )
          ) : deliveries.length === 0 ? (
            <EmptyState
              icon={Send}
              title="No deliveries yet"
              description="Delivery attempts appear here after a matching event is published, or a test is sent."
            />
          ) : (
            <Table edge="flush" stack="cards" caption="Deliveries" aria-busy={loading}>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((d) => {
                  const text = resending === d.id ? 'Resending…' : 'Resend';
                  return (
                    <TableRow key={d.id}>
                      <TableCell className="font-mono text-xs">
                        {d.eventType ?? 'Unknown event'}
                        <span className="block text-muted-foreground">
                          #{d.id}
                          {d.resendOf !== undefined && `, resend of #${d.resendOf}`}
                        </span>
                      </TableCell>
                      <TableCell label="Status">
                        <StatusBadge status={d.status} />
                      </TableCell>
                      <TableCell label="Code" className="text-muted-foreground">
                        {d.statusCode ?? '—'}
                      </TableCell>
                      <TableCell label="Attempts" className="text-muted-foreground">
                        {d.attempts}
                      </TableCell>
                      <TableCell label="When" className="text-muted-foreground">
                        <Ago at={d.createdAt} />
                      </TableCell>
                      <TableCell
                        label="Error"
                        className="max-w-48 truncate text-muted-foreground"
                        title={d.error}
                      >
                        {d.error ?? '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={resending !== null}
                          aria-label={`${text} delivery #${d.id}`}
                          onClick={() => resend(d)}
                        >
                          {text}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </ResponsiveSheetContent>
    </Sheet>
  );
}
