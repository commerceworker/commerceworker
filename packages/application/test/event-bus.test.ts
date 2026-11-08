import type { DomainEvent } from '@commerceworker/domain';
import { InMemoryEventBus } from '@commerceworker/test-kit';
import { describe, expect, it } from 'vitest';

const scope = { spaceId: 'shop', environmentId: 'main' };

function event(type: string, entryId: string): DomainEvent {
  return {
    id: `evt-${entryId}`,
    scope,
    occurredAt: '2026-01-01T00:00:00.000Z',
    type,
    entryId,
    contentTypeApiId: 'post',
    version: 1,
    fields: {},
  } as DomainEvent;
}

describe('InMemoryEventBus', () => {
  it('fans out published events to subscribers', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe('*', async (e) => void seen.push(e.type));
    await bus.publish(event('entry.published', 'a'));
    await bus.publish(event('entry.unpublished', 'a'));
    expect(seen).toEqual(['entry.published', 'entry.unpublished']);
  });

  it('filters by event-type pattern (prefix + exact)', async () => {
    const bus = new InMemoryEventBus();
    const exact: string[] = [];
    const prefix: string[] = [];
    bus.subscribe('entry.published', async (e) => void exact.push(e.id));
    bus.subscribe('entry.*', async (e) => void prefix.push(e.id));
    await bus.publish(event('entry.published', 'a'));
    await bus.publish(event('entry.unpublished', 'b'));
    expect(exact).toEqual(['evt-a']);
    expect(prefix).toEqual(['evt-a', 'evt-b']);
  });

  it('stops delivering after a subscription closes', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    const sub = bus.subscribe('*', async (e) => void seen.push(e.id));
    await bus.publish(event('entry.published', 'a'));
    await sub.close();
    await bus.publish(event('entry.published', 'b'));
    expect(seen).toEqual(['evt-a']);
  });
});
