import { listAgents, isPaused } from '@/engine/agents';
import { rankNames } from '@/lib/nameRank';
import type { Entry } from '@/engine/types';
import type { ThemeMode } from '@/stores/uiStore';
import type { Chooser } from './model';
export interface Choice {
  id: string;
  label: string;
  hint: string;
  path?: string;
  mode?: ThemeMode;
}
export const CHOOSER_TITLES: Record<Chooser, string> = {
  theme: 'Change theme',
  favorites: 'Open favorite',
  agents: 'Open agent',
};
export function chooserRows(
  kind: Chooser,
  entries: Entry[],
  favorites: readonly string[],
  query: string,
): Choice[] {
  let choices: Choice[];
  if (kind === 'theme')
    choices = (['light', 'dark', 'system'] as const).map((mode) => ({
      id: `theme:${mode}`,
      label: mode[0].toUpperCase() + mode.slice(1),
      hint: '',
      mode,
    }));
  else if (kind === 'favorites') {
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    choices = favorites.flatMap((path) => {
      const entry = byPath.get(path);
      return entry ? [{ id: `favorite:${path}`, label: entry.title, hint: path, path }] : [];
    });
  } else
    choices = listAgents(entries).map((agent) => ({
      id: `agent:${agent.path}`,
      label: agent.title,
      path: agent.path,
      hint: `@${agent.handle}${isPaused(entries.find((entry) => entry.path === agent.path)!) ? ' · paused' : ''}`,
    }));
  if (!query.trim()) return choices;
  return rankNames({
    query,
    items: choices,
    texts: (choice) => [choice.label, choice.hint],
    limit: choices.length,
  }).items;
}
