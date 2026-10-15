import { DESTINATIONS, GO_KEYS } from '@/engine/destinations';
import type { CommandDef } from './index';

export const commands: readonly CommandDef[] = DESTINATIONS.map((place) => ({
  id: `go.${place.id}`,
  label: place.label,
  keys: [GO_KEYS[place.id]!],
  scope: 'app',
  group: 'Go to',
  palette: false,
}));
