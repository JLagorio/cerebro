import type { CommandDef } from './index';

/** Save flushes every open page's debounce, including the record peek. */
export const commands: readonly CommandDef[] = [
  {
    id: 'page.save',
    label: 'Save open pages',
    keys: ['mod+s'],
    scope: 'app',
    group: 'Pages',
    inEditor: true,
  },
  {
    id: 'find.open',
    label: 'Find in page',
    keys: ['mod+f'],
    scope: 'app',
    group: 'Pages',
    inEditor: true,
  },
  {
    id: 'find.replace',
    label: 'Find and replace',
    keys: ['mod+alt+f'],
    scope: 'app',
    group: 'Pages',
    inEditor: true,
  },
  {
    id: 'find.next',
    label: 'Next match',
    keys: ['mod+g'],
    scope: 'app',
    group: 'Pages',
    inEditor: true,
  },
  {
    id: 'find.prev',
    label: 'Previous match',
    keys: ['mod+shift+g'],
    scope: 'app',
    group: 'Pages',
    inEditor: true,
  },
];
