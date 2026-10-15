import type { CommandDef } from './index';
export const commands: readonly CommandDef[] = [
  {
    id: 'peek.next',
    label: 'Next record',
    keys: ['j'],
    scope: 'peek',
    group: 'Record peek',
    palette: false,
  },
  {
    id: 'peek.prev',
    label: 'Previous record',
    keys: ['k'],
    scope: 'peek',
    group: 'Record peek',
    palette: false,
  },
];
