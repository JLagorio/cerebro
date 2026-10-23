import { isAgentEntry } from '@/engine/agents';
import { destination, type DestinationKind } from '@/engine/destinations';
import { isKnowledgePath } from '@/engine/okf';
import type { Entry, Selection } from '@/engine/types';

/** UI areas only. Their links still use the existing destination vocabulary. */
export const NAV_AREAS: readonly {
  id: NavArea;
  label: string;
  icon: string;
  destination?: DestinationKind;
}[] = [
  { id: 'home', label: 'Home', icon: destination('home').icon, destination: 'home' },
  { id: 'pages', label: 'Pages', icon: destination('pages').icon, destination: 'pages' },
  { id: 'databases', label: 'Databases', icon: 'database' },
  {
    id: 'knowledge',
    label: 'Knowledge',
    icon: destination('knowledge').icon,
    destination: 'knowledge',
  },
  { id: 'agents', label: 'Agents', icon: destination('agents').icon, destination: 'agents' },
  { id: 'work', label: 'Work', icon: destination('workspace').icon, destination: 'workspace' },
];
export type NavArea = 'home' | 'pages' | 'databases' | 'knowledge' | 'agents' | 'work';

export function areaForSelection(selection: Selection, entries: readonly Entry[]): NavArea {
  switch (selection.kind) {
    case 'pages':
      return 'pages';
    case 'workspace':
      return 'work';
    case 'agents':
      return 'agents';
    case 'knowledge':
      return 'knowledge';
    case 'type':
      return 'databases';
    case 'doc': {
      if (isKnowledgePath(selection.path)) return 'knowledge';
      const entry = entries.find((entry) => entry.path === selection.path);
      return entry !== undefined && isAgentEntry(entry) ? 'agents' : 'pages';
    }
    case 'collection':
    case 'list':
    case 'diagram':
    case 'file':
      return 'pages';
    default:
      return 'home';
  }
}
