import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { declineStarterKit, installStarterKit, starterMarker } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** An offer is meaningful only after this vault's empty scan has landed. */
export function StarterOffer() {
  const vault = useVaultStore((s) => s.vaultPath);
  const entriesVault = useVaultStore((s) => s.entriesVault);
  const status = useVaultStore((s) => s.status);
  const empty = useVaultStore((s) => s.entries.length === 0);
  return vault && entriesVault === vault && status === 'ready' && empty ? (
    <Offer key={vault} vault={vault} />
  ) : null;
}

function Offer({ vault }: { vault: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'hidden' | 'unavailable'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    let current = true;
    void starterMarker(vault).then(
      (marker) => {
        if (current) setState(marker ? 'hidden' : 'ready');
      },
      () => {
        if (current) setState('unavailable');
      },
    );
    return () => {
      current = false;
    };
  }, [vault, attempt]);

  const act = async (add: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (add) {
        const installed = await installStarterKit(vault);
        if (useVaultStore.getState().vaultPath !== vault) return;
        await useVaultStore.getState().rescan();
        if (useVaultStore.getState().vaultPath !== vault) return;
        useUiStore
          .getState()
          .toast(
            installed.marker_saved
              ? 'Added the starter kit'
              : 'Added the starter kit. Its offer marker could not be saved; the pages are safe.',
          );
        if (useVaultStore.getState().entries.some((entry) => entry.path === 'getting-started.md')) {
          useNavStore.getState().navigate({ kind: 'doc', path: 'getting-started.md' });
        }
      } else {
        await declineStarterKit(vault);
        setState('hidden');
      }
    } catch (error) {
      if (useVaultStore.getState().vaultPath === vault) {
        useUiStore.getState().toast(error instanceof Error ? error.message : String(error));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (state === 'hidden' || state === 'loading') return null;
  return (
    <section
      className="mb-6 rounded-xl border border-n-200 bg-n-50 p-5"
      data-testid="starter-offer"
    >
      {state === 'unavailable' ? (
        <div data-testid="section-unavailable">
          <p className="mb-3 text-sm text-n-500">The starter offer could not be read.</p>
          <Button
            size="sm"
            onClick={() => {
              setState('loading');
              setAttempt((n) => n + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <>
          <h2 className="mb-2 text-lg font-semibold">A place to start</h2>
          <p className="mb-4 text-sm text-n-500">
            Add Getting started, a Tasks database with three tasks, two paused agents, and two
            read-only recipes. Nothing is overwritten.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void act(true)}>
              Add the starter kit
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(false)}>
              No thanks
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
