import type { CommandDef } from '@/app/commands';
import { rankNames } from '@/lib/nameRank';
import type { Category, Chooser } from './model';
export interface PaletteCommand {
  id: string;
  label: string;
  aliases: readonly string[];
  command?: string;
  chooser?: Chooser;
}
export const CHOOSERS: readonly PaletteCommand[] = [
  {
    id: 'choose:theme',
    label: 'Change theme…',
    aliases: ['appearance', 'light', 'dark', 'system'],
    chooser: 'theme',
  },
  {
    id: 'choose:favorites',
    label: 'Open favorite…',
    aliases: ['starred', 'pinned'],
    chooser: 'favorites',
  },
  {
    id: 'choose:agents',
    label: 'Open agent…',
    aliases: ['assistant', 'agents'],
    chooser: 'agents',
  },
];
export function commandRows(
  snapshot: readonly CommandDef[],
  query: string,
  category: Category,
): PaletteCommand[] {
  if (category !== 'all' && category !== 'commands') return [];
  const rows = snapshot
    .filter((def) => def.palette !== false)
    .map((def): PaletteCommand => ({
      id: `command:${def.id}`,
      command: def.id,
      label: def.label,
      aliases: def.aliases ?? [],
    }));
  const all = [...rows, ...CHOOSERS];
  return rankNames({
    query,
    items: all,
    texts: (row) => [row.label, ...row.aliases],
    limit: category === 'all' ? 5 : all.length,
  }).items;
}
