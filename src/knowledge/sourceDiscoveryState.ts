import type { EntryStateKey, NavSlot } from '@/engine/panes';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

export const DISCOVERY_CHANGED = 'Sources or readable scope changed. Refresh to search again.';

/** Visit state is memory only. Drop excerpts from inactive visits as well as
 * mounted panels at the same synchronous vault snapshot transition. */
const unsubscribe = useVaultStore.subscribe((state, previous) => {
  if (state.vaultPath === previous.vaultPath && state.entries === previous.entries) return;
  const prune = (slot: NavSlot): NavSlot => {
    const discoveries = Object.entries(slot.state ?? {}).filter(([key]) =>
      key.startsWith('source.discovery:'),
    );
    if (!discoveries.length) return slot;
    const next = { ...slot.state };
    for (const [key, value] of discoveries) {
      const identity = (
        value as { identity?: { targetPath?: unknown; mode?: unknown } } | undefined
      )?.identity;
      if (
        typeof identity?.targetPath !== 'string' ||
        (identity.mode !== 'linked' && identity.mode !== 'mention')
      ) {
        delete next[key as EntryStateKey];
        continue;
      }
      next[key as EntryStateKey] = {
        identity: {
          vault: state.vaultPath,
          entries: state.entries,
          targetPath: identity.targetPath,
          mode: identity.mode,
        },
        status: 'changed',
        reason: DISCOVERY_CHANGED,
      };
    }
    return { ...slot, state: next };
  };
  useNavStore.setState((nav) => ({
    history: nav.history.map(prune),
    stashed: Object.fromEntries(
      Object.entries(nav.stashed).flatMap(([id, pane]) =>
        pane ? [[id, { ...pane, history: pane.history.map(prune) }]] : [],
      ),
    ) as typeof nav.stashed,
  }));
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);
