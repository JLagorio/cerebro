import type { CommandDef } from './index';
export const commands: readonly CommandDef[] = [
  {
    id: 'pane.focusNext',
    label: 'Focus next pane',
    keys: ['alt+mod+]'],
    scope: 'app',
    group: 'Panes',
    inEditor: true,
  },
  {
    id: 'pane.focusPrev',
    label: 'Focus previous pane',
    keys: ['alt+mod+['],
    scope: 'app',
    group: 'Panes',
    inEditor: true,
  },
  {
    id: 'pane.close',
    label: 'Close pane',
    keys: ['alt+mod+w'],
    scope: 'app',
    group: 'Panes',
    inEditor: true,
  },
];
