import { useEffect, useState } from 'react';
/** One minute-level clock, passed to every Home lane. Reads never depend on it. */
export function useHomeClock(): Date {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const timer = window.setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return new Date(minute * 60_000);
}
