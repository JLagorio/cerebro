import { FilePage } from '@/pages/FilePage';
import { isWhiteboardPath } from '@/engine/fileKinds';
import { CanvasPage } from '@/pages/CanvasPage';
import { useLayoutEffect } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Tooltip } from '@/components/ui/Tooltip';
import { placeLabel } from '@/engine/place';
import type { PaneId } from '@/engine/panes';
import { useMeasuredWidth } from '@/hooks/useMeasuredWidth';
import { useCommands, useKeyScope } from '@/lib/keys/useKeys';
import { PaneContext, useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { installOpenIntent } from './openIntent';
import { paneCapacity, paneParked, PANE_PARK, PANE_TAB } from './shellLayout';
import { AgentsPage } from '@/pages/AgentsPage';
import { ChangesPage } from '@/pages/ChangesPage';
import { CollectionPage } from '@/pages/CollectionPage';
import { ListPage } from '@/pages/ListPage';
import { DiagramPage } from '@/pages/DiagramPage';
import { DocPage } from '@/pages/DocPage';
import { HomePage } from '@/pages/HomePage';
import { PagesPage } from '@/pages/PagesPage';
import { InboxPage } from '@/pages/InboxPage';
import { KnowledgePage } from '@/pages/KnowledgePage';
import { MyWorkPage } from '@/pages/MyWorkPage';
import { PulsePage } from '@/pages/PulsePage';
import { LibraryPage } from '@/library/LibraryPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { StudioPage } from '@/pages/StudioPage';
import { TypePage } from '@/pages/TypePage';
import { WorkspacePage } from '@/pages/WorkspacePage';

/** Focus from a person's pane command follows the newly active page. Agent
 * navigation only changes the store and never takes the person's caret. */
function focusFrame(id: PaneId): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`)?.focus();
  });
}

function PaneFrame({
  id,
  index,
  rank,
  width,
  multiple,
}: {
  id: PaneId;
  index: number;
  rank: number;
  width: number | null;
  multiple: boolean;
}) {
  const page = useKeyScope('page', { page: true });
  const selection = useNavStore((state) => state.selection);
  const active = useNavStore((state) => state.active === id);
  const entries = useVaultStore((state) => state.entries);
  const views = useVaultStore((state) => state.views);
  const collections = useVaultStore((state) => state.collections);
  const parked = width !== null && paneParked(rank, width);
  const focus = () => useNavStore.getState().focusPane(id);
  return (
    <section
      {...page.props}
      data-testid="pane"
      data-pane-id={id}
      data-pane-index={index}
      data-active={active}
      data-parked={parked}
      inert={parked}
      tabIndex={-1}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
      className={`flex min-h-0 min-w-[400px] flex-1 flex-col overflow-hidden outline-none ${multiple ? '@container/canvas border-r border-n-200 last:border-r-0' : ''} ${PANE_PARK[rank]}`}
    >
      {multiple && (
        <div
          data-testid="pane-bar"
          className={`flex h-8 shrink-0 items-center gap-2 border-b border-n-200 px-3 text-xs ${active ? 'bg-[var(--surface-selected)] text-cortex-600' : 'bg-n-25 text-n-600'}`}
        >
          <span className="min-w-0 flex-1 truncate">
            {placeLabel(selection, { entries, views, collections })}
          </span>
          <Tooltip label="Close pane" command="pane.close">
            <button
              type="button"
              aria-label="Close pane"
              data-testid="pane-close"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm hover:bg-n-100"
              onClick={() => useNavStore.getState().closePane(id)}
            >
              <Icon name="x" size={12} />
            </button>
          </Tooltip>
        </div>
      )}
      <page.Provider>
        <PaneOutlet />
      </page.Provider>
    </section>
  );
}

function ParkedTab({ id, rank }: { id: PaneId; rank: number }) {
  const selection = useNavStore((state) => state.selection);
  const entries = useVaultStore((state) => state.entries);
  const views = useVaultStore((state) => state.views);
  const collections = useVaultStore((state) => state.collections);
  const label = placeLabel(selection, { entries, views, collections });
  return (
    <button
      type="button"
      data-testid="pane-parked-tab"
      aria-label={`Show ${label}`}
      title={label}
      className={`h-28 w-8 shrink-0 items-center justify-center border-b border-n-200 px-1 text-xs text-n-600 hover:bg-n-100 ${PANE_TAB[rank]}`}
      onClick={() => {
        useNavStore.getState().focusPane(id);
        focusFrame(id);
      }}
    >
      <span className="max-h-24 truncate [writing-mode:vertical-rl]">{label}</span>
    </button>
  );
}

export function PaneRow() {
  const ids = useNavStore((state) => state.paneIds);
  const order = useNavStore((state) => state.focusOrder);
  const [rowRef, width] = useMeasuredWidth();
  useLayoutEffect(() => installOpenIntent(), []);
  useLayoutEffect(() => {
    if (width !== null) useNavStore.getState().setPaneCapacity(paneCapacity(width));
  }, [width]);
  const cycle = (delta: number) => {
    const nav = useNavStore.getState();
    const id =
      nav.paneIds[
        (nav.paneIds.indexOf(nav.active) + delta + nav.paneIds.length) % nav.paneIds.length
      ];
    nav.focusPane(id);
    focusFrame(id);
  };
  useCommands([
    {
      id: 'pane.focusNext',
      run: () => cycle(1),
      when: () => useNavStore.getState().paneIds.length > 1,
    },
    {
      id: 'pane.focusPrev',
      run: () => cycle(-1),
      when: () => useNavStore.getState().paneIds.length > 1,
    },
    {
      id: 'pane.close',
      run: () => {
        useNavStore.getState().closePane();
        focusFrame(useNavStore.getState().active);
      },
    },
  ]);
  return (
    <div
      ref={rowRef}
      data-testid="pane-row"
      className="@container/panes flex min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      {ids.map((id, index) => (
        <PaneContext key={id} value={id}>
          <PaneFrame
            id={id}
            index={index}
            rank={order.indexOf(id)}
            width={width}
            multiple={ids.length > 1}
          />
        </PaneContext>
      ))}
      {ids.length > 1 && (
        <div
          className={`w-8 shrink-0 flex-col border-l border-n-200 bg-n-25 ${PANE_TAB[ids.length - 1]}`}
        >
          {ids
            .filter((id) => order.indexOf(id) > 0)
            .map((id) => (
              <PaneContext key={id} value={id}>
                <ParkedTab id={id} rank={order.indexOf(id)} />
              </PaneContext>
            ))}
        </div>
      )}
    </div>
  );
}

export function PaneOutlet() {
  const selection = useNavStore((s) => s.selection);
  switch (selection.kind) {
    case 'home':
      return <HomePage />;
    case 'pages':
      return <PagesPage />;
    case 'inbox':
      return <InboxPage />;
    // M43 — open work across every database, grouped by type.
    case 'mywork':
      return <MyWorkPage />;
    case 'knowledge':
      return <KnowledgePage selection={selection} />;
    // M12.5: `project` retired — a project is a folder, and a folder on
    // screen is a Collection.
    case 'doc':
      return <DocPage selection={selection} />;
    case 'file':
      return <FilePage key={selection.path} selection={selection} />;
    // M29.21: a standalone .mmd opens as a full-page diagram editor. KEYED on
    // the path so navigating diagram→diagram is a true unmount/remount: the
    // page's debounced-save flush runs as an unmount cleanup, and an unkeyed
    // path change re-pointed the save at the NEW file before the OLD page's
    // pending edit had flushed — writing A's bytes into B and losing A's edit.
    case 'diagram':
      return isWhiteboardPath(selection.path) ? (
        <CanvasPage key={selection.path} selection={selection} />
      ) : (
        <DiagramPage key={selection.path} selection={selection} />
      );
    // M10: a Collection is the container's page; a List is the record canvas.
    case 'collection':
      return <CollectionPage selection={selection} />;
    case 'list':
      return <ListPage selection={selection} />;
    case 'type':
      return <TypePage selection={selection} />;
    case 'changes':
      return <ChangesPage />;
    case 'pulse':
      return <PulsePage />;
    case 'library':
      return <LibraryPage />;
    // M30 — mounted repositories: file tree, viewer, and the cross-root docs
    // index. Takes the selection so the open file survives Back.
    case 'workspace':
      return <WorkspacePage selection={selection} />;
    // M40 — the prototype surface. Takes the selection so the open
    // prototype survives Back.
    case 'studio':
      return <StudioPage selection={selection} />;
    // M41 — the agents' front door. Same contract: the open agent survives
    // Back.
    case 'agents':
      return <AgentsPage selection={selection} />;
    case 'settings':
      return <SettingsPage />;
  }
}
