/**
 * A status's lifecycle: which states exist and which moves between them are allowed. Every status
 * that moves in storage (a company, a member) is one of these, so the rule is written once and
 * each store applies a move as one compare-and-set on the state it read (`UPDATE … WHERE id = ?
 * AND status = ?`), never as an overwrite.
 */

export class LifecycleError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Can't go from ${from} to ${to}.`);
    this.name = 'LifecycleError';
  }
}

export type Lifecycle<S extends string> = {
  readonly states: readonly S[];
  /** The states reachable in one move from `from`. */
  next(from: S): readonly S[];
  /** Whether `from` may move to `to`. Staying put isn't a move. */
  can(from: S, to: S): boolean;
  /** Throws `LifecycleError` unless `can(from, to)`. */
  assert(from: S, to: S): void;
  /** A state with no move out of it. */
  terminal(state: S): boolean;
  /** Every state reachable from `from` in any number of moves, `from` itself included. */
  reachable(from: S): ReadonlySet<S>;
};

/** `transitions` names every state and the states each may move to. */
export function defineLifecycle<S extends string>(
  transitions: Readonly<Record<S, readonly S[]>>,
): Lifecycle<S> {
  const states = Object.keys(transitions) as S[];
  const next = (from: S): readonly S[] => transitions[from] ?? [];
  const can = (from: S, to: S) => next(from).includes(to);
  return {
    states,
    next,
    can,
    assert(from, to) {
      if (!can(from, to)) throw new LifecycleError(from, to);
    },
    terminal: (state) => next(state).length === 0,
    reachable(from) {
      const seen = new Set<S>([from]);
      const queue: S[] = [from];
      for (let s = queue.pop(); s !== undefined; s = queue.pop())
        for (const n of next(s))
          if (!seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
      return seen;
    },
  };
}
