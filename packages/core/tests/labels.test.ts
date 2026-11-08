import { describe, expect, it } from 'vitest';
import { builtInTracking, planPackages, shipmentKey } from '../src';

describe('shipping labels', () => {
  it('keys shipments by order and step', () => {
    expect(shipmentKey('shp', 'ord 1', 'ship#2')).toBe('shp_ord_1_ship_2');
  });

  it('plans one package per place, central first, the first keeping the base ref', () => {
    const packages = planPackages(
      { fulfillment: { locationId: 'soho' } as never },
      [
        { sku: 'A', qty: 1, locationId: 'bk' },
        { sku: 'B', qty: 2 },
        { sku: 'C', qty: 1, locationId: 'bk' },
      ],
      'shp_o',
    );
    expect(packages).toEqual([
      {
        ref: 'shp_o',
        locationId: 'bk',
        lines: [
          { sku: 'A', qty: 1 },
          { sku: 'C', qty: 1 },
        ],
      },
      { ref: 'shp_o_2', locationId: 'soho', lines: [{ sku: 'B', qty: 2 }] },
    ]);
    expect(planPackages({}, [], 'shp_o')).toEqual([{ ref: 'shp_o', locationId: null, lines: [] }]);
  });

  it('gives built-in labels a stable tracking number', () => {
    const t = builtInTracking('ups', 'shp_o', 'shipment');
    expect(t).toMatch(/^UPS\d{10}$/);
    expect(builtInTracking('ups', 'shp_o', 'shipment')).toBe(t);
    expect(builtInTracking('dhl', 'rma_o', 'return')).toMatch(/^DHLR\d{9}$/);
  });
});
