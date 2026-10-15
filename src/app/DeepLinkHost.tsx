import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { navigateTarget } from '@/engine/destinations';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { getSchema, useVaultStore } from '@/stores/vaultStore';
import { useOpenPath } from './useOpenPath';
import {
  deepLinkRevision,
  deepLinksPriming,
  returnDeepLink,
  shiftDeepLink,
  subscribeDeepLinks,
  type DeepLink,
} from './deepLinks';

type Confirm = { link: DeepLink; path: string };
/** This host consumes before acting. Links may navigate and ask to switch
 * vaults; they have no write, create or agent-run door. */
export function DeepLinkHost() {
  const revision = useSyncExternalStore(subscribeDeepLinks, deepLinkRevision);
  const vault = useVaultStore((s) => s.vaultPath);
  const entriesVault = useVaultStore((s) => s.entriesVault);
  const status = useVaultStore((s) => s.status);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [tick, setTick] = useState(0);
  const switching = useRef(false);
  const nav = useNavStore();
  const deliveredVault = useRef<string | null>(null);
  const initial =
    deliveredVault.current !== vault && nav.history.length === 1 && nav.selection.kind === 'home';
  const openPath = useOpenPath('navigate', { replace: initial, fullPage: true });
  const opener = useRef(openPath);
  opener.current = openPath;

  useEffect(() => {
    if (
      vault === null ||
      status !== 'ready' ||
      entriesVault !== vault ||
      confirm !== null ||
      switching.current
    )
      return;
    if (deepLinksPriming()) return;
    const link = shiftDeepLink();
    deliveredVault.current = vault;
    if (link === null) return;
    const ui = useUiStore.getState();
    if (link.kind === 'refused') {
      ui.toast(`This link couldn't be opened: ${link.reason}.`);
    } else if (link.vault?.lookup.kind === 'unknown') {
      ui.toast("This link names a vault Cerebro hasn't opened on this Mac.");
    } else if (link.vault?.lookup.kind === 'unreadable') {
      ui.toast("Cerebro couldn't read its list of vaults, so this link wasn't opened.");
    } else if (link.vault?.lookup.kind === 'found' && link.vault.lookup.path !== vault) {
      setConfirm({ link, path: link.vault.lookup.path });
      return;
    } else if (link.kind === 'open') {
      if (useVaultStore.getState().entries.some((entry) => entry.path === link.path))
        opener.current(link.path);
      else ui.toast(`This link points to ${link.path}, which isn't in this vault.`);
    } else {
      const { entries } = useVaultStore.getState();
      const target = navigateTarget(
        { to: link.to, database: link.database ?? undefined, view: link.view ?? undefined },
        entries,
        getSchema(entries),
      );
      if ('selection' in target)
        useNavStore.getState().navigate(target.selection, { replace: initial });
      else ui.toast(target.refused);
    }
    setTick((value) => value + 1);
  }, [revision, vault, entriesVault, status, confirm, tick, initial]);

  const stay = () => setConfirm(null);
  const open = async () => {
    if (confirm === null || switching.current) return;
    const accepted = confirm;
    switching.current = true;
    // Queue before opening: LastPlaceHost must see it while that scan lands.
    returnDeepLink(accepted.link);
    setConfirm(null);
    await useVaultStore.getState().openVault(accepted.path);
    switching.current = false;
    if (
      useVaultStore.getState().vaultPath !== accepted.path ||
      useVaultStore.getState().status !== 'ready'
    ) {
      shiftDeepLink();
    }
    setTick((value) => value + 1);
  };
  return (
    <Dialog
      open={confirm !== null}
      title="Open another vault?"
      onClose={stay}
      primaryAction={{ label: 'Open', onClick: () => void open() }}
      secondaryAction={{ label: 'Stay here', onClick: stay }}
      width={440}
    >
      <p data-testid="deep-link-confirm" className="m-0">
        This link opens a page in “{confirm?.path.split('/').filter(Boolean).at(-1) ?? ''}”.
      </p>
    </Dialog>
  );
}
