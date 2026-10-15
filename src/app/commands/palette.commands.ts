import type { CommandDef } from './index';
export const commands: readonly CommandDef[] = [
  {
    id: 'shortcuts.show',
    label: 'Show keyboard shortcuts',
    keys: [],
    scope: 'app',
    group: 'General',
    aliases: ['keys', 'keymap', 'settings'],
  },
];
