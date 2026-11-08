/**
 * Counts what a D1 store sends to D1, for the query-count snapshots (the content store's
 * packages/store/test/query-counts.test.ts and the commerce stores' packages/db/test).
 *
 * The wrapper sits between a store and the binding, so it sees exactly what a Worker's D1 binding
 * sees. A statement run on its own (`all`, `run`, `first`, `raw`) is one statement
 * and one round trip; a `batch()` is one round trip carrying all of its statements; `exec()` is
 * one round trip of one statement. A read-replica session (`withSession`) counts the same way.
 */

export interface QueryCount {
  /** SQL statements D1 executed. */
  readonly statements: number;
  /** Calls to D1, one per lone statement or per batch: the latency a request pays. */
  readonly roundTrips: number;
}

export interface QueryLog extends QueryCount {
  /** Every statement's SQL, in order (batched ones marked), for the drift report. */
  readonly sql: readonly string[];
}

export interface CountingD1 {
  /** The binding to hand to the store. */
  readonly d1: D1Database;
  /** Counts the D1 traffic of `fn` alone. Measurements must not overlap. */
  measure(fn: () => Promise<unknown>): Promise<QueryLog>;
}

const EXECUTE = new Set<PropertyKey>(['all', 'run', 'first', 'raw']);

export function countingD1(target: D1Database): CountingD1 {
  let statements = 0;
  let roundTrips = 0;
  let sql: string[] = [];
  // `batch()` must receive the binding's own statements, not the proxies; the text is kept for
  // the log.
  const original = new WeakMap<object, { stmt: D1PreparedStatement; text: string }>();

  const wrapStatement = (stmt: D1PreparedStatement, text: string): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(t, key) {
        if (key === 'bind') {
          return (...values: unknown[]) => wrapStatement(t.bind(...values), text);
        }
        const value = Reflect.get(t, key, t);
        if (typeof value !== 'function') return value;
        if (!EXECUTE.has(key)) return value.bind(t);
        return (...args: unknown[]) => {
          statements += 1;
          roundTrips += 1;
          sql.push(text);
          return value.apply(t, args);
        };
      },
    });
    original.set(proxy, { stmt, text });
    return proxy;
  };

  const wrapDatabase = <T extends D1Database | D1DatabaseSession>(db: T): T =>
    new Proxy(db, {
      get(t, key) {
        const value = Reflect.get(t, key, t);
        if (typeof value !== 'function') return value;
        switch (key) {
          case 'prepare':
            return (query: string) => wrapStatement(t.prepare(query), query);
          case 'batch':
            return (batch: D1PreparedStatement[]) => {
              roundTrips += 1;
              statements += batch.length;
              const unwrapped = batch.map((s) => {
                const o = original.get(s);
                sql.push(`[batch] ${o?.text ?? '?'}`);
                return o?.stmt ?? s;
              });
              return t.batch(unwrapped);
            };
          case 'exec':
            return (query: string) => {
              roundTrips += 1;
              statements += 1;
              sql.push(query);
              return (t as D1Database).exec(query);
            };
          case 'withSession':
            return (constraintOrBookmark?: string) =>
              wrapDatabase((t as D1Database).withSession(constraintOrBookmark));
          default:
            return value.bind(t);
        }
      },
    });

  return {
    d1: wrapDatabase(target),
    async measure(fn) {
      statements = 0;
      roundTrips = 0;
      sql = [];
      await fn();
      return { statements, roundTrips, sql };
    },
  };
}

/** A snapshot as written: one line per request, so a diff names the request. */
export function formatQueryCounts(counts: Readonly<Record<string, QueryCount>>): string {
  const lines = Object.entries(counts).map(
    ([name, c]) =>
      `  ${JSON.stringify(name)}: { "statements": ${c.statements}, "roundTrips": ${c.roundTrips} }`,
  );
  return `{\n${lines.join(',\n')}\n}\n`;
}

/** The measured counts of each request, without their SQL. */
export const countsOf = (logs: Readonly<Record<string, QueryLog>>): Record<string, QueryCount> =>
  Object.fromEntries(
    Object.entries(logs).map(([name, l]) => [
      name,
      { statements: l.statements, roundTrips: l.roundTrips },
    ]),
  );

/**
 * What changed against the committed counts, worst first: increases (with the SQL the request
 * now runs), then new, removed and decreased requests. Empty when nothing changed. `file` names the
 * snapshot, `update` the command that rewrites it and `rule` what may change.
 */
export function queryCountDrift(
  before: Readonly<Record<string, QueryCount>>,
  after: Readonly<Record<string, QueryLog>>,
  how: { file: string; update: string; rule: string },
): string {
  const up: string[] = [];
  const other: string[] = [];
  const delta = (a: number, b: number) => `${a} → ${b} (${b > a ? '+' : ''}${b - a})`;
  for (const [name, now] of Object.entries(after)) {
    const was = before[name];
    if (!was) {
      other.push(`  new      ${name}: ${now.statements} statements, ${now.roundTrips} round trips`);
      continue;
    }
    if (was.statements === now.statements && was.roundTrips === now.roundTrips) continue;
    const line = `${name}: statements ${delta(was.statements, now.statements)}, round trips ${delta(was.roundTrips, now.roundTrips)}`;
    if (now.statements > was.statements || now.roundTrips > was.roundTrips) {
      up.push(`  UP       ${line}`, ...now.sql.map((s) => `             ${s}`));
    } else {
      other.push(`  down     ${line}`);
    }
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) other.push(`  removed  ${name}`);
  }
  if (up.length === 0 && other.length === 0) return '';
  return [
    `D1 query counts changed (${how.file}):`,
    ...up,
    ...other,
    `If the change is intended, run \`${how.update}\` and commit the snapshot.`,
    how.rule,
  ].join('\n');
}
