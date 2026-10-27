import { useLayoutEffect } from 'react';
import { deepLinksPriming, hasPendingDeepLink, subscribeDeepLinks } from './deepLinks';
import { pruneLayout } from '@/engine/paneLayout';
import { readPaneLayout, writePaneLayout } from './paneLayoutPersistence';
import { placeResolves } from '@/engine/placeResolves';
import { layoutOf, useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { forgetLastPlace, placeSnapshot, readLastPlace, rememberLastPlace } from './lastPlace';
import { hasPendingLeaveIntent } from './leaveGuard';

/** One startup choice per vault: a pending external link, saved panes, last
 * place, then Home. A person who already moved keeps their current session.
 * This host also owns vault reset, last-place remembering and live Back checks. */
export function PaneLayoutHost() {
  useLayoutEffect(() => {
    let vault: string | null | undefined;
    let checked = false;
    let busy = false;
    let bootSeq = -1;
    const check = () => {
      if (busy) return;
      busy = true;
      try {
        const next = useVaultStore.getState().vaultPath;
        if (next !== vault) {
          vault = next;
          checked = false;
          useNavStore.getState().reset();
          bootSeq = useNavStore.getState().navSeq;
        }
        const snapshot = placeSnapshot();
        if (checked || vault == null || snapshot === null) return;
        if (deepLinksPriming()) return;
        checked = true;
        if (hasPendingDeepLink(vault)) return;
        const nav = useNavStore.getState();
        // An explicit origin link carries its original intent into this new
        // pane while the scan runs. Saved convenience state cannot replace it.
        if (hasPendingLeaveIntent(`pane:${nav.active}`)) return;
        if (nav.history.length !== 1 || nav.selection.kind !== 'home' || nav.navSeq !== bootSeq) {
          rememberLastPlace(vault, nav.selection);
          return;
        }
        const stored = readPaneLayout(vault);
        const layout =
          stored === null
            ? null
            : pruneLayout(stored, (selection) => placeResolves(selection, snapshot));
        if (layout !== null) {
          nav.restoreLayout(layout);
          rememberLastPlace(vault, useNavStore.getState().selection);
          return;
        }
        const saved = readLastPlace(vault);
        if (saved === null || !placeResolves(saved, snapshot)) {
          forgetLastPlace(vault);
          return;
        }
        nav.navigate(saved, { replace: true, restore: true });
        rememberLastPlace(vault, useNavStore.getState().selection);
      } finally {
        busy = false;
        if (
          checked &&
          vault != null &&
          vault === useVaultStore.getState().vaultPath &&
          placeSnapshot() !== null &&
          !hasPendingDeepLink(vault)
        ) {
          writePaneLayout(vault, layoutOf(useNavStore.getState()));
        }
      }
    };
    useNavStore.getState().setLiveCheck((selection) => {
      const snapshot = placeSnapshot();
      return snapshot === null || placeResolves(selection, snapshot);
    });
    const stopVault = useVaultStore.subscribe(check);
    const stopLinks = subscribeDeepLinks(check);
    const stopNav = useNavStore.subscribe((next, previous) => {
      if (
        busy ||
        !checked ||
        vault == null ||
        vault !== useVaultStore.getState().vaultPath ||
        placeSnapshot() === null
      )
        return;
      if (hasPendingDeepLink(vault)) return;
      if (next.selection !== previous.selection) rememberLastPlace(vault, next.selection);
      writePaneLayout(vault, layoutOf(next));
    });
    check();
    return () => {
      stopVault();
      stopLinks();
      stopNav();
      useNavStore.getState().setLiveCheck(null);
    };
  }, []);
  return null;
}

/** Kept for the last-place and deep-link regression fixtures; the app mounts
 * only PaneLayoutHost, so there can never be two competing restore points. */
export const LastPlaceHost = PaneLayoutHost;
