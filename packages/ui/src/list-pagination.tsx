import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './button';
import { ButtonGroup } from './button-group';
import { cn } from './lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

export interface ListPaginationProps {
  /** Current page (1-based) */
  page: number;
  /** Total number of pages (>= 1) */
  pageCount: number;
  onPageChange: (page: number) => void;
  /** Optional page size selector */
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
  className?: string;
  showEdges?: boolean;
}

export function ListPagination({
  page,
  pageCount,
  onPageChange,
  pageSize,
  pageSizeOptions = [10, 20, 50, 100],
  onPageSizeChange,
  className,
  showEdges = true,
}: ListPaginationProps) {
  const { t } = useTranslation('ui');
  const safeCount = Math.max(1, pageCount);
  const safePage = Math.min(Math.max(1, page), safeCount);

  return (
    <div
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-2 pt-4',
        className,
      )}
    >
      <div className="text-sm text-muted-foreground tabular-nums">
        {t('pageOf', { page: safePage, count: safeCount })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {onPageSizeChange !== undefined && pageSize !== undefined ? (
          <div className="hidden items-center gap-2 sm:flex">
            <span className="text-sm text-muted-foreground">{t('rowsPerPage')}</span>
            <Select
              value={`${pageSize}`}
              onValueChange={(v: string) => {
                const n = Number(v);
                if (Number.isFinite(n)) onPageSizeChange(n);
              }}
            >
              <SelectTrigger className="h-8 w-[4.5rem]" aria-label={t('rowsPerPage')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top">
                {pageSizeOptions.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <nav aria-label={t('listPaginationNav')} className="flex flex-wrap items-center gap-2">
          <ButtonGroup className="w-fit">
            <ButtonGroup>
              {showEdges ? (
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={safePage <= 1}
                  onClick={() => onPageChange(1)}
                >
                  <span className="sr-only">{t('firstPage')}</span>
                  <ChevronsLeft className="size-4" />
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={safePage <= 1}
                onClick={() => onPageChange(safePage - 1)}
              >
                <span className="sr-only">{t('previousPage')}</span>
                <ChevronLeft className="size-4" />
              </Button>
            </ButtonGroup>
            <ButtonGroup>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                disabled={safePage >= safeCount}
                onClick={() => onPageChange(safePage + 1)}
              >
                <span className="sr-only">{t('nextPage')}</span>
                <ChevronRight className="size-4" />
              </Button>
              {showEdges ? (
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={safePage >= safeCount}
                  onClick={() => onPageChange(safeCount)}
                >
                  <span className="sr-only">{t('lastPage')}</span>
                  <ChevronsRight className="size-4" />
                </Button>
              ) : null}
            </ButtonGroup>
          </ButtonGroup>
        </nav>
      </div>
    </div>
  );
}
