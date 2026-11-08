import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type Connection,
  createManagementClient,
  RequestTimeoutError,
} from '~/cms/lib/management';

const conn: Connection = { space: 's1', environment: 'main', locale: 'en-US' };

/** A server that never answers, and doesn't notice the abort either. */
const never = () => vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
const hung = () => createManagementClient(conn, never());

/** What became of `p` by `ms`: `pending` until then. */
async function after<T>(p: Promise<T>, ms: number) {
  let outcome: { rejected: unknown } | { resolved: T } | 'pending' = 'pending';
  p.then(
    (resolved) => {
      outcome = { resolved };
    },
    (rejected) => {
      outcome = { rejected };
    },
  );
  await vi.advanceTimersByTimeAsync(ms);
  return outcome as { rejected: unknown } | { resolved: T } | 'pending';
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('request timeout', () => {
  it('gives up on a write after 30s, saying it may still have gone through', async () => {
    const save = hung().createRelease({ title: 'Spring' });
    expect(await after(save, 29_999)).toBe('pending');
    const outcome = await after(save, 1);
    const err = (outcome as { rejected: RequestTimeoutError }).rejected;
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect(err.write).toBe(true);
    expect(err.message).toContain('didn’t confirm');
    expect(err.message).toContain('check before you try again');
    expect(err.message).not.toMatch(/nothing was (saved|changed)/i);
  });

  it('aborts the request it gave up on', async () => {
    const fn = never();
    const save = createManagementClient(conn, fn).createRelease({ title: 'Spring' });
    await after(save, 30_000);
    const init = (fn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(init.signal?.aborted).toBe(true);
  });

  it.each([
    ['a bulk change', (c: Client) => c.bulkEntryAction('publish', ['e1']), 120_000],
    ['a release going live', (c: Client) => c.publishRelease('r1'), 120_000],
    ['a redirect import', (c: Client) => c.importRedirects({ format: 'csv', data: 'x' }), 120_000],
    [
      'a plugin install',
      (c: Client) =>
        c.installPlugin({ manifest: {} as never, bundle: '', approvedCapabilities: [] }),
      120_000,
    ],
    ['a whole import', (c: Client) => c.runImport({} as never), 300_000],
    ['an environment merge', (c: Client) => c.mergeEnvironments({} as never), 300_000],
    ['a space with sample content', (c: Client) => c.createSpace({} as never), 300_000],
  ])('gives %s longer', async (_name, call, limit) => {
    const write = call(hung());
    expect(await after(write as Promise<unknown>, limit - 1)).toBe('pending');
    const outcome = await after(write as Promise<unknown>, 1);
    expect((outcome as { rejected: RequestTimeoutError }).rejected.write).toBe(true);
  });

  it.each([
    [
      'a dry run',
      (c: Client) => c.importRedirects({ format: 'csv', data: 'x', dryRun: true }),
      120_000,
    ],
    ['fetching a package', (c: Client) => c.inspectPluginPackage({ packageUrl: 'x' }), 120_000],
    ['a model draft', (c: Client) => c.generateEntry({} as never), 180_000],
  ])('says a read changed nothing: %s', async (_name, call, limit) => {
    const read = call(hung());
    expect(await after(read as Promise<unknown>, limit - 1)).toBe('pending');
    const outcome = await after(read as Promise<unknown>, 1);
    const err = (outcome as { rejected: RequestTimeoutError }).rejected;
    expect(err.write).toBe(false);
    expect(err.message).toContain('nothing was changed');
  });

  it('leaves GETs to run', async () => {
    expect(await after(hung().listContentTypes(), 3_600_000)).toBe('pending');
  });

  it('leaves a file upload to run as long as its bytes do', async () => {
    const put = hung().putUploadPart('/media/part', new Blob(['x']));
    expect(await after(put, 3_600_000)).toBe('pending');
  });

  it('a caller’s abort stays an abort, not a timeout', async () => {
    const fn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('x', 'AbortError')),
          );
        }),
    ) as unknown as typeof fetch;
    const stop = new AbortController();
    const draft = createManagementClient(conn, fn).generateEntry({} as never, stop.signal);
    stop.abort();
    const outcome = await after(draft, 0);
    expect((outcome as { rejected: Error }).rejected).not.toBeInstanceOf(RequestTimeoutError);
  });

  it('an answer in time clears the clock, and a refusal stays a refusal', async () => {
    const ok = vi.fn(async () => Response.json({ id: 'r1' })) as unknown as typeof fetch;
    await expect(createManagementClient(conn, ok).createRelease({ title: 'x' })).resolves.toEqual({
      id: 'r1',
    });
    expect(vi.getTimerCount()).toBe(0);

    const no = vi.fn(async () => new Response('{}', { status: 409 })) as unknown as typeof fetch;
    await expect(
      createManagementClient(conn, no).createRelease({ title: 'x' }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

type Client = ReturnType<typeof createManagementClient>;
