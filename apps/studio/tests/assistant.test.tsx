// @vitest-environment jsdom
// The assistant's state (cms/lib/assistant.tsx): the queue of edits pages hand it, the cards they
// wait on, the open state it remembers, the page context it reads, and pages making their own edits
// whenever the assistant isn't there to take them.
import type { AssistantContext, AssistantPage } from '@commerceworker/domain';
import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const conn = { space: 'sp_1', environment: 'main', locale: 'en-US' };
vi.mock('~/cms/lib/client-context', () => ({ useClient: () => ({ conn }) }));

const {
  AssistantProvider,
  AssistantUnavailable,
  orDirect,
  TAKE_TIMEOUT_MS,
  useAssistant,
  useAssistantEdit,
  usePageContext,
} = await import('~/cms/lib/assistant');
const { FeaturesProvider } = await import('~/cms/lib/features');

const wrapper = ({ children }: { children: ReactNode }) => (
  <AssistantProvider>{children}</AssistantProvider>
);

/** jsdom's matchMedia, answering `matches` for the wide (lg) query. */
const mediaWide = (wide: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: wide && query.includes('min-width: 1024px'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the act queue', () => {
  it('queues an edit with the scope in its input and the page as it was, and hands it over once', () => {
    const { result } = renderHook(() => useAssistant(), { wrapper });
    act(() => {
      void result.current.act('entries_update', { id: 'e1', fields: {} }, 'Spring notes');
    });
    expect(result.current.acts).toHaveLength(1);
    const [q] = result.current.acts;
    expect(q?.input).toEqual({ space: 'sp_1', environment: 'main', id: 'e1', fields: {} });
    expect(q?.context).toEqual({
      scope: { spaceId: 'sp_1', environmentId: 'main', locale: 'en-US' },
      page: { kind: 'everything' },
    });
    expect(q?.about).toBe('Spring notes');

    let taken: unknown[] = [];
    act(() => {
      taken = result.current.takeActs();
    });
    expect(taken).toHaveLength(1);
    expect(result.current.acts).toHaveLength(0);
    // A second take (an effect run twice) finds nothing: the edit is never sent twice.
    expect(result.current.takeActs()).toHaveLength(0);
  });

  it('settles a card the page waits on with its output, a decline, or the error, once', async () => {
    const { result } = renderHook(() => useAssistant(), { wrapper });
    let published!: Promise<unknown>;
    let declined!: Promise<unknown>;
    let failed!: Promise<unknown>;
    act(() => {
      published = result.current.act('entries_publish', { id: 'e1' });
      declined = result.current.act('entries_trash', { id: 'e2' });
      failed = result.current.act('entries_unpublish', { id: 'e3' });
    });
    const [p, d, f] = result.current.takeActs();
    if (!p || !d || !f) throw new Error('three edits were queued');
    result.current.awaitAnswer('direct_1', p);
    result.current.awaitAnswer('direct_2', d);
    result.current.awaitAnswer('direct_3', f);

    result.current.answered('direct_1', { output: { id: 'e1', publishedVersion: 3 } });
    // Settled once: a second answer (the message syncing after `resolve`) changes nothing.
    result.current.answered('direct_1', { declined: true });
    result.current.answered('direct_2', { declined: true });
    result.current.answered('direct_3', new Error('You can’t publish in this space'));
    result.current.answered('direct_unknown', { declined: true });

    await expect(published).resolves.toEqual({ output: { id: 'e1', publishedVersion: 3 } });
    await expect(declined).resolves.toEqual({ declined: true });
    await expect(failed).rejects.toThrow('You can’t publish in this space');
  });

  it('hands an edit back as never sent when no panel takes it in time', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAssistant(), { wrapper });
    let edit!: Promise<unknown>;
    act(() => {
      edit = result.current.act('entries_update', { id: 'e1', fields: {} });
    });
    const settled = expect(edit).rejects.toBeInstanceOf(AssistantUnavailable);
    act(() => {
      vi.advanceTimersByTime(TAKE_TIMEOUT_MS);
    });
    await settled;
    expect(result.current.acts).toHaveLength(0);
  });
});

describe('useAssistantEdit', () => {
  it('is null outside the shell, so a screen on its own edits through the API', async () => {
    const { result } = renderHook(() => useAssistantEdit());
    await expect(result.current('entries_publish', { id: 'e1' })).resolves.toBeNull();
    await expect(orDirect(null, async () => 'direct')).resolves.toEqual({ output: 'direct' });
  });

  it('is null with the assistant switched off, and nothing is queued', async () => {
    const { result } = renderHook(() => ({ edit: useAssistantEdit(), a: useAssistant() }), {
      wrapper: ({ children }) => (
        <FeaturesProvider value={{ assistant: false }}>
          <AssistantProvider>{children}</AssistantProvider>
        </FeaturesProvider>
      ),
    });
    await expect(result.current.edit('entries_publish', { id: 'e1' })).resolves.toBeNull();
    expect(result.current.a.acts).toHaveLength(0);
    expect(result.current.a.enabled).toBe(false);
  });

  it('is null when the edit was never sent, and passes on a refusal and a decline', async () => {
    const { result } = renderHook(() => ({ edit: useAssistantEdit(), a: useAssistant() }), {
      wrapper,
    });
    let never!: Promise<unknown>;
    let refused!: Promise<unknown>;
    let declined!: Promise<unknown>;
    act(() => {
      never = result.current.edit('entries_update', { id: 'e1', fields: {} });
      refused = result.current.edit('entries_publish', { id: 'e2' });
      declined = result.current.edit('entries_trash', { id: 'e3' });
    });
    const [n, r, d] = result.current.a.takeActs();
    n?.reject(new AssistantUnavailable());
    r?.reject(new Error('Publish blocked by moderation'));
    d?.resolve({ declined: true });
    await expect(never).resolves.toBeNull();
    await expect(refused).rejects.toThrow('Publish blocked by moderation');
    await expect(declined).resolves.toEqual({ declined: true });
    await expect(orDirect({ declined: true }, async () => 'unused')).resolves.toEqual({
      declined: true,
    });
  });
});

describe('the open state', () => {
  it('is remembered, and reopens the column on a wide screen', () => {
    mediaWide(true);
    const first = renderHook(() => useAssistant(), { wrapper });
    expect(first.result.current.open).toBe(false);
    act(() => first.result.current.setOpen(true));
    expect(localStorage.getItem('cw-assistant-open')).toBe('1');
    first.unmount();

    const again = renderHook(() => useAssistant(), { wrapper });
    expect(again.result.current.open).toBe(true);
  });

  it('starts closed below lg, where it would be a sheet over the page', () => {
    mediaWide(false);
    localStorage.setItem('cw-assistant-open', '1');
    const { result } = renderHook(() => useAssistant(), { wrapper });
    expect(result.current.open).toBe(false);
  });

  it('focus opens it and asks for the prompt', () => {
    const { result } = renderHook(() => useAssistant(), { wrapper });
    const before = result.current.focusToken;
    act(() => result.current.focus());
    expect(result.current.open).toBe(true);
    expect(result.current.focusToken).toBe(before + 1);
  });
});

describe('the page context', () => {
  const ENTRY: AssistantPage = {
    kind: 'entry',
    entryId: 'e1',
    contentType: 'article',
    label: 'Spring launch notes',
  };

  function Page({ page }: { page: AssistantPage }) {
    usePageContext(() => page, [page]);
    return null;
  }
  function Chip() {
    const a = useAssistant();
    return <p>{a.page.kind === 'everything' ? 'Everything' : a.page.label}</p>;
  }

  it('is the page in front while it is mounted, and everything once it leaves', () => {
    let read: () => AssistantContext = () => {
      throw new Error('not rendered');
    };
    function Reader() {
      read = useAssistant().readContext;
      return null;
    }
    const view = render(
      <AssistantProvider>
        <Page page={ENTRY} />
        <Chip />
        <Reader />
      </AssistantProvider>,
    );
    expect(screen.getByText('Spring launch notes')).toBeTruthy();
    expect(read()).toEqual({
      scope: { spaceId: 'sp_1', environmentId: 'main', locale: 'en-US' },
      page: ENTRY,
    });
    view.rerender(
      <AssistantProvider>
        <Chip />
        <Reader />
      </AssistantProvider>,
    );
    expect(screen.getByText('Everything')).toBeTruthy();
    expect(read().page).toEqual({ kind: 'everything' });
  });

  it('asks about everything when the chip says so, while edits keep the page they came from', () => {
    let a!: ReturnType<typeof useAssistant>;
    function Grab() {
      a = useAssistant();
      return null;
    }
    render(
      <AssistantProvider>
        <Page page={ENTRY} />
        <Grab />
      </AssistantProvider>,
    );
    act(() => a.setScope('everything'));
    expect(a.readContext().page).toEqual({ kind: 'everything' });
    act(() => {
      void a.act('entries_publish', { id: 'e1' });
    });
    expect(a.acts[0]?.context.page).toEqual(ENTRY);
  });
});

describe('what act accepts', () => {
  it('hands an input too big for the agent back to the page, and trims a long label', async () => {
    const { result } = renderHook(() => ({ edit: useAssistantEdit(), a: useAssistant() }), {
      wrapper,
    });
    const huge = { id: 'e1', fields: { body: { 'en-US': 'x'.repeat(300 * 1024) } } };
    await expect(result.current.edit('entries_update', huge)).resolves.toBeNull();
    act(() => {
      void result.current.a.act('entries_publish', { id: 'e1' }, 'y'.repeat(250));
    });
    expect(result.current.a.acts[0]?.about).toHaveLength(200);
  });
});
