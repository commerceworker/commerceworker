import { BulkJobProgress } from '~/cms/components/bulk-job-progress';
import { type AssetBulkAction, BULK_VERBS } from '~/cms/lib/assets';
import type { BulkJobSummary } from '~/cms/lib/management';

/** An asset library bulk action running as a job (`BulkJobProgress`, counted in assets). */
export function AssetBulkJobProgress(props: {
  action: AssetBulkAction;
  job: BulkJobSummary;
  onDismiss: () => void;
  /** Stops the job; absent, the card offers no Stop. */
  onCancel?: () => void;
  /** A stop is on its way to the server. */
  cancelling?: boolean;
}) {
  const { action, ...rest } = props;
  return (
    <BulkJobProgress
      {...rest}
      verbs={BULK_VERBS[action]}
      nouns={['asset', 'assets']}
      where="the library"
    />
  );
}
