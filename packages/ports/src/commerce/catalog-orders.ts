export type CatalogOrderLine = {
  sku: string;
  name: string;
  price: number;
  weightKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
};

/** Catalog-owned fields only; older and equal timestamps must never replace a row.
 * Missing shipping fields from older queue messages clear the stored values.
 * Stock, cost, reservations and other commerce-owned fields are preserved.
 */
export interface CatalogOrders {
  apply(rows: { line: CatalogOrderLine; at: number }[]): Promise<void>;
}
