import { plural } from '@commerceworker/content-admin/lib/format';
import { Link } from '@commerceworker/content-admin/router';
import type { AssetUsage } from '@commerceworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { Link2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

/** Links listed at most; the rest are counted ("and 12 more"). */
export const IN_USE_SHOWN = 5;

/**
 * Why an asset wasn't deleted: the entries that still link to it, each a link to the entry, with
 * archiving offered instead (it stops delivery without breaking those links). The API names each
 * entry's type and title in the refusal, so nothing is fetched here. It takes focus when it
 * appears: the delete that caused it was confirmed somewhere else on the page.
 */
export function AssetInUseNotice(props: {
  name: string;
  usage: readonly AssetUsage[];
  /** Every link, counted; `usage` may carry only the first of them. */
  total: number;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView?.({ block: 'nearest' });
    el.focus({ preventScroll: true });
  }, []);

  const shown = props.usage.slice(0, IN_USE_SHOWN);
  const more = props.total - shown.length;
  return (
    <Alert ref={ref} tabIndex={-1} variant="warning" className="outline-none">
      <Link2 aria-hidden="true" />
      <AlertTitle>
        “{props.name}” is used by {plural(props.total, 'entry', 'entries')}
      </AlertTitle>
      <AlertDescription>
        <p>Remove it from these entries before deleting it, or archive it to stop delivering it.</p>
        <ul className="space-y-1">
          {shown.map((u) => (
            <li key={`${u.fromEntryId}:${u.fromField}`} className="flex items-center gap-2">
              {u.contentTypeApiId ? (
                <Link
                  to={`/content/${u.contentTypeApiId}/${u.fromEntryId}`}
                  className="font-medium text-link hover:underline"
                >
                  {u.entryTitle || u.fromEntryId}
                </Link>
              ) : (
                <span className="font-mono text-xs">{u.entryTitle || u.fromEntryId}</span>
              )}
              <span className="text-muted-foreground">in</span>
              <span className="font-mono text-xs">{u.fromField}</span>
            </li>
          ))}
          {more > 0 && <li className="text-muted-foreground">and {more} more</li>}
        </ul>
        <div className="flex gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={props.onDismiss}>
            Dismiss
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
