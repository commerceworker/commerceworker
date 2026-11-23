export type CatalogOrderLine = {
  sku: string;
  name: string;
  price: number;
  weightKg: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  /** The product's tax class; null (or absent, from an older message) is the standard rate. */
  taxClass?: string | null;
};

/** Catalog-owned fields only; older and equal timestamps must never replace a row.
 * Missing shipping fields and tax class from older queue messages clear the stored values.
 * Stock, cost, reservations and other commerce-owned fields are preserved.
 */
export interface CatalogOrders {
  apply(rows: { line: CatalogOrderLine; at: number }[]): Promise<void>;
}
