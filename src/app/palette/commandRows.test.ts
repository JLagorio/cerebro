import { expect, it } from 'vitest';
import type { CommandDef } from '@/app/commands';
import { commandRows } from './commandRows';
const defs: CommandDef[] = Array.from({ length: 9 }, (_, i) => ({
  id: `page.${i}`,
  label: `Page command ${i}`,
  aliases: ['make'],
  keys: [],
  scope: 'app',
  group: 'Pages',
}));
it('ranks labels and aliases with five in All and no cap in Commands', () => {
  expect(commandRows(defs, 'page', 'all')).toHaveLength(5);
  expect(commandRows(defs, 'make', 'commands')).toHaveLength(9);
  expect(commandRows(defs, 'page command 5', 'commands')[0].id).toBe('command:page.5');
  expect(commandRows(defs, 'page', 'pages')).toEqual([]);
});
it('keeps hidden commands out and includes three choosers', () => {
  expect(commandRows([{ ...defs[0], palette: false }], '', 'commands').map((r) => r.id)).toEqual([
    'choose:theme',
    'choose:favorites',
    'choose:agents',
  ]);
  expect(commandRows([], 'zzqxv', 'all')).toEqual([]);
});
