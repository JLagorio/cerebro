import { missingFiles } from './filePresence';
import { readSelection, restorablePlace, type PlaceSnapshot } from '@/engine/placeResolves';
import { remapSelection } from '@/engine/panes';
import { listTypes } from '@/engine/typeCatalog';
import type { Selection } from '@/engine/types';
import { getSchema, useVaultStore } from '@/stores/vaultStore';
import { useRootsStore } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
export const LAST_PLACE_KEY = 'cerebro.lastPlace';
function readPlaces(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(LAST_PLACE_KEY) ?? '{}');
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
export function readLastPlace(vault: string): Selection | null {
  return readSelection(readPlaces()[vault]);
}
export function rememberLastPlace(vault: string, selection: Selection): void {
  try {
    window.localStorage.setItem(
      LAST_PLACE_KEY,
      JSON.stringify({ ...readPlaces(), [vault]: restorablePlace(selection) }),
    );
  } catch {
    /* Local convenience must never block navigation. */
  }
}
export function forgetLastPlace(vault: string): void {
  try {
    const places = readPlaces();
    delete places[vault];
    window.localStorage.setItem(LAST_PLACE_KEY, JSON.stringify(places));
  } catch {
    /* An unavailable preference store cannot block startup. */
  }
}
export function placeSnapshot(): PlaceSnapshot | null {
  const state = useVaultStore.getState();
  if (
    state.vaultPath === null ||
    state.status !== 'ready' ||
    state.entriesVault !== state.vaultPath
  )
    return null;
  const roots = useRootsStore.getState();
  return {
    entries: state.entries,
    missingFiles: missingFiles(state.vaultPath),
    collections: state.collections,
    views: state.views,
    types: listTypes(state.entries, getSchema(state.entries)).map((type) => type.name),
    folders: state.folders,
    roots: roots.roots,
    rootsLoaded: roots.rootsLoaded,
    inboxEnabled: useUiStore.getState().inboxEnabled,
  };
}

/** Only pointers.ts calls these after a rename has landed. */
export function remapLastPlace(vault: string, from: string, to: string): void {
  const place = readLastPlace(vault);
  if (place !== null && from !== to) rememberLastPlace(vault, remapSelection(place, from, to));
}
export function renameLastPlaceType(vault: string, from: string, to: string): void {
  const place = readLastPlace(vault);
  if (place?.kind === 'type' && place.name === from && from !== to)
    rememberLastPlace(vault, { ...place, name: to });
}
