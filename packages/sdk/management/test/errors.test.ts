import { describe, expect, it, vi } from 'vitest';
import {
  createManagementClient,
  isAssetInUse,
  isAssetRightsError,
  isConflict,
  isNotFound,
  isRateLimited,
  isValidationError,
  ManagementError,
} from '../src/index.js';

const base = { baseUrl: 'https://cms.test', space: 's1', environment: 'main', token: 'cma-tok' };

/** A client whose every request is answered `status` with `body`. */
function answering(status: number, body: unknown) {
  const fetchImpl = vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
  return createManagementClient({ ...base, fetch: fetchImpl });
}

const failure = (p: Promise<unknown>) => p.then(() => expect.fail('resolved')).catch((e) => e);

describe('ManagementError', () => {
  it('reads code and the error object from the api envelope', async () => {
    const err = await failure(
      answering(404, {
        error: { code: 'not_found', message: 'Asset "a1" was not found' },
      }).assets.get('a1'),
    );
    expect(err).toBeInstanceOf(ManagementError);
    expect(err).toMatchObject({
      status: 404,
      code: 'not_found',
      error: { code: 'not_found', message: 'Asset "a1" was not found' },
    });
    expect(isNotFound(err)).toBe(true);
    expect(isConflict(err)).toBe(false);
  });

  it('reads the flat body of a refusal made before the route runs (413, request-rate 429)', async () => {
    const err = await failure(
      answering(429, { code: 'rate_limited', message: 'Too many requests' }).assets.list(),
    );
    expect(err).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(isRateLimited(err)).toBe(true);
  });

  it('has no code for a body without one, or no JSON body at all', async () => {
    const legacy = await failure(answering(422, { error: 'Validation failed' }).assets.list());
    expect(legacy).toMatchObject({ status: 422, body: { error: 'Validation failed' } });
    expect(legacy.code).toBeUndefined();
    expect(legacy.error).toBeUndefined();

    const text = await failure(answering(500, 'nope').assets.list());
    expect(text).toMatchObject({ status: 500, body: undefined });
    expect(text.code).toBeUndefined();
  });
});

describe('error guards', () => {
  it('isAssetInUse narrows to the links and their count', async () => {
    const err = await failure(
      answering(409, {
        error: {
          code: 'asset_in_use',
          message: 'Asset "a1" is linked from 51 entries',
          usage: [
            {
              fromEntryId: 'e1',
              fromField: 'hero',
              toId: 'a1',
              toType: 'Asset',
              contentTypeApiId: 'article',
              entryTitle: 'Hello',
            },
          ],
          total: 51,
        },
      }).assets.delete('a1'),
    );
    expect(isAssetInUse(err)).toBe(true);
    if (!isAssetInUse(err)) return;
    // Typed without a cast: this would not compile were the guard not narrowing.
    const titles: (string | undefined)[] = err.error.usage.map((u) => u.entryTitle);
    expect(titles).toEqual(['Hello']);
    expect(err.error.total).toBe(51);
    expect(isAssetRightsError(err)).toBe(false);
  });

  it('isAssetInUse refuses a body that names the code but not the links', () => {
    const err = new ManagementError(409, 'x', { error: { code: 'asset_in_use', message: 'x' } });
    expect(isAssetInUse(err)).toBe(false);
  });

  it('isAssetRightsError narrows an embargo to embargoUntil and an expiry to expiresAt', async () => {
    const embargoed = await failure(
      answering(409, {
        error: {
          code: 'asset_embargoed',
          message: 'under embargo',
          embargoUntil: '2027-01-01T00:00:00.000Z',
        },
      }).assets.publish('a1'),
    );
    expect(isAssetRightsError(embargoed)).toBe(true);
    if (isAssetRightsError(embargoed) && embargoed.error.code === 'asset_embargoed') {
      expect(embargoed.error.embargoUntil).toBe('2027-01-01T00:00:00.000Z');
    } else {
      expect.fail('not narrowed to asset_embargoed');
    }

    const expired = await failure(
      answering(409, {
        error: { code: 'asset_expired', message: 'expired', expiresAt: '2025-01-01T00:00:00.000Z' },
      }).assets.publish('a1'),
    );
    expect(isAssetRightsError(expired)).toBe(true);
    if (isAssetRightsError(expired) && expired.error.code === 'asset_expired') {
      expect(expired.error.expiresAt).toBe('2025-01-01T00:00:00.000Z');
    } else {
      expect.fail('not narrowed to asset_expired');
    }

    // The code with the other code's date is not the shape the api sends.
    const crossed = new ManagementError(409, 'x', {
      error: { code: 'asset_expired', message: 'x', embargoUntil: '2027-01-01T00:00:00.000Z' },
    });
    expect(isAssetRightsError(crossed)).toBe(false);
  });

  it('isValidationError narrows to the field issues', async () => {
    const err = await failure(
      answering(422, {
        error: {
          code: 'validation_failed',
          message: 'One or more fields are invalid',
          issues: [{ field: 'focalPoint', message: 'between 0 and 1' }],
        },
      }).assets.setMetadata('a1', { focalPoint: { x: 2, y: 0 } }),
    );
    expect(isValidationError(err)).toBe(true);
    if (isValidationError(err)) expect(err.error.issues[0]?.field).toBe('focalPoint');
  });

  it('isConflict matches only the conflict code, and no guard matches a non-ManagementError', async () => {
    const err = await failure(
      answering(409, { error: { code: 'conflict', message: 'taken' } }).assets.renditions.create({
        name: 'thumb',
      }),
    );
    expect(isConflict(err)).toBe(true);
    expect(isAssetInUse(err)).toBe(false);

    const plain = Object.assign(new Error('x'), { error: { code: 'conflict' } });
    for (const guard of [
      isAssetInUse,
      isAssetRightsError,
      isConflict,
      isNotFound,
      isRateLimited,
      isValidationError,
    ]) {
      expect(guard(plain)).toBe(false);
      expect(guard(undefined)).toBe(false);
    }
  });
});
