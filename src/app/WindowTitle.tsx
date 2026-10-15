import { useEffect } from 'react';
import { APP_NAME, placeLabel, placeOf, windowTitle } from '@/engine/place';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The window title names the place you are on (M59.1): `History — Cerebro`,
 * `Systems map — Cerebro`. A host: it renders nothing.
 *
 * It sets `document.title`, and the packaged app's window copies that
 * (`shell::build_main_window`'s title hook), so no capability is needed.
 * Mounted inside the vault branch, so the vault chooser keeps index.html's
 * `Cerebro`, and unmounting puts that back. The label is placeLabel's, the
 * one a thread chip shows, read against the live vault so a rename retitles.
 */
export function WindowTitle() {
  const selection = useNavStore((s) => s.selection);
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const collections = useVaultStore((s) => s.collections);

  useEffect(() => {
    document.title = windowTitle(placeLabel(placeOf(selection), { entries, views, collections }));
  }, [selection, entries, views, collections]);

  useEffect(
    () => () => {
      document.title = APP_NAME;
    },
    [],
  );

  return null;
}
