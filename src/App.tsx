import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AgentActions } from '@/agent/AgentActions';
import { AiPanel } from '@/agent/AiPanel';
import { JobRunnerHost } from '@/agent/useJobRunner';
import { CheckpointHost } from '@/git/CheckpointHost';
import { ReconciliationBanner } from '@/app/ReconciliationBanner';
import { RecordingBanner } from '@/app/RecordingBanner';
import {
  mainColumnFloor,
  mainColumnFloorPx,
  nextRailLatch,
  PARKED_TAB_WIDTH,
  panelRooms,
  SHELL_BARE_TWO_PANEL_MIN,
  SHELL_CLASSES,
  SHELL_PARKED_COLUMN_MIN,
  SHELL_RAIL_TWO_PANEL_MIN,
  SHELL_TWO_PANEL_MIN,
  shellBands,
  shellPlan,
  sidebarCeiling,
} from '@/app/shellLayout';
import { Sidebar } from '@/app/Sidebar';
import { StatusBar } from '@/app/StatusBar';
import { QuickOpen } from '@/app/QuickOpen';
import { ToastHost } from '@/app/ToastHost';
import { DetailPanel } from '@/detail/DetailPanel';
import { LayoutEditorDialog } from '@/detail/LayoutEditorDialog';
import { AgentsPage } from '@/pages/AgentsPage';
import { ChangesPage } from '@/pages/ChangesPage';
import { CollectionPage } from '@/pages/CollectionPage';
import { ListPage } from '@/pages/ListPage';
import { DiagramPage } from '@/pages/DiagramPage';
import { DocPage, usePageAsideOpen } from '@/pages/DocPage';
import { HomePage } from '@/pages/HomePage';
import { InboxPage } from '@/pages/InboxPage';
import { KnowledgePage } from '@/pages/KnowledgePage';
import { MyWorkPage } from '@/pages/MyWorkPage';
import { PulsePage } from '@/pages/PulsePage';
import { LibraryPage } from '@/library/LibraryPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { StudioPage } from '@/pages/StudioPage';
import { TypePage } from '@/pages/TypePage';
import { WorkspacePage } from '@/pages/WorkspacePage';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useMeasuredWidth } from '@/hooks/useMeasuredWidth';
import { RemindersHost } from '@/hooks/useReminders';
import { DARK_QUERY, resolveTheme, useTheme } from '@/hooks/useTheme';
import { captureNote } from '@/lib/capture';
import { getLastVault, openDemoVault, pickVault } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { CANVAS_MIN_WIDTH, RIGHT_PANEL_MIN_WIDTH, useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * A media query as React state (M15) — the shell had not one `@media` or
 * `matchMedia` in it before this.
 *
 * `useSyncExternalStore` rather than an effect + useState so the first paint
 * already knows how wide the window is: a layout that flips one frame after
 * mount is a visible jump on every launch.
 */
function useMediaQuery(query: string): boolean {
  const ref = useRef<MediaQueryList | null>(null);
  // jsdom (and any host without matchMedia) reports "not narrow", which is the
  // pre-M15 behaviour — never a crash.
  ref.current ??= typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
  const mql = ref.current;
  return useSyncExternalStore(
    (onChange) => {
      if (mql === null) return () => {};
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => mql?.matches ?? false,
    () => false,
  );
}

/**
 * Below this a full-width sidebar, a right-hand panel and a readable canvas
 * cannot all fit: 264 (sidebar default) + 400 (canvas floor) + 320 (panel
 * floor) = 984, with slack for the window chrome. M37.3 retired the rail's
 * 56px from this arithmetic when the shell flattened to one nav column.
 */
const SHELL_NARROW_MAX = 1048;

/**
 * Above this BOTH right-hand panels are drawn beside a sidebar column (M17.2).
 * Derived, not picked, from the floors the layout already enforces; it lives
 * in app/shellLayout.ts with the widths below it, where the sidebar steps
 * down to its rail, then the assistant parks, then the rail makes room for
 * the parked tab (M52).
 */
export { SHELL_TWO_PANEL_MIN };

function CanvasOutlet() {
  const selection = useNavStore((s) => s.selection);
  switch (selection.kind) {
    case 'home':
      return <HomePage />;
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
    // M29.21: a standalone .mmd opens as a full-page diagram editor. KEYED on
    // the path so navigating diagram→diagram is a true unmount/remount: the
    // page's debounced-save flush runs as an unmount cleanup, and an unkeyed
    // path change re-pointed the save at the NEW file before the OLD page's
    // pending edit had flushed — writing A's bytes into B and losing A's edit.
    case 'diagram':
      return <DiagramPage key={selection.path} selection={selection} />;
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

function VaultChooser() {
  const openVault = useVaultStore((s) => s.openVault);
  const error = useVaultStore((s) => s.error);
  // Deviation (Task 23, execution-log note 15c, reported): the async click
  // handlers were unguarded — a pickVault rejection was a silent unhandled
  // rejection with no feedback. Failures land in this local slot; the store
  // error stays for openVault failures.
  const [pickError, setPickError] = useState<string | null>(null);

  // The demo vault ships inside the app bundle and is copied out to a real
  // folder on first use (see src-tauri/src/demo.rs). Before that it opened a
  // folder picker, which asked a fresh install to find a vault that did not
  // exist yet.
  const openDemo = async () => {
    await openVault(await openDemoVault());
  };

  const chooseFolder = async () => {
    const path = await pickVault();
    if (path) await openVault(path);
  };

  const guarded = (task: () => Promise<void>) => () => {
    task().catch((err) => setPickError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="flex h-screen items-center justify-center bg-n-25">
      <div className="flex w-[380px] flex-col gap-3 rounded-xl border border-n-200 bg-n-0 p-7 shadow-[var(--shadow-md)]">
        <span className="text-xl font-bold tracking-[-0.02em]">
          cerebro<span className="text-synapse-500">.</span>
        </span>
        <h1 className="m-0 text-lg font-semibold text-n-900">Open a vault</h1>
        <p className="m-0 text-sm leading-[19px] text-n-600">
          A vault is a folder of markdown files — projects, docs, and work items live there as plain
          text.
        </p>
        {(error ?? pickError) ? (
          <p className="m-0 text-xs text-danger-500">{error ?? pickError}</p>
        ) : null}
        <div className="mt-1 flex gap-2">
          <Button variant="primary" onClick={guarded(openDemo)}>
            Open demo vault
          </Button>
          <Button variant="secondary" onClick={guarded(chooseFolder)}>
            Choose folder…
          </Button>
        </div>
      </div>
    </div>
  );
}

function App() {
  // Above every early return on purpose (M16.36): the vault chooser and the
  // blank pre-boot frame are painted too, and a launch that shows a white card
  // for a second before the shell arrives is the flash the theme work exists
  // to remove. index.html covers the first paint; this owns every one after.
  useTheme();
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const openVault = useVaultStore((s) => s.openVault);
  const [booted, setBooted] = useState(false);
  const aiPanelOpen = useUiStore((s) => s.aiPanelOpen);
  const detailPath = useUiStore((s) => s.detailPath);
  const narrow = useMediaQuery(`(max-width: ${SHELL_NARROW_MAX}px)`);
  // M17.2: the record panel and the assistant are independent again, so both
  // can be open at once. The room decides whether both are DRAWN — the one
  // that loses is hidden, never unmounted, because unmounting the assistant is
  // what killed its run mid-answer (see uiStore's detailPath comment).
  //
  // M52: CSS draws that decision (`SHELL_CLASSES`); these queries tell React
  // what CSS drew, for what CSS cannot say — `inert`, labels, drag ranges.
  // They arrive a frame late: a `matchMedia` change is reported after the
  // frame at the new size has been laid out, and WebKit reports it later
  // still. So nothing here may decide a width or what is on screen.
  const room = {
    column: useMediaQuery(`(min-width: ${SHELL_TWO_PANEL_MIN}px)`),
    rail: useMediaQuery(`(min-width: ${SHELL_RAIL_TWO_PANEL_MIN}px)`),
    bare: useMediaQuery(`(min-width: ${SHELL_BARE_TWO_PANEL_MIN}px)`),
    parkedColumn: useMediaQuery(`(min-width: ${SHELL_PARKED_COLUMN_MIN}px)`),
  };
  const detailOpen = detailPath !== null;
  const closeDetail = useUiStore((s) => s.closeDetail);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  // When only one fits, the RECORD wins: something just asked for it to be
  // seen — the agent's open_note, or a wikilink the user clicked — and that
  // request is the newer intent. The sidebar steps down to its rail before it
  // comes to that (M52). A parked assistant keeps streaming behind the record,
  // its tab says so, and closing the record brings it back intact.
  const shell = { detail: detailOpen, assistant: aiPanelOpen, collapsed: sidebarCollapsed };
  // The rail, once showing, stays below 1084 rather than growing back into a
  // column as the window shrinks (shellLayout `nextRailLatch`). Adjusted
  // during render, so the classes below never draw a frame of the old value.
  const [railLatched, setRailLatched] = useState(false);
  const latch = nextRailLatch(railLatched, { ...shell, room });
  if (latch !== railLatched) setRailLatched(latch);
  const plan = shellPlan({ ...shell, railLatched: latch, room });
  const bands = shellBands({ ...shell, railLatched: latch });
  const park = SHELL_CLASSES.park[bands.park];
  const showAssistant = plan.assistant === 'drawn';
  const parked = plan.assistant === 'parked';
  const aiWidth = useUiStore((s) => s.aiPanelWidth);
  // M52: a page on the canvas with its own side panel open asks the sidebar
  // for that panel's width as well — beside the assistant it was the page's
  // reading column that gave instead, down to a title one letter a line.
  const selection = useNavStore((s) => s.selection);
  const pagePath =
    selection.kind === 'doc'
      ? selection.path
      : selection.kind === 'knowledge'
        ? (selection.path ?? null)
        : null;
  const pageAside = usePageAsideOpen(pagePath);
  // M52: what each right-hand panel is drawn at, from the row it shares with
  // the canvas. CSS draws it (app/shellLayout.ts); these say it for the drag
  // handles and the widen control, which CSS cannot.
  const [canvasRowRef, rowWidth] = useMeasuredWidth();
  const rooms =
    rowWidth === null
      ? null
      : panelRooms({
          row: rowWidth,
          detail: detailOpen,
          assistant: showAssistant,
          assistantWidth: aiWidth,
          parked,
        });
  // The main column's floor, with the assistant drawn and with it parked;
  // `park.floor` picks between them in CSS.
  const drawnFloor = {
    detail: detailOpen,
    assistant: aiPanelOpen,
    assistantWidth: aiWidth,
    pageAside,
  };
  const parkedFloor = { ...drawnFloor, assistant: false, parked: true };
  // M52: the sidebar's drag stops at what can be drawn beside that floor.
  const [shellRef, shellWidth] = useMeasuredWidth();
  const sidebarMax = sidebarCeiling(
    shellWidth,
    mainColumnFloorPx(parked ? parkedFloor : drawnFloor),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useUiStore.getState().setQuickOpen(true);
      }
      // Cmd+J toggles the assistant (M6) — the panel is a companion to
      // whatever surface you are on, not a surface of its own.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        const ui = useUiStore.getState();
        ui.setAiPanelOpen(!ui.aiPanelOpen);
      }
      // Quick capture (M4): writes an untyped note and opens the Inbox ON IT.
      // M15: the resolved path is now SELECTED — throwing it away landed you
      // on whichever capture the persisted `inboxSelectedPath` still pointed
      // at, so the first thing you typed went into someone else's note.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void captureNote()
          .then((path) => {
            useUiStore.getState().setInboxSelectedPath(path);
            useNavStore.getState().navigate({ kind: 'inbox' });
          })
          .catch((err: unknown) => {
            useUiStore
              .getState()
              .toast(`Couldn't capture: ${err instanceof Error ? err.message : String(err)}`);
          });
      }
      // Cmd+Shift+L flips the theme — the binding Notion uses for the same job,
      // and M16's whole point is that Notion is the thing muscle memory arrives
      // from. Not routed through QuickOpen: QuickOpen.tsx keeps its navigate
      // mode deliberately, and one shortcut is cheaper than a command mode.
      //
      // Toggles against what is ON SCREEN, not against the stored mode. From
      // 'system' the user means "the opposite of what I am looking at", and
      // resolving first is the only way to know what that is — a naive
      // mode === 'dark' ? 'light' : 'dark' sends a system-dark user to dark.
      // Landing on an explicit mode is the intent: asking for the other one is
      // asking to stop following the OS.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        const ui = useUiStore.getState();
        const systemDark =
          typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
        ui.setThemeMode(resolveTheme(ui.themeMode, systemDark) === 'dark' ? 'light' : 'dark');
      }
      // M15: nav history existed in the store with no way to reach it. Not
      // bound while typing — ⌘[ / ⌘] are outdent/indent inside an editor, and
      // losing the page you are writing on is worse than having no shortcut.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === '[' || e.key === ']')) {
        const target = e.target;
        const editing =
          target instanceof HTMLElement &&
          (target.isContentEditable ||
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement);
        if (editing) return;
        e.preventDefault();
        if (e.key === '[') useNavStore.getState().back();
        else useNavStore.getState().forward();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Deviation (Task 23, execution-log note 15b, reported): without the
      // try/finally + catch, a getLastVault rejection left `booted` false
      // forever — a permanently blank screen instead of the chooser.
      try {
        const last = await getLastVault();
        if (last && !cancelled) await openVault(last);
      } finally {
        if (!cancelled) setBooted(true);
      }
    })().catch(() => {
      // getLastVault rejected: fall through to the vault chooser.
    });
    return () => {
      cancelled = true;
    };
  }, [openVault]);

  if (!vaultPath) {
    return booted ? <VaultChooser /> : null;
  }

  return (
    <div
      ref={shellRef}
      className="flex h-screen overflow-hidden bg-n-0 text-sm leading-5 text-n-900"
    >
      {/* The whole sidebar tree sits between the top of the tab order and the
          content, which in a real vault is dozens of stops. */}
      <button
        type="button"
        onClick={() => document.getElementById('main')?.focus()}
        className="sr-only rounded-md bg-cortex-500 px-3 py-1.5 text-xs font-medium text-n-0 focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        Skip to content
      </button>
      <Sidebar
        narrow={narrow}
        rail={plan.sidebar === 'rail'}
        railBand={bands.rail}
        maxWidth={sidebarMax}
      />
      {/* M15: the floor that makes the sidebar yield first. Without a minimum
          here the main column shrinks to nothing and the canvas absorbs every
          pixel of a narrow window; with it, flex has to take the shortfall out
          of the sidebar (which is shrinkable down to SIDEBAR_WIDTH_MIN).
          M52: the assistant counts at its whole width, and a page's own side
          panel at its own, so the sidebar gives before either does — and the
          parked tab instead of the assistant under the width it parks at. */}
      <div
        data-testid="main-column"
        className={`flex min-w-[var(--shell-floor)] flex-1 flex-col ${park.floor}`}
        style={
          {
            '--shell-floor': mainColumnFloor(drawnFloor),
            '--shell-floor-parked': mainColumnFloor(parkedFloor),
          } as React.CSSProperties
        }
      >
        {/* M49.2: "Not recording" — visible whenever this process holds no
            ledger writer for the vault (never in the browser mock). It also
            refreshes the ledger status both banners read.
            M23.7: the divergence circuit breaker's banner — visible while
            the ledger's reconciliation mode is open, or while any file is
            quarantined (M49.5: divergence is per path). */}
        <RecordingBanner vault={vaultPath} />
        <ReconciliationBanner vault={vaultPath} />
        {/* M11: the record panel is a COLUMN here, beside the canvas, rather
            than a fixed overlay on top of it. That is what lets a table keep
            its full horizontal scroll while a record is open.
            M15: the assistant moved in here too. As a sibling of the whole main
            column it stole width from the StatusBar as well as
            the canvas. `overflow-hidden` is the box nothing may paint outside,
            and `@container/canvas` lets a page respond to the width it actually
            has rather than the viewport's. */}
        <div
          ref={canvasRowRef}
          className="@container/canvas flex min-h-0 min-w-0 flex-1 overflow-hidden bg-n-0"
        >
          <main
            id="main"
            // -1 so the skip link can put focus here; no ring, because a ring
            // around the entire canvas reads as an error state.
            tabIndex={-1}
            className="flex flex-1 outline-none"
            // The floor itself. NOT `min-w-0` — that is exactly what made
            // content absorb 100% of any shortfall.
            style={{ minWidth: CANVAS_MIN_WIDTH }}
          >
            <CanvasOutlet />
          </main>
          {/* Capped against the CANVAS ROW rather than the viewport — a vw cap
              resolves against a box the panel does not live in, so it never
              engaged. M17.2: the record sits inboard of the assistant, so a
              turn that opens a note slides the record in beside the answer
              instead of on top of it. M52: inside the cap the record is the
              one that shrinks and the assistant is capped at the slot less
              the record's floor, so the two never add up to more than the
              cap — which clipped the assistant whenever they did — and CSS
              works it out in the same layout pass as the window. */}
          {(detailOpen || aiPanelOpen) && (
            <div
              data-testid="right-panel-slot"
              className="flex min-w-0 flex-none overflow-hidden"
              style={{ maxWidth: `calc(100% - ${CANVAS_MIN_WIDTH}px)` }}
            >
              {detailOpen && (
                <DetailPanel room={rooms?.detail ?? null} besideAssistant={showAssistant} />
              )}
              {/* One mount, drawn or parked, so crossing the width it parks
                  at never remounts it (M17.2: unmounting is what kills the
                  run). Parked is `park.frame`: clipped to zero width in the
                  same layout pass — see SHELL_CLASSES. `inert` (React 19)
                  follows a frame later, and takes it out of the tab order and
                  the a11y tree, which `aria-hidden` alone would not do. */}
              {aiPanelOpen && (
                <div
                  data-testid="ai-panel-frame"
                  data-parked={parked || undefined}
                  inert={parked}
                  className={`flex min-w-0 flex-none ${park.frame}`}
                  style={{
                    maxWidth: detailOpen ? `calc(100% - ${RIGHT_PANEL_MIN_WIDTH}px)` : '100%',
                  }}
                >
                  <AiPanel room={rooms?.assistant ?? null} />
                </div>
              )}
              {/* M52: parked, and saying so. The sidebar's zap stayed pressed
                  with nothing on screen to say where the assistant went or
                  why. The tab is the way back, and the way back is the
                  record's close. Inside the slot, so the record gives it its
                  strip in the same pass it parks in. */}
              {bands.park !== 'never' && (
                <button
                  type="button"
                  data-testid="ai-parked-tab"
                  aria-label="Assistant hidden — close the record to show it"
                  title="Assistant hidden — close the record to show it"
                  onClick={closeDetail}
                  className={`${park.tab} flex-none cursor-pointer flex-col items-center gap-2 border-0 border-l border-solid border-n-200 bg-surface-sunken py-3 text-n-500 hover:bg-n-50 hover:text-n-800`}
                  style={{ width: PARKED_TAB_WIDTH }}
                >
                  <Icon name="zap" size={14} color="var(--synapse-500)" />
                  <span className="text-xs font-medium [writing-mode:vertical-rl]">
                    Assistant hidden
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
        {/* M9.7 — everything ambient about the vault in one strip, and every
            segment of it is a control rather than a readout. */}
        <StatusBar />
      </div>
      <QuickOpen />
      {/* M45.2 — one mount, one signal: three menus raise uiStore.layoutEditor
          and this single App-level dialog is the only reader. */}
      <LayoutEditorDialog />
      <ToastHost />
      <RemindersHost />
      <CheckpointHost />
      {/* M8.6/M13.2 — the base reads filed captures and edited notes on its
          own, and scheduled skills fire, from one background runner. Mounted
          at the root rather than in the AI panel (the panel unmounts when
          closed, and a knowledge base that only grows while a panel is open
          is not one), and as a HOST so its minute tick re-renders nothing. */}
      <JobRunnerHost />
      <AgentActions />
    </div>
  );
}

export { App };
export default App;
