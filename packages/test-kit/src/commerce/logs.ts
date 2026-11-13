/**
 * The logs ports in memory. The contract in ./logs-contract.ts holds them to the same behaviour
 * as the D1 stores.
 */
import type {
  InboundEmail,
  IntakeLog,
  PaymentEventLog,
  UsageStore,
  WebhookReceipts,
} from '@commerceworker/ports/commerce';

export class InMemoryIntakeLog implements IntakeLog {
  readonly emails = new Map<string, InboundEmail>();

  async record(e: InboundEmail) {
    if (![...this.emails.values()].some((x) => x.messageId === e.messageId))
      this.emails.set(e.id, { ...e });
  }
}

export class InMemoryPaymentEventLog implements PaymentEventLog {
  readonly events = new Map<
    string,
    {
      provider: string;
      type: string;
      orderId: string | null;
      status: 'processing' | 'released' | 'done' | 'poisoned';
      claimedAt: number;
      failures: number;
      outcome: string | null;
    }
  >();

  // No await between the read and the write, so two takers can't both win, as the D1 store's one
  // guarded statement does.
  async claim(id: string, provider: string, type: string, now: number, staleMs: number) {
    const e = this.events.get(id);
    if (!e) {
      this.events.set(id, {
        provider,
        type,
        orderId: null,
        status: 'processing',
        claimedAt: now,
        failures: 0,
        outcome: null,
      });
      return 'claimed' as const;
    }
    if (e.status === 'done' || e.status === 'poisoned') return e.status;
    if (e.status === 'processing' && e.claimedAt > now - staleMs) return 'processing' as const;
    e.status = 'processing';
    e.claimedAt = now;
    return 'claimed' as const;
  }

  async link(id: string, orderId: string) {
    const e = this.events.get(id);
    if (e) e.orderId = orderId;
  }

  async finish(id: string, outcome: string) {
    const e = this.events.get(id);
    if (e) {
      e.status = 'done';
      e.outcome = outcome;
    }
  }

  async release(id: string) {
    const e = this.events.get(id);
    if (e && e.status === 'processing') e.status = 'released';
  }

  async fail(id: string, poisonAfter?: number) {
    const e = this.events.get(id);
    if (!e) return { failures: 0, poisoned: false };
    e.failures++;
    const poisoned = poisonAfter !== undefined && e.failures >= poisonAfter;
    e.status = poisoned ? 'poisoned' : 'released';
    return { failures: e.failures, poisoned };
  }

  private readonly cursors = new Map<string, number>();

  async cursor(provider: string) {
    return this.cursors.get(provider);
  }

  async advance(provider: string, cursor: number) {
    this.cursors.set(provider, Math.max(this.cursors.get(provider) ?? cursor, cursor));
  }
}

export class InMemoryWebhookReceipts implements WebhookReceipts {
  readonly receipts = new Map<string, number>();
  async claim(id: string, now: number, ttlMs: number) {
    for (const [k, at] of this.receipts) if (at < now - ttlMs) this.receipts.delete(k);
    if (this.receipts.has(id)) return false;
    this.receipts.set(id, now);
    return true;
  }
  async release(id: string) {
    this.receipts.delete(id);
  }
}

export class InMemoryUsageStore implements UsageStore {
  private readonly days = new Map<string, { tokens: number; calls: number }>();

  async tokens(principalId: string, day: string) {
    return this.days.get(`${principalId}|${day}`)?.tokens ?? 0;
  }

  async add(principalId: string, day: string, tokens: number) {
    const k = `${principalId}|${day}`;
    const was = this.days.get(k) ?? { tokens: 0, calls: 0 };
    this.days.set(k, { tokens: was.tokens + tokens, calls: was.calls + 1 });
  }

  async prune(beforeDay: string) {
    let n = 0;
    for (const k of [...this.days.keys()])
      if (k.split('|')[1]! < beforeDay) {
        this.days.delete(k);
        n++;
      }
    return n;
  }
}
