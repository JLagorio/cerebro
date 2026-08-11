import { useEffect, useState } from 'react';

/**
 * Bumps whenever `<html data-theme>` changes (M16.39's toggle, or the system
 * resolver), so token-derived renders can redo themselves. A MutationObserver
 * rather than a store subscription: this module must work on surfaces that
 * take only props (ConceptBody), and the attribute is the one place every
 * theme decision already lands.
 */
export function useThemeEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setEpoch((n) => n + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return epoch;
}
