/**
 * The logs ports in memory. The contract in ./logs-contract.ts holds them to the same behaviour
 * as the D1 stores.
 */
import type {
  InboundEmail,
  IntakeLog,
  PaymentEventLog,
  UsageStore,
} from '@commerceworker/ports/commerce';

export class InMemoryIntakeLog implements IntakeLog {
  readonly emails = new Map<string, InboundEmail>();

  async record(e: InboundEmail) {
    if (![...this.emails.values()].some((x) => x.messageId === e.messageId))
      this.emails.set(e.id, { ...e });
  }
}

export class InMemoryPaymentEventLog implements PaymentEventLog {
  readonly events = new Map<string, { provider: string; type: string; orderId: string | null }>();

  async claim(id: string, provider: string, type: string) {
    if (this.events.has(id)) return false;
    this.events.set(id, { provider, type, orderId: null });
    return true;
  }

  async link(id: string, orderId: string) {
    const e = this.events.get(id);
    if (e) e.orderId = orderId;
  }

  async release(id: string) {
    this.events.delete(id);
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
