import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Progress } from '@commerceworker/ui/progress';
import { Download } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBadge } from '~/cms/components/status';
import { zipPercent, zipRunning, zipSummary } from '~/cms/lib/assets';
import { useClient } from '~/cms/lib/client-context';
import { ApiError, type AssetZip, type AssetZipInput, apiErrorMessage } from '~/cms/lib/management';
import { useToast } from '~/cms/lib/toast';

/** How often a zip being built is asked how far it has got (as a bulk job is). */
export const ZIP_POLL_MS = 2000;

/**
 * A zip download this screen asked for: start one, follow it until it is built or has failed,
 * fetch a fresh download link (each lasts 15 minutes), or put it away.
 */
export function useAssetZip() {
  const { client } = useClient();
  const toast = useToast();
  const [zip, setZip] = useState<AssetZip | null>(null);
  const [starting, setStarting] = useState(false);
  // A second press before the first answer would start a second zip: one at a time.
  const pending = useRef(false);

  const start = useCallback(
    async (input: AssetZipInput) => {
      if (pending.current) return;
      pending.current = true;
      setStarting(true);
      try {
        setZip(await client.startAssetZip(input));
      } catch (e) {
        toast.error(apiErrorMessage(e));
      } finally {
        pending.current = false;
        setStarting(false);
      }
    },
    [client, toast],
  );

  const running = zip && zipRunning(zip) ? zip.id : null;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      client
        .getAssetZip(running)
        .then((next) => {
          setZip((current) => (current?.id === next.id ? next : current));
          if (next.status === 'completed') toast.success(`“${next.fileName}” is ready to download`);
        })
        .catch((e) => {
          // A refusal (the session ended, the zip is gone) won't pass by itself: stop following
          // it. Anything else is transient, and the next tick asks again.
          if (!(e instanceof ApiError) || e.status < 400 || e.status >= 500) return;
          setZip(null);
          toast.error(`Stopped following the zip: ${apiErrorMessage(e)}`);
        });
    }, ZIP_POLL_MS);
    return () => clearInterval(timer);
  }, [running, client, toast]);

  /** A new 15-minute download link for the built zip. */
  const refresh = useCallback(async () => {
    if (!zip) return;
    try {
      const next = await client.getAssetZip(zip.id);
      setZip((current) => (current?.id === next.id ? next : current));
    } catch (e) {
      toast.error(apiErrorMessage(e));
    }
  }, [client, toast, zip]);

  return { zip, starting, start, refresh, dismiss: () => setZip(null) };
}

/** What {@link useAssetZip} gives a screen: the zip it follows and what can be done with it. */
export type AssetZipState = ReturnType<typeof useAssetZip>;

/**
 * A zip download on its way, shaped like the bulk job card: a polite status line ("Zipping 12
 * files into “Launch.zip”…"), the parts written as a progress bar, and that it keeps going if the
 * tab closes. Built, it offers the download (the link lasts 15 minutes; Get a new link asks for
 * another). Failed, the reason is an Alert, so it is heard at once.
 */
export function AssetZipProgress(props: {
  zip: AssetZip;
  onRefresh: () => void;
  onDismiss: () => void;
}) {
  const { zip } = props;
  const running = zipRunning(zip);
  return (
    <section aria-label="Zip download" className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="section-title" role="status">
          {zipSummary(zip)}
        </p>
        <StatusBadge status={zip.status} />
        {!running && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={props.onDismiss}
          >
            Dismiss
          </Button>
        )}
      </div>
      {zip.status !== 'failed' && (
        <Progress
          value={zipPercent(zip)}
          aria-label="Zip progress"
          getValueLabel={(value) =>
            zip.partCount ? `${zip.partsDone} of ${zip.partCount} parts written` : `${value}%`
          }
          className="h-1.5"
        />
      )}
      {running && (
        <p className="text-muted-foreground text-xs">
          {zip.partCount
            ? `${zip.partsDone} of ${zip.partCount} parts written; this keeps going if you close the tab.`
            : 'Planning the archive; this keeps going if you close the tab.'}
        </p>
      )}
      {zip.status === 'completed' && (
        <div className="flex flex-wrap items-center gap-2">
          {zip.downloadUrl ? (
            <Button asChild size="sm">
              <a href={zip.downloadUrl} download={zip.fileName}>
                <Download aria-hidden="true" />
                Download “{zip.fileName}”
              </a>
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={props.onRefresh}>
            Get a new link
          </Button>
          <p className="basis-full text-muted-foreground text-xs">
            A download link works for 15 minutes; the archive is kept for a day.
          </p>
        </div>
      )}
      {zip.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTitle>The zip wasn’t built</AlertTitle>
          <AlertDescription>
            <p>{zip.error ?? 'The server didn’t say why.'} Try again, or with fewer assets.</p>
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}
