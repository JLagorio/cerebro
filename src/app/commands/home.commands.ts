import type { CommandDef } from './index';
export const commands: readonly CommandDef[] = [
  {
    id: 'home.done',
    label: 'Mark event done',
    keys: ['e'],
    scope: 'page',
    group: 'Home',
    palette: false,
  },
];
