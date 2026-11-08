import type { Clock, IdGenerator } from '@commerceworker/ports';

/** A clock fixed at a given instant (advanceable) for deterministic tests. */
export class FixedClock implements Clock {
  private current: Date;
  constructor(start = new Date('2026-01-01T00:00:00.000Z')) {
    this.current = start;
  }
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** A deterministic id generator producing id-1, id-2, ... */
export class SequenceIdGenerator implements IdGenerator {
  private n = 0;
  constructor(private readonly prefix = 'id') {}
  newId(): string {
    this.n += 1;
    return `${this.prefix}-${this.n}`;
  }
}
