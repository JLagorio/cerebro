import type { CreationContext, CreationDestination } from '@/engine/creationDestination';
import { getSchema } from './vaultStore';
import { isReservedTypeName } from '@/engine/typeCatalog';
import { create } from 'zustand';
import {
  availableRows,
  isCreateId,
  pruneRecents,
  recordUse,
  type CreateContext,
  type CreateId,
} from '@/app/createCatalog';
import { useNavStore } from './navStore';
import { useUiStore } from './uiStore';
import { useVaultStore } from './vaultStore';

const KEY = 'cerebro.launcherRecents';
export function createContext(): CreateContext {
  const vault = useVaultStore.getState();
  const place = useNavStore.getState().selection;
  return {
    ready:
      vault.vaultPath !== null &&
      vault.status === 'ready' &&
      vault.entriesVault === vault.vaultPath,
    page:
      place.kind === 'doc'
        ? (vault.entries.find((entry) => entry.path === place.path) ?? null)
        : null,
    inbox: useUiStore.getState().inboxEnabled,
  };
}
function readRecents(): Record<string, CreateId[]> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).map(([vault, ids]) => [vault, pruneRecents(ids)]),
    );
  } catch {
    return {};
  }
}
export interface CreateFlow {
  id: CreateId;
  vault: string;
  page: string | null;
  context: CreationContext;
}
interface LauncherState {
  open: boolean;
  flow: CreateFlow | null;
  recents: Record<string, CreateId[]>;
  openLauncher(): void;
  closeLauncher(): void;
  endFlow(): void;
  startCreate(id: string, destination?: CreationDestination): void;
}
export const useLauncherStore = create<LauncherState>((set) => ({
  open: false,
  flow: null,
  recents: readRecents(),
  openLauncher: () => {
    if (createContext().ready) set({ open: true, flow: null });
  },
  closeLauncher: () => set({ open: false }),
  endFlow: () => set({ flow: null }),
  startCreate: (id, destination) => {
    const ctx = createContext();
    const vault = useVaultStore.getState().vaultPath;
    if (vault === null || !isCreateId(id) || !availableRows(ctx).some((row) => row.id === id))
      return;
    const chosen: CreationDestination = structuredClone(
      destination ??
        (id === 'record'
          ? {
              kind: 'record',
              typeName:
                [...getSchema(useVaultStore.getState().entries).types.keys()]
                  .filter((name) => !isReservedTypeName(name))
                  .sort((a, b) => a.localeCompare(b))[0] ?? '',
              host: null,
              group: null,
            }
          : {
              kind: 'page',
              folder: '',
              recipe: id === 'sheet' ? { kind: 'sheet', sheetName: 'Sheet1' } : { kind: 'blank' },
            }),
    );
    const context: CreationContext = {
      vault,
      pane: useNavStore.getState().active,
      destination: chosen,
    };
    set((state) => {
      if (state.flow !== null && state.flow.vault === vault) return state;
      const recents = { ...state.recents, [vault]: recordUse(state.recents[vault] ?? [], id) };
      try {
        localStorage.setItem(KEY, JSON.stringify(recents));
      } catch {
        /* A blocked preference store cannot prevent creation. */
      }
      return { open: false, flow: { id, vault, page: ctx.page?.path ?? null, context }, recents };
    });
  },
}));
