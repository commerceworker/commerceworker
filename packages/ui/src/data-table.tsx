import {
  type ColumnDef,
  type ColumnFiltersState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type RowData,
  type RowSelectionState,
  type SortingState,
  type Updater,
  useReactTable,
  type VisibilityState,
} from '@tanstack/react-table';
import type { LucideIcon } from 'lucide-react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { EmptyState } from './empty-state';
import { cn } from './lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Table, TableBody, TableHead, Td, Th, Tr } from './table';

declare module '@tanstack/react-table' {
  /**
   * DESIGN.md, The Tabular Rule: any column of numbers is right-aligned and set
   * in tabular figures. Marking the column here keeps the header and its cells
   * in step, instead of each table remembering to add the classes itself.
   */
  interface ColumnMeta<TData extends RowData, TValue> {
    numeric?: boolean;
  }
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  toolbar?: React.ReactNode;
  emptyState?: {
    icon?: LucideIcon;
    illustration?: React.ComponentType<{ className?: string }>;
    title: string;
    description?: string;
    action?: React.ReactNode;
  };
  columnVisibility?: boolean;
  initialColumnVisibility?: VisibilityState;
  pageSize?: number;
  enableRowSelection?: boolean;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (selection: RowSelectionState) => void;
  contextMenuWrapper?: (
    row: import('@tanstack/react-table').Row<TData>,
    children: React.ReactNode,
  ) => React.ReactNode;
  rowClassName?: (row: import('@tanstack/react-table').Row<TData>) => string;
  maxHeight?: string;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export function DataTable<TData, TValue>({
  columns,
  data,
  toolbar,
  emptyState,
  columnVisibility: showColumnVisibility = false,
  initialColumnVisibility,
  pageSize = 20,
  enableRowSelection = false,
  rowSelection: controlledRowSelection,
  onRowSelectionChange,
  contextMenuWrapper,
  rowClassName,
  maxHeight,
}: DataTableProps<TData, TValue>) {
  const { t } = useTranslation('ui');
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [visibility, setVisibility] = React.useState<VisibilityState>(
    initialColumnVisibility ?? {},
  );
  const [pagination, setPagination] = React.useState({ pageIndex: 0, pageSize });
  const [internalRowSelection, setInternalRowSelection] = React.useState<RowSelectionState>({});

  const rowSelection = controlledRowSelection ?? internalRowSelection;

  const enablePagination = pageSize > 0 && data.length > pageSize;

  const handleRowSelectionChange =
    enableRowSelection === true
      ? (updater: Updater<RowSelectionState>) => {
          const next = typeof updater === 'function' ? updater(rowSelection) : updater;
          if (onRowSelectionChange !== undefined) {
            onRowSelectionChange(next);
          } else {
            setInternalRowSelection(next);
          }
        }
      : undefined;

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnFilters,
      columnVisibility: visibility,
      ...(enablePagination ? { pagination } : {}),
      ...(enableRowSelection ? { rowSelection } : {}),
    },
    enableRowSelection,
    ...(handleRowSelectionChange !== undefined
      ? { onRowSelectionChange: handleRowSelectionChange }
      : {}),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setVisibility,
    ...(enablePagination ? { onPaginationChange: setPagination } : {}),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    ...(enablePagination ? { getPaginationRowModel: getPaginationRowModel() } : {}),
  });

  if (data.length === 0 && emptyState) {
    return (
      <>
        {toolbar ? <div className="mb-4">{toolbar}</div> : null}
        <EmptyState
          {...(emptyState.icon !== undefined ? { icon: emptyState.icon } : {})}
          {...(emptyState.illustration !== undefined
            ? { illustration: emptyState.illustration }
            : {})}
          title={emptyState.title}
          {...(emptyState.description !== undefined ? { description: emptyState.description } : {})}
          {...(emptyState.action !== undefined ? { action: emptyState.action } : {})}
        />
      </>
    );
  }

  return (
    <>
      {(toolbar || showColumnVisibility) && (
        <div className="mb-4 flex items-center gap-3">
          <div className="flex-1">{toolbar}</div>
          {showColumnVisibility && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  {t('dataTableColumns')}
                  <ChevronDown className="ml-1 size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {table
                  .getAllColumns()
                  .filter(
                    (column) => typeof column.accessorFn !== 'undefined' && column.getCanHide(),
                  )
                  .map((column) => (
                    <DropdownMenuCheckboxItem
                      key={column.id}
                      className="capitalize"
                      checked={column.getIsVisible()}
                      onCheckedChange={(value: boolean | 'indeterminate') =>
                        column.toggleVisibility(value === true)
                      }
                    >
                      {column.id}
                    </DropdownMenuCheckboxItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      <div
        className={cn(
          'rounded-2xl border border-border',
          maxHeight ? 'overflow-auto' : 'overflow-hidden',
        )}
        style={maxHeight ? { maxHeight } : undefined}
      >
        <Table>
          <TableHead className="sticky top-0 z-10 border-b bg-muted">
            {table.getHeaderGroups().map((headerGroup) => (
              <Tr key={headerGroup.id} className="border-b-0 hover:bg-transparent">
                {headerGroup.headers.map((header) => (
                  <Th
                    key={header.id}
                    colSpan={header.colSpan}
                    className={cn(header.column.columnDef.meta?.numeric && 'text-right')}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </Th>
                ))}
              </Tr>
            ))}
          </TableHead>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => {
                const rowContent = (
                  <Tr
                    key={row.id}
                    data-state={row.getIsSelected() && 'selected'}
                    className={rowClassName?.(row)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <Td
                        key={cell.id}
                        className={cn(
                          cell.column.columnDef.meta?.numeric && 'text-right tabular-nums',
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </Td>
                    ))}
                  </Tr>
                );
                return contextMenuWrapper ? (
                  <React.Fragment key={row.id}>
                    {contextMenuWrapper(row, rowContent)}
                  </React.Fragment>
                ) : (
                  rowContent
                );
              })
            ) : (
              <Tr>
                <Td colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  {t('dataTableNoResults')}
                </Td>
              </Tr>
            )}
          </TableBody>
        </Table>
      </div>

      {enablePagination && (
        <div className="flex flex-col gap-3 px-2 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-muted-foreground tabular-nums">
            {table.getFilteredSelectedRowModel().rows.length > 0
              ? t('dataTableRowsSelected', {
                  selected: table.getFilteredSelectedRowModel().rows.length,
                  total: table.getFilteredRowModel().rows.length,
                })
              : t('dataTableRowCount', { total: table.getFilteredRowModel().rows.length })}
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:gap-6">
            <div className="hidden items-center gap-2 sm:flex">
              <span className="text-sm text-muted-foreground">{t('rowsPerPage')}</span>
              <Select
                value={`${pagination.pageSize}`}
                onValueChange={(value: string) => {
                  const n = Number(value);
                  if (Number.isFinite(n)) {
                    setPagination((prev) => ({ ...prev, pageSize: n, pageIndex: 0 }));
                  }
                }}
              >
                <SelectTrigger className="h-8 w-[4.5rem]" aria-label={t('rowsPerPage')}>
                  <SelectValue placeholder={String(pagination.pageSize)} />
                </SelectTrigger>
                <SelectContent side="top">
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <span className="text-sm text-muted-foreground tabular-nums">
              {t('pageOf', {
                page: table.getState().pagination.pageIndex + 1,
                count: table.getPageCount(),
              })}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.firstPage()}
                disabled={!table.getCanPreviousPage()}
              >
                <span className="sr-only">{t('firstPage')}</span>
                <ChevronsLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                <span className="sr-only">{t('previousPage')}</span>
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                <span className="sr-only">{t('nextPage')}</span>
                <ChevronRight className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => table.lastPage()}
                disabled={!table.getCanNextPage()}
              >
                <span className="sr-only">{t('lastPage')}</span>
                <ChevronsRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
