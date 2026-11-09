import type { RpcActor } from '@commerceworker/core';
import { FixedClock } from '@commerceworker/test-kit';
import {
  InMemoryPricingStore,
  InMemoryTaxCertificateStore,
  PRICING_FIXTURE,
} from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import {
  addTaxCertificate,
  listTaxCertificates,
  revokeTaxCertificate,
  verifyTaxCertificate,
} from '../src/commerce';

const NOW = Date.UTC(2026, 9, 27, 12);
const DAY = 86_400_000;
const ann: RpcActor = { kind: 'staff', id: 'usr_ann', name: 'ann@example.com', role: 'operator' };
const bo: RpcActor = { kind: 'staff', id: 'usr_bo', name: 'bo@example.com', role: 'operator' };
const customer = PRICING_FIXTURE.customers![0]!.id;

function ports() {
  return {
    certificates: new InMemoryTaxCertificateStore(),
    pricing: new InMemoryPricingStore(PRICING_FIXTURE, new FixedClock()),
  };
}
const input = (over: Record<string, unknown> = {}) => ({
  id: 'txc_1',
  number: 'RS-1',
  regions: [{ country: 'US', region: 'CA' }],
  expiresAt: null,
  file: null,
  ...over,
});

describe('tax exemption certificates', () => {
  it('adds one unverified, once per id, and only for a customer on file', async () => {
    const p = ports();
    const added = await addTaxCertificate(p, customer, input(), ann, NOW);
    expect(added).toMatchObject({
      ok: true,
      value: {
        changed: true,
        certificate: { id: 'txc_1', status: 'active', verifiedAt: null, createdById: 'usr_ann' },
      },
    });
    // A retried request answers with the one already there.
    expect(
      await addTaxCertificate(p, customer, input({ number: 'OTHER' }), ann, NOW),
    ).toMatchObject({
      ok: true,
      value: { changed: false, certificate: { number: 'RS-1' } },
    });
    expect(await addTaxCertificate(p, 'pc_nobody', input(), ann, NOW)).toEqual({
      ok: false,
      error: 'No such customer.',
    });
    expect((await addTaxCertificate(p, customer, input({ id: 'bad id' }), ann, NOW)).ok).toBe(
      false,
    );
    expect((await listTaxCertificates(p, customer))?.map((c) => c.id)).toEqual(['txc_1']);
    expect(await listTaxCertificates(p, 'pc_nobody')).toBeNull();
  });

  it('is verified by someone other than whoever added it while separation is on, once', async () => {
    const p = ports();
    await addTaxCertificate(p, customer, input(), ann, NOW);
    const on = async () => true;
    expect(await verifyTaxCertificate(p, customer, 'txc_1', ann, NOW, on)).toEqual({
      ok: false,
      error: 'Someone other than whoever added the certificate must verify it.',
    });
    expect(await verifyTaxCertificate(p, customer, 'txc_1', bo, NOW, on)).toMatchObject({
      ok: true,
      value: { changed: true, certificate: { verifiedBy: 'bo@example.com', verifiedAt: NOW } },
    });
    // Verifying it again changes nothing.
    expect(await verifyTaxCertificate(p, customer, 'txc_1', bo, NOW + 1, on)).toMatchObject({
      ok: true,
      value: { changed: false, certificate: { verifiedAt: NOW } },
    });
    expect(await verifyTaxCertificate(p, customer, 'txc_none', bo, NOW, on)).toEqual({
      ok: false,
      error: 'No such certificate.',
    });
  });

  it('refuses to verify an expired or revoked one, and revokes once, keeping it', async () => {
    const p = ports();
    const off = async () => false;
    await addTaxCertificate(p, customer, input({ id: 'txc_old', expiresAt: NOW - DAY }), ann, NOW);
    expect(await verifyTaxCertificate(p, customer, 'txc_old', bo, NOW, off)).toEqual({
      ok: false,
      error: 'The certificate has expired; add the renewed one.',
    });
    await addTaxCertificate(p, customer, input(), ann, NOW);
    expect(await revokeTaxCertificate(p, customer, 'txc_1', bo, NOW)).toMatchObject({
      ok: true,
      value: { changed: true, certificate: { status: 'revoked', revokedBy: 'bo@example.com' } },
    });
    expect(await revokeTaxCertificate(p, customer, 'txc_1', bo, NOW + 1)).toMatchObject({
      ok: true,
      value: { changed: false },
    });
    expect(await verifyTaxCertificate(p, customer, 'txc_1', bo, NOW, off)).toEqual({
      ok: false,
      error: 'The certificate was revoked; add a new one.',
    });
    expect((await listTaxCertificates(p, customer))?.map((c) => c.status).sort()).toEqual([
      'active',
      'revoked',
    ]);
  });
});
