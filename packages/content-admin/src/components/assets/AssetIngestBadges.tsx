import { StatusBadge, ToneBadge } from '@commerceworker/content-admin/components/status';
import { ingestState } from '@commerceworker/content-admin/lib/assets';
import type { Asset } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { RotateCw } from 'lucide-react';

/**
 * The focus edge for a badge that is a button: the full `ring` token (3:1 on paper and on muted),
 * not the faded halo, which falls under it.
 */
export const BADGE_BUTTON_FOCUS =
  'hit-area rounded-4xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background';

/**
 * What ingest found about an asset, beside its status: a possible duplicate (opening the asset it
 * duplicates), and ingest still running or failed (with Retry). The failure's reason is written
 * out under the badges in the `bad` colour, on its own line, so it is read once and seen without
 * hovering. Nothing once ingest is done and found no twin.
 */
export function AssetIngestBadges(props: {
  asset: Asset;
  name: string;
  onOpenOriginal?: (id: string) => void;
  onRetry?: (asset: Asset) => void;
}) {
  const { asset, name } = props;
  const ingest = ingestState(asset);
  const duplicateOf = asset.duplicateOf;
  if (!ingest && !duplicateOf) return null;
  return (
    <>
      {duplicateOf &&
        (props.onOpenOriginal ? (
          <button
            type="button"
            aria-label={`Possible duplicate: open the asset “${name}” duplicates`}
            onClick={() => props.onOpenOriginal?.(duplicateOf)}
            className={BADGE_BUTTON_FOCUS}
          >
            <ToneBadge tone="wait" label="Possible duplicate" />
          </button>
        ) : (
          <ToneBadge tone="wait" label="Possible duplicate" />
        ))}
      {ingest?.state === 'processing' && <StatusBadge status="processing" label="Processing" />}
      {ingest?.state === 'failed' && (
        <>
          <span className="inline-flex items-center gap-0.5">
            <StatusBadge status="failed" label="Processing failed" />
            {props.onRetry && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Retry processing “${name}”`}
                onClick={() => props.onRetry?.(asset)}
              >
                <RotateCw aria-hidden="true" />
              </Button>
            )}
          </span>
          {ingest.error && (
            <span className="basis-full break-words text-bad text-xs">{ingest.error}</span>
          )}
        </>
      )}
    </>
  );
}
