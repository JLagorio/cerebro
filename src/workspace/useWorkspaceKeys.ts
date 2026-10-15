import { activeTab } from '@/engine/editorGroups';
import { keyOf } from '@/lib/keys/combo';
import { useCommands, type CommandBinding } from '@/lib/keys/useKeys';
import { useRootsStore } from '@/stores/rootsStore';

const store = () => useRootsStore.getState();

/**
 * The workspace's keyboard (M30.24): VS Code's bindings, as the `work.*` rows
 * of the keymap (`src/app/commands/work.commands.ts`, M65.1), bound in the
 * page scope. ⌘W and ⌘1…9 are desktopOnly there; the row file says why.
 */
const WORK: readonly CommandBinding[] = [
  // ⌘\ — split the focused pane.
  { id: 'work.split', run: () => store().splitEditor() },
  // ⇧⌘[ / ⇧⌘] — previous / next tab in the focused pane.
  { id: 'work.prevTab', run: () => store().cycleTab(-1) },
  { id: 'work.nextTab', run: () => store().cycleTab(1) },
  // ⌘W — close the focused tab, when there is one.
  {
    id: 'work.closeTab',
    run: () => {
      const open = activeTab(store().layout);
      if (open !== null) store().closeTab(open);
    },
    when: () => activeTab(store().layout) !== null,
  },
  // ⌘1…9 — focus the nth pane: the digit pressed names it.
  {
    id: 'work.focusGroup',
    run: (event) => {
      const n = event === undefined ? NaN : Number(keyOf(event));
      if (n >= 1 && n <= 9) store().focusGroupAt(n - 1);
    },
  },
];

export function useWorkspaceKeys(enabled: boolean): void {
  useCommands(enabled ? WORK : []);
}
