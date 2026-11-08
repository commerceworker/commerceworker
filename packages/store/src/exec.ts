import { ConflictError } from '@commerceworker/domain';
import { TransactionConflictError } from '@commerceworker/ports';
import { sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export type Db = DrizzleD1Database<typeof schema>;

/** D1 accepts a database or a read-replica session (`env.DB.withSession(bookmark)`). */
export type D1Like = D1Database | D1DatabaseSession;

export function createDb(d1: D1Like): Db {
  return drizzle(d1 as D1Database, { schema });
}

/**
 * How a repository executes writes. Every repo is built over an `Exec`, so the same repo code
 * runs directly (each write is its own statement, as outside a transaction) or as part of a
 * {@link UnitOfWork} (writes are buffered and committed as one atomic `db.batch()`).
 *
 * Reads always go straight to `db`: inside a unit of work they see committed state only, which
 * is the contract `ContentStore.withTransaction` documents.
 */
export interface Exec {
  readonly db: Db;
  /** True inside a unit of work, where `write` buffers instead of executing. */
  readonly inUnit: boolean;
  /** Executes (direct) or buffers (unit of work) one write statement. */
  write(query: BatchItem<'sqlite'>): Promise<void>;
  /**
   * Inside a unit of work: asserts at commit that the statement buffered just before this one
   * changed exactly `rows` rows, aborting the whole batch otherwise (a lost compare-and-set).
   * Outside one it is a no-op: the caller reads the outcome from `.returning()` instead.
   */
  expectChanged(rows?: number): void;
}

export function directExec(db: Db): Exec {
  return {
    db,
    inUnit: false,
    async write(query) {
      try {
        await query;
      } catch (err) {
        throw mapD1Error(err);
      }
    },
    expectChanged() {},
  };
}

/**
 * The D1 unit of work behind `withTransaction`.
 *
 * D1 has no interactive transactions; its atomic primitive is `batch()`, which runs every
 * statement in one implicit transaction and rolls all of them back if any fails. So writes are
 * collected here and sent in a single batch at `commit()`.
 *
 * Optimistic preconditions become guard statements: `INSERT INTO _guard SELECT changes() = n`
 * placed right after the conditional UPDATE. `_guard.ok` carries `CHECK (ok = 1)`, so a write that
 * matched no row (another writer won) violates the check and aborts the batch: D1's rollback.
 * A trailing `DELETE FROM _guard` leaves the table empty.
 */
export class UnitOfWork implements Exec {
  readonly inUnit = true;
  private readonly statements: BatchItem<'sqlite'>[] = [];
  private guarded = false;

  constructor(readonly db: Db) {}

  async write(query: BatchItem<'sqlite'>): Promise<void> {
    this.statements.push(query);
  }

  expectChanged(rows = 1): void {
    this.statements.push(
      this.db.insert(schema.guard).select(sql`SELECT changes() = ${rows} AS ok`),
    );
    this.guarded = true;
  }

  get size(): number {
    return this.statements.length;
  }

  async commit(): Promise<void> {
    if (this.statements.length === 0) return;
    const batch = this.guarded
      ? [...this.statements, this.db.delete(schema.guard)]
      : this.statements;
    try {
      await this.db.batch(batch as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
    } catch (err) {
      throw mapD1Error(err);
    }
  }
}

export const messageOf = (err: unknown): string => {
  const parts: string[] = [];
  let cur: unknown = err;
  // drizzle wraps the D1 error; D1 sometimes wraps SQLite's. Walk the cause chain.
  for (let depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(' | ');
};

export const isGuardFailure = (err: unknown): boolean =>
  /CHECK constraint failed: guard_ok/i.test(messageOf(err));

export const isUniqueViolation = (err: unknown): boolean =>
  /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY/i.test(
    messageOf(err),
  );

/** Translates D1/SQLite failures into the port's error vocabulary; anything else passes through. */
export function mapD1Error(err: unknown): unknown {
  if (err instanceof ConflictError) return err;
  if (isGuardFailure(err)) return new TransactionConflictError();
  if (isUniqueViolation(err)) {
    return new ConflictError('A unique value is already taken', { cause: messageOf(err) });
  }
  return err;
}

/**
 * D1 binds at most 100 parameters per statement. Splits `items` so each chunk, plus the
 * statement's other parameters (`reserved`, e.g. the two scope ids), stays under the cap.
 */
export function chunked<T>(items: readonly T[], paramsPerItem = 1, reserved = 4): T[][] {
  const per = Math.max(1, Math.floor((100 - reserved) / paramsPerItem));
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += per) out.push(items.slice(at, at + per));
  return out;
}

/** Runs one query per chunk of `items` and concatenates the rows. */
export async function selectChunked<T, R>(
  items: readonly T[],
  run: (chunk: T[]) => Promise<R[]>,
  paramsPerItem = 1,
  reserved = 4,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = [];
  for (const chunk of chunked(items, paramsPerItem, reserved)) out.push(...(await run(chunk)));
  return out;
}
