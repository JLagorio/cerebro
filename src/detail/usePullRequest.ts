import { useCallback, useEffect, useRef, useState } from 'react';
import { parsePullRequestUrl, type PrRead } from '@/engine/pullRequest';
import { pullRequestState } from '@/lib/gitIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';

/** Keyed publication also retires a late read after an A→B→A vault switch. */
export function usePullRequest(url: string) {
  const vault = useVaultStore((s) => s.vaultPath);
  const key = `${vault}\0${parsePullRequestUrl(url)?.key ?? url}`;
  const capture = useVaultActionGuard(key);
  const sequence = useRef({ value: 0 }).current;
  const [result, setResult] = useState<{ key: string; read: PrRead } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const load = useCallback(
    async (refresh: boolean) => {
      const current = capture();
      const id = ++sequence.value;
      setPending(key);
      setResult(null);
      try {
        const read = await pullRequestState(url, refresh);
        if (current() && id === sequence.value) setResult({ key, read });
      } catch {
        if (current() && id === sequence.value)
          setResult({ key, read: { state: 'failed', checkedAt: new Date().toISOString() } });
      } finally {
        if (current() && id === sequence.value) setPending(null);
      }
    },
    [url, key, capture, sequence],
  );
  useEffect(() => {
    void load(false);
    return () => {
      sequence.value++;
    };
  }, [load, sequence]);
  return {
    read: result?.key === key ? result.read : null,
    loading: pending === key,
    refresh: () => void load(true),
  };
}
