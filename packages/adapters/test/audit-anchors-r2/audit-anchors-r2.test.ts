import { AUDIT_ANCHOR_LOOKBACK_DAYS, auditAnchorKey } from '@commerceworker/core';
import { describeAuditAnchorsContract } from '@commerceworker/test-kit/commerce';
import { describe, expect, it } from 'vitest';
import { createR2AuditAnchors, type R2AnchorBucketLike } from '../../src/audit-anchors-r2/index';

/** An R2 bucket in memory that honours `onlyIf.etagDoesNotMatch: '*'` and lists keys in order. */
function bucket() {
  const objects = new Map<string, string>();
  const like: R2AnchorBucketLike = {
    async put(key, value, options) {
      if (options?.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null;
      objects.set(key, value);
      return { key };
    },
    async get(key) {
      const v = objects.get(key);
      return v === undefined ? null : { text: async () => v };
    },
    async list({ prefix = '' }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { objects: keys.map((key) => ({ key })), truncated: false };
    },
  };
  return { objects, like };
}

const layout = { keyOf: auditAnchorKey, lookbackDays: AUDIT_ANCHOR_LOOKBACK_DAYS };

describeAuditAnchorsContract('R2', async () => createR2AuditAnchors(bucket().like, layout));

describe('the R2 audit anchors', () => {
  it('writes each anchor under audit/anchors/<date>/<hour>.json', async () => {
    const b = bucket();
    const at = Date.UTC(2026, 10, 13, 9, 30);
    await createR2AuditAnchors(b.like, layout).write({
      seq: 3,
      hash: 'abc',
      eventId: 'aud_3',
      eventAt: at - 5,
      anchoredAt: at,
    });
    expect([...b.objects.keys()]).toEqual(['audit/anchors/2026-11-13/09.json']);
  });
});
