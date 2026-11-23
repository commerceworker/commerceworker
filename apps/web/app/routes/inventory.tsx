import { Button } from '@commerceworker/ui/button';
import { count, money } from '@commerceworker/ui/lib/format';
import { cn } from '@commerceworker/ui/lib/utils';
import { Body, Empty, PageHeader, Section } from '@commerceworker/ui/page';
import { Table, TableBody, TableEmpty, TableHead, Td, Th, Tr } from '@commerceworker/ui/table';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link, type ShouldRevalidateFunctionArgs, useFetcher, useLoaderData } from 'react-router';
import { FindBar, Held, Pager, Total } from '~/components/back-office';
import { useAssistant } from '~/lib/assistant';
import { requireUser } from '~/lib/auth.server';
import { inventoryPage } from '~/lib/commerce.server';
import { storeKey } from '~/lib/commerce-pages';
import { updateProductIndex } from '~/lib/product-index.server';
import { useCan } from '~/lib/use-me';
import type { Route } from './+types/inventory';

export const meta = () => [{ title: 'Inventory · CommerceWorker' }];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return inventoryPage(new URL(request.url).searchParams);
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  // An admin's, refused for anyone else (`updateProductIndex`).
  if ((await request.formData()).get('intent') === 'product-index')
    return { productIndex: await updateProductIndex(request, me) };
  return null;
}

/** Updating the product index changes nothing the page shows. */
export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formData?.get('intent') === 'product-index') return false;
  return defaultShouldRevalidate;
}

export default function Inventory() {
  const { inventory, stores, q } = useLoaderData<typeof loader>();
  // The stock review runs through the assistant: its card says what it starts, and the person
  // confirms it there.
  const { act } = useAssistant();
  const [review, setReview] = useState<{ started: true } | { started: false; error: string }>();
  const [reviewing, setReviewing] = useState(false);
  const runReview = async () => {
    setReviewing(true);
    try {
      const r = await act('run_stock_review', {});
      setReview('declined' in r ? undefined : { started: true });
    } catch (err) {
      setReview({ started: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setReviewing(false);
    }
  };
  const canOperate = useCan('operator');
  const canAdmin = useCan('admin');
  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="What the warehouse and each store hold, what running orders have reserved, and when an item is reordered."
      />
      <Body className="grid gap-4">
        <FindBar q={q} label="Find a product, SKU or store" />
        <Section
          id="stock"
          title="Warehouse"
          description={`Warehouse stock. Stores keep their own, below. Reserved stock is held by running orders.${canOperate ? ' A stock review starts a replenishment order for anything at or below its reorder point.' : ''}`}
          actions={
            <>
              <Total list={inventory} noun="item" />
              {canOperate ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={reviewing}
                  onClick={() => void runReview()}
                >
                  <RefreshCw aria-hidden="true" />
                  {reviewing ? 'Confirm it in the assistant' : 'Run stock review now'}
                </Button>
              ) : null}
            </>
          }
          flush
        >
          {review ? (
            <p
              role={review.started ? 'status' : 'alert'}
              className={`px-(--card-spacing) pb-3 text-sm ${review.started ? '' : 'text-bad'}`}
            >
              {review.started ? (
                <>
                  Stock review started. If any item is at or below its reorder point, a
                  replenishment order appears in{' '}
                  <Link to="/orders?model=replenishment" className="text-link hover:underline">
                    Orders
                  </Link>
                  .
                </>
              ) : (
                review.error
              )}
            </p>
          ) : null}
          {inventory.total || q ? (
            <Table stack="cards" scroll caption="Warehouse stock">
              <TableHead>
                <Tr>
                  <Th>Item</Th>
                  <Th numeric>Available</Th>
                  <Th numeric>Reserved</Th>
                  <Th numeric>Reorder at</Th>
                  <Th numeric>Price</Th>
                </Tr>
              </TableHead>
              <TableBody>
                {inventory.rows.map((p) => {
                  const available = p.stock - p.reserved;
                  // The stock review reorders anything at or below its reorder point.
                  const level = available <= 0 ? 'Out' : available <= p.reorderPoint ? 'Low' : null;
                  return (
                    <Tr key={p.sku} id={`sku-${p.sku}`} className="scroll-mt-20 target:bg-muted/60">
                      <Td>
                        {p.name}
                        <span className="ml-1.5 whitespace-nowrap font-mono text-muted-foreground text-xs">
                          {p.sku}
                        </span>
                      </Td>
                      {p.kind === 'digital' ? (
                        <Td colSpan={3} className="text-right text-muted-foreground">
                          Digital, no stock
                        </Td>
                      ) : (
                        <>
                          <Td
                            numeric
                            label="Available"
                            className={cn(
                              level === 'Out' && 'font-medium text-bad',
                              level === 'Low' && 'font-medium text-wait',
                            )}
                          >
                            {count(available)}
                            {level ? (
                              <span className="ml-1.5 text-xs">
                                {level === 'Out' ? 'out' : 'low'}
                                <span className="sr-only"> stock</span>
                              </span>
                            ) : null}
                            {level === 'Out' && p.inStores > 0 ? (
                              <span className="block font-normal text-muted-foreground text-xs">
                                {count(p.inStores)} in stores
                              </span>
                            ) : null}
                          </Td>
                          <Td numeric label="Reserved" className="text-muted-foreground">
                            <Held sku={p.sku} n={p.reserved} />
                          </Td>
                          <Td numeric label="Reorder at" className="text-muted-foreground">
                            {p.reorderPoint ? count(p.reorderPoint) : 'Not reordered'}
                          </Td>
                        </>
                      )}
                      <Td numeric label="Price">
                        {money(p.price)}
                      </Td>
                    </Tr>
                  );
                })}
                {q && !inventory.total ? (
                  <TableEmpty colSpan={5}>No products match “{q}”.</TableEmpty>
                ) : null}
              </TableBody>
            </Table>
          ) : (
            <Empty>No products yet.</Empty>
          )}
          <Pager list={inventory} listKey="inventory" hash="stock" label="Warehouse stock" />
          {canAdmin ? <ProductIndexUpdate /> : null}
        </Section>
        <Section
          id="stores"
          title="Stores"
          description="Each store’s own stock, for pickup and store sales. A pickup or store sale draws from the store."
          flush
        >
          {stores.length ? (
            <Table stack="cards" scroll caption="Stores">
              <TableHead>
                <Tr>
                  <Th>Item</Th>
                  <Th numeric>Available</Th>
                  <Th numeric>Reserved</Th>
                  <Th numeric>On hand</Th>
                </Tr>
              </TableHead>
              {stores.map((l) => (
                <TableBody
                  key={l.id}
                  className="divide-y-0 border-b last:border-b-0 [&>tr:last-child>td]:pb-2.5"
                >
                  <Tr>
                    <Th
                      scope="rowgroup"
                      colSpan={4}
                      className="whitespace-normal pt-2 pb-0.5 normal-case tracking-normal"
                    >
                      <span className="font-medium text-foreground text-sm">{l.name}</span>
                      <span className="ml-2 font-normal text-muted-foreground text-xs">
                        {[l.pickup ? 'Pickup' : null, l.ships ? 'Ships orders' : null]
                          .filter(Boolean)
                          .join(' · ') || 'In-store sales only'}
                      </span>
                    </Th>
                  </Tr>
                  {l.stock.total ? (
                    l.stock.rows.map((s) => (
                      <Tr key={s.sku}>
                        <Td className="py-1 pl-8">
                          {s.name ?? s.sku}
                          <a
                            href={`#sku-${s.sku}`}
                            className="ml-1.5 whitespace-nowrap font-mono text-muted-foreground text-xs hover:text-foreground hover:underline"
                          >
                            {s.sku}
                          </a>
                        </Td>
                        <Td numeric label="Available" className="py-1">
                          {count(s.stock - s.reserved)}
                        </Td>
                        <Td numeric label="Reserved" className="py-1 text-muted-foreground">
                          <Held sku={s.sku} n={s.reserved} />
                        </Td>
                        <Td numeric label="On hand" className="py-1 text-muted-foreground">
                          {count(s.stock)}
                        </Td>
                      </Tr>
                    ))
                  ) : (
                    <Tr>
                      <Td colSpan={4} className="py-1 pl-8 text-muted-foreground text-xs">
                        {q ? 'No stock matches.' : 'No stock held here.'}
                      </Td>
                    </Tr>
                  )}
                  {l.stock.total > l.stock.size ? (
                    <Tr>
                      <Td colSpan={4} className="p-0">
                        <Pager
                          list={l.stock}
                          listKey={storeKey(l.id)}
                          hash="stores"
                          label={`${l.name} stock`}
                          inset
                        />
                      </Td>
                    </Tr>
                  ) : null}
                </TableBody>
              ))}
            </Table>
          ) : (
            <Empty>No stores yet.</Empty>
          )}
        </Section>
      </Body>
    </>
  );
}

/**
 * An admin's run of the product index now, rather than at the next hourly update: after a large
 * import, say. It answers with what the run did; the page around it doesn't change.
 */
function ProductIndexUpdate() {
  const f = useFetcher<typeof action>();
  const running = f.state !== 'idle';
  const r = f.data && 'productIndex' in f.data ? f.data.productIndex : null;
  return (
    <f.Form
      method="post"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t bg-muted/50 px-4 py-3"
    >
      <input type="hidden" name="intent" value="product-index" />
      <Button type="submit" size="sm" variant="outline" disabled={running}>
        {running ? 'Updating index…' : 'Update product index'}
      </Button>
      <p
        aria-live="polite"
        className={cn(
          'min-w-0 flex-1 basis-56 text-xs',
          r && !r.ok ? 'text-bad' : 'text-muted-foreground',
        )}
      >
        {r
          ? r.ok
            ? r.message
            : r.error
          : 'Order extraction finds products by meaning once they are in the index, which updates hourly. Update it now after a large import.'}
      </p>
    </f.Form>
  );
}
