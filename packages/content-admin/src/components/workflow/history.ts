/**
 * Edit history for the workflow editor, as a hook. Every change goes through `set`; changes within 400 ms
 * of each other (a drag, typing) are one step, so ⌘Z undoes a whole move rather than one pixel of
 * it. At most 100 steps are kept.
 */

import { useCallback, useRef, useState } from 'react';

export const HISTORY_BURST_MS = 400;
export const HISTORY_LIMIT = 100;

export function useEditHistory<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const lastEdit = useRef(0);
  const [, setTick] = useState(0);
  const [announce, setAnnounce] = useState('');

  const set = useCallback((next: T | ((v: T) => T)) => {
    const prev = ref.current;
    const v = typeof next === 'function' ? (next as (v: T) => T)(prev) : next;
    if (v === prev) return;
    const now = Date.now();
    if (now - lastEdit.current > HISTORY_BURST_MS) {
      past.current.push(prev);
      if (past.current.length > HISTORY_LIMIT) past.current.shift();
    }
    lastEdit.current = now;
    future.current = [];
    ref.current = v;
    setValue(v);
    setTick((t) => t + 1);
  }, []);

  const travel = useCallback((from: { current: T[] }, to: { current: T[] }, said: string) => {
    const target = from.current.pop();
    if (target === undefined) return;
    setAnnounce(said);
    to.current.push(ref.current);
    ref.current = target;
    lastEdit.current = 0;
    setValue(target);
    setTick((t) => t + 1);
  }, []);
  const undo = useCallback(() => travel(past, future, 'Undone'), [travel]);
  const redo = useCallback(() => travel(future, past, 'Redone'), [travel]);

  /** Replaces the value and forgets the history (a freshly loaded workflow). */
  const reset = useCallback((v: T) => {
    past.current = [];
    future.current = [];
    lastEdit.current = 0;
    ref.current = v;
    setValue(v);
    setTick((t) => t + 1);
  }, []);

  return {
    value,
    ref,
    set,
    undo,
    redo,
    reset,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    /** "Undone"/"Redone", for a polite live region. */
    announce,
  };
}
