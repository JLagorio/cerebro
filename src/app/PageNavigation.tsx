import { createContext, useContext, type ReactNode } from 'react';
import type { PaneId } from '@/engine/panes';
import { usePaneId, useNavStore } from '@/stores/navStore';
import { useKeyScopeProps } from '@/lib/keys/useKeys';

export type PageNavigationKind = 'inbox' | 'settings' | 'workspace' | 'studio';

export interface PageNavigationControls {
  show(opener?: HTMLElement): void;
  hide(): void;
}

export interface PageNavigationState {
  kind: PageNavigationKind | null;
  paneId: PaneId;
  target: HTMLElement | null;
  controls: PageNavigationControls;
}

const PageNavigationContext = createContext<PageNavigationState | null>(null);

export const PageNavigationProvider = PageNavigationContext.Provider;

function useNavigation(kind: PageNavigationKind): PageNavigationState | null {
  const state = useContext(PageNavigationContext);
  const pane = usePaneId();
  return state?.kind === kind && state.paneId === pane ? state : null;
}

/** Only the active pane lends its existing controller to the shell. A page
 * mounted alone, or an inactive pane, keeps its navigation locally. */
export function usePageNavigationSlot(kind: PageNavigationKind): HTMLElement | null {
  return useNavigation(kind)?.target ?? null;
}

export function usePageNavigationControls(kind: PageNavigationKind): PageNavigationControls | null {
  return useNavigation(kind)?.controls ?? null;
}

/** React portals retain their page context but move outside its DOM key
 * scope. Reuse that scope, without creating a second controller or binding. */
export function PageNavigationContent({ children }: { children: ReactNode }) {
  const scope = useKeyScopeProps();
  const pane = usePaneId();
  const navigation = useContext(PageNavigationContext);
  const focus = () => useNavStore.getState().focusPane(pane);
  return (
    <div
      {...scope}
      className="m75-page-navigation"
      onPointerDownCapture={focus}
      onFocusCapture={focus}
      onClick={(event) => {
        if (
          navigation?.paneId === pane &&
          navigation.target?.contains(event.currentTarget) &&
          event.target instanceof Element &&
          event.target.closest('[data-page-navigation-item]')
        ) {
          navigation.controls.hide();
        }
      }}
    >
      {children}
    </div>
  );
}
