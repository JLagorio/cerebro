import type { CommandDef } from './index';
import { CREATE_ROWS } from '../createCatalog';

export const commands: readonly CommandDef[] = [
  {
    id: 'create.launcher',
    label: 'New…',
    keys: ['c n'],
    scope: 'app',
    group: 'Create',
    aliases: ['create', 'new launcher'],
  },
  ...CREATE_ROWS.map((row) => ({
    id: `create.${row.id}`,
    label: `New ${row.label.toLowerCase()}`,
    keys: [`c ${row.chord}`],
    scope: 'app',
    group: 'Create',
  })),
];
