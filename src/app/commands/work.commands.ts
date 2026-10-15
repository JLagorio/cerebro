import type { CommandDef } from './index';

/**
 * Work's keyboard (M30.24): VS Code's bindings, minus the ones a browser will
 * not give up. Bound in `src/workspace/useWorkspaceKeys.ts`.
 *
 * ⌘W and ⌘1…9 are BROWSER accelerators: Chrome closes the page and switches
 * its own tabs before a listener ever runs, and `preventDefault` does not
 * reach them. Inside Tauri they are ours, so they are desktopOnly; a
 * developer running `pnpm dev` keeps the page when they reach for "close
 * tab". Split and previous/next tab are chords no browser claims, so they
 * work everywhere, e2e included.
 */
export const commands: readonly CommandDef[] = [
  {
    id: 'work.split',
    label: 'Split the editor',
    keys: ['mod+\\'],
    scope: 'page',
    group: 'Work',
  },
  {
    id: 'work.prevTab',
    label: 'Previous tab',
    keys: ['mod+shift+['],
    scope: 'page',
    group: 'Work',
  },
  {
    id: 'work.nextTab',
    label: 'Next tab',
    keys: ['mod+shift+]'],
    scope: 'page',
    group: 'Work',
  },
  {
    id: 'work.closeTab',
    label: 'Close the tab',
    keys: ['mod+w'],
    scope: 'page',
    group: 'Work',
    desktopOnly: true,
  },
  {
    // Nine keys, and the one pressed names the group, so the palette, which
    // presses none, leaves it out.
    id: 'work.focusGroup',
    label: 'Focus an editor group',
    keys: ['mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6', 'mod+7', 'mod+8', 'mod+9'],
    scope: 'page',
    group: 'Work',
    desktopOnly: true,
    palette: false,
  },
];
