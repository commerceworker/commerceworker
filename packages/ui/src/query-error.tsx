import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './alert';
import { Button } from './button';

export interface QueryErrorProps {
  /** The rejection from the failed query. */
  error: unknown;
  /** Re-runs the query. Omit only where there is genuinely nothing to retry. */
  onRetry?: () => void;
  className?: string;
}

/**
 * The failure state for a query-backed region.
 *
 * A region that renders nothing when its query rejects is indistinguishable
 * from one with no data: an operator cannot tell a tenant with no API keys
 * from an API-keys request that failed, and a control plane whose list query
 * failed reports that the platform is empty. Every query-backed region should
 * render this rather than falling through to its empty state.
 */
export function QueryError({ error, onRetry, className }: QueryErrorProps) {
  const { t } = useTranslation('ui');
  // Our API clients put the server's message on a plain Error; anything else is
  // a network or programming fault the operator cannot act on directly.
  const message = error instanceof Error && error.message ? error.message : t('queryErrorBody');

  return (
    <Alert variant="destructive" className={className}>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>{message}</span>
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('queryErrorRetry')}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
