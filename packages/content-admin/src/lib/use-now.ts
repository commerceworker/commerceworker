import { useEffect, useState } from 'react';

/** The current time, refreshed every `interval` ms (none when null). */
export function useNow(interval: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!interval) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(t);
  }, [interval]);
  return now;
}
