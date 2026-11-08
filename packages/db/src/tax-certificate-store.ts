/**
 * The tax certificates port (`TaxCertificateStore`, @commerceworker/ports/commerce) on D1: the
 * `tax_certificates` table. Moved here from the engine. The contract in
 * @commerceworker/test-kit/commerce holds this and the in-memory store to the same behaviour.
 */
import type { TaxCertificate, TaxPlace } from '@commerceworker/core';
import type { TaxCertificateStore } from '@commerceworker/ports/commerce';
import { and, asc, count, eq } from 'drizzle-orm';
import { createDb } from './index';
import { taxCertificates } from './schema';

type Row = typeof taxCertificates.$inferSelect;

function certificateOf(r: Row): TaxCertificate {
  return {
    id: r.id,
    customerId: r.customerId,
    number: r.number,
    regions: JSON.parse(r.regions) as TaxPlace[],
    expiresAt: r.expiresAt,
    file:
      r.fileKey && r.fileName && r.fileType && r.fileSize !== null
        ? { key: r.fileKey, name: r.fileName, type: r.fileType, size: r.fileSize }
        : null,
    status: r.status === 'revoked' ? 'revoked' : 'active',
    createdBy: r.createdBy,
    createdById: r.createdById,
    createdAt: r.createdAt,
    verifiedBy: r.verifiedBy,
    verifiedAt: r.verifiedAt,
    revokedBy: r.revokedBy,
    revokedAt: r.revokedAt,
  };
}

export function d1TaxCertificateStore(d1: D1Database): TaxCertificateStore {
  const d = createDb(d1);
  const mine = (customerId: string, id: string) =>
    and(eq(taxCertificates.id, id), eq(taxCertificates.customerId, customerId));
  return {
    async forCustomer(customerId) {
      const rows = await d
        .select()
        .from(taxCertificates)
        .where(eq(taxCertificates.customerId, customerId))
        .orderBy(asc(taxCertificates.createdAt), asc(taxCertificates.id));
      return rows.map(certificateOf);
    },

    async find(customerId, id) {
      const row = await d.select().from(taxCertificates).where(mine(customerId, id)).get();
      return row ? certificateOf(row) : undefined;
    },

    async count(customerId) {
      const row = await d
        .select({ n: count() })
        .from(taxCertificates)
        .where(eq(taxCertificates.customerId, customerId))
        .get();
      return row?.n ?? 0;
    },

    async add(c) {
      const res = await d
        .insert(taxCertificates)
        .values({
          id: c.id,
          customerId: c.customerId,
          number: c.number,
          regions: JSON.stringify(c.regions),
          expiresAt: c.expiresAt,
          fileKey: c.file?.key ?? null,
          fileName: c.file?.name ?? null,
          fileType: c.file?.type ?? null,
          fileSize: c.file?.size ?? null,
          status: c.status,
          createdBy: c.createdBy,
          createdById: c.createdById,
          createdAt: c.createdAt,
        })
        .onConflictDoNothing()
        .returning({ id: taxCertificates.id });
      return res.length > 0;
    },

    async verify(customerId, id, by, at) {
      await d
        .update(taxCertificates)
        .set({ verifiedBy: by, verifiedAt: at })
        .where(mine(customerId, id));
    },

    async revoke(customerId, id, by, at) {
      await d
        .update(taxCertificates)
        .set({ status: 'revoked', revokedBy: by, revokedAt: at })
        .where(mine(customerId, id));
    },
  };
}
