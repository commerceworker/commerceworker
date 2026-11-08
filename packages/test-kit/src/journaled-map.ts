const ABSENT = Symbol('absent');

/** What one open transaction has touched: each key's value before it, and the key order if needed. */
export interface Journal<K, V> {
  readonly before: Map<K, V | typeof ABSENT>;
  /** Insertion order before the first delete or clear, so a rollback puts keys back in place. */
  order?: K[];
}

// Stored values are plain JSON data, so a JSON round-trip deep-clones them (defeating in-place
// array mutation, such as `versions.push`, that a shallow copy would miss).
const clone = <V>(v: V): V => JSON.parse(JSON.stringify(v)) as V;

/**
 * A Map the in-memory store can roll back, recording only what a transaction touches. Copying
 * every collection up front made each transaction cost the size of the whole store, so a test
 * that writes thousands of entries (the seed corpus) went quadratic. Here a key's value is
 * cloned the first time a transaction reads or writes it (a read too, because callers mutate
 * what `get` returns in place), and iterating the values clones them all, as the old snapshot did.
 *
 * Journals are tokens, not a stack: two transactions awaiting at once (a race under test) each
 * keep their own, and a key touched while both are open is recorded in both.
 */
export class JournaledMap<K, V> extends Map<K, V> {
  private readonly journals = new Set<Journal<K, V>>();

  begin(): Journal<K, V> {
    const journal: Journal<K, V> = { before: new Map() };
    this.journals.add(journal);
    return journal;
  }

  /** Keeps what the transaction wrote. */
  commit(journal: Journal<K, V>): void {
    this.journals.delete(journal);
  }

  /** Puts every key the transaction touched back as it was, in its original order. */
  rollback(journal: Journal<K, V>): void {
    this.journals.delete(journal);
    if (!journal.order) {
      for (const [k, v] of journal.before) {
        if (v === ABSENT) super.delete(k);
        else super.set(k, v);
      }
      return;
    }
    // A delete moved keys; rebuild in the order they had, dropping what the transaction added.
    const current = new Map(super.entries());
    super.clear();
    for (const k of journal.order) {
      if (journal.before.has(k)) {
        const v = journal.before.get(k);
        if (v !== ABSENT) super.set(k, v as V);
      } else if (current.has(k)) {
        super.set(k, current.get(k) as V);
      }
    }
  }

  private keep(k: K): void {
    for (const journal of this.journals) {
      if (!journal.before.has(k)) {
        journal.before.set(k, super.has(k) ? clone(super.get(k) as V) : ABSENT);
      }
    }
  }

  private keepAll(): void {
    if (this.journals.size === 0) return;
    for (const k of super.keys()) this.keep(k);
  }

  private keepOrder(): void {
    for (const journal of this.journals) journal.order ??= [...super.keys()];
  }

  override get(k: K): V | undefined {
    if (this.journals.size > 0) this.keep(k);
    return super.get(k);
  }

  override set(k: K, v: V): this {
    if (this.journals.size > 0) this.keep(k);
    return super.set(k, v);
  }

  override delete(k: K): boolean {
    if (this.journals.size > 0 && super.has(k)) {
      this.keepOrder();
      this.keep(k);
    }
    return super.delete(k);
  }

  override clear(): void {
    if (this.journals.size > 0) {
      this.keepOrder();
      this.keepAll();
    }
    super.clear();
  }

  override entries(): MapIterator<[K, V]> {
    this.keepAll();
    return super.entries();
  }

  override values(): MapIterator<V> {
    this.keepAll();
    return super.values();
  }

  override forEach(fn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    this.keepAll();
    super.forEach(fn, thisArg);
  }

  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}
