import { PaneRow } from '@/app/PaneRow';
import { retainOsDropRouter } from '@/lib/osDrop';
import { usePageAsideOpen } from '@/pages/DocPage';
import { PaneLayoutHost } from '@/app/LastPlaceHost';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AgentActions } from '@/agent/AgentActions';
import { AiPanel } from '@/agent/AiPanel';
import { ChatTurnsHost } from '@/agent/ChatTurnsHost';
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
import { CreateLauncher } from '@/app/CreateLauncher';
import { useQuitHost, useQuitting } from '@/app/quit';
import { WindowTitle } from '@/app/WindowTitle';
import { QuitScreen } from '@/app/QuitScreen';
import { ChordHint } from '@/app/ChordHint';
import { ToastHost } from '@/app/ToastHost';
import { RenameLinksHost } from '@/app/RenameLinksHost';
import { useAppCommands } from '@/app/useAppCommands';
import { useUndoShortcuts } from '@/app/useUndoShortcuts';
import { DetailPanel } from '@/detail/DetailPanel';
import { LayoutEditorDialog } from '@/detail/LayoutEditorDialog';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useMeasuredWidth } from '@/hooks/useMeasuredWidth';
import { RemindersHost } from '@/hooks/useReminders';
import { useTheme } from '@/hooks/useTheme';
import { getLastVault, openDemoVault, pickVault } from '@/lib/ipc';
import { useKeyRoot } from '@/lib/keys/useKeys';
import { PaneContext, useNavStore } from '@/stores/navStore';
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
          A vault is a folder of markdown files — pages, databases and their records live there as
          plain text.
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
  // M55.10: ⌘Q, the close button and ⌘W save first. Above every early
  // return too, so the vault chooser answers a quit as well.
  useQuitHost();
  // M65.1: the one capture-phase key listener, and the General commands it
  // dispatches. Above every early return, so ⌘⇧L answers at the chooser too.
  useKeyRoot();
  useAppCommands();
  // M60.7: ⌘Z and ⇧⌘Z undo and redo the person's own changes, outside text
  // editors and layers; a diagram's own binding shadows them.
  useUndoShortcuts();
  const paneCount = useNavStore((state) => state.paneIds.length);
  const detailPane = useUiStore((state) => state.detailPane);
  const quitting = useQuitting();
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
    panes: paneCount,
  };
  const parkedFloor = { ...drawnFloor, assistant: false, parked: true };
  // M52: the sidebar's drag stops at what can be drawn beside that floor.
  const [shellRef, shellWidth] = useMeasuredWidth();
  const sidebarMax = sidebarCeiling(
    shellWidth,
    mainColumnFloorPx(parked ? parkedFloor : drawnFloor),
  );

  useEffect(retainOsDropRouter, []);
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

  // Leaving for the quit screen unmounts the shell, so every open page runs
  // its own leave path, exactly as navigating away does.
  if (quitting) return <QuitScreen />;

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
            and `@container/canvas` gives the single pane its full row width.
            With multiple panes each frame supplies its own canvas container. */}
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
            <PaneRow />
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
                <PaneContext value={detailPane}>
                  <DetailPanel room={rooms?.detail ?? null} besideAssistant={showAssistant} />
                </PaneContext>
              )}
              {/* One mount, drawn or parked, so crossing the width it parks
                  at never remounts it (M17.2): a remount detaches the
                  panel from its turn and reads the thread back, which a
                  resize has no business costing (M57.6). Parked is
                  `park.frame`: clipped to zero width in the same layout pass
                  — see SHELL_CLASSES. `inert` (React 19) follows a frame
                  later, and takes it out of the tab order and the a11y tree,
                  which `aria-hidden` alone would not do. A vault switch is
                  the one remount, and it is on purpose (M53.10): Rust ends
                  the old vault's runs as the new vault opens
                  (`stop_other_vaults`), and keyed by the vault, the remount
                  only lets go of them. */}
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
                  <AiPanel key={vaultPath} room={rooms?.assistant ?? null} />
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
      <CreateLauncher />
      {/* M45.2 — one mount, one signal: three menus raise uiStore.layoutEditor
          and this single App-level dialog is the only reader. */}
      <LayoutEditorDialog />
      <ToastHost />
      <ChordHint />
      <RenameLinksHost />
      <RemindersHost />
      <CheckpointHost />
      {/* M8.6/M13.2 — the base reads filed captures and edited notes on its
          own, and scheduled skills fire, from one background runner. Mounted
          at the root rather than in the AI panel (the panel unmounts when
          closed, and a knowledge base that only grows while a panel is open
          is not one), and as a HOST so its minute tick re-renders nothing. */}
      <JobRunnerHost />
      <AgentActions />
      <PaneLayoutHost />
      {/* M59.1 — the window title names the place; the chooser keeps
          index.html's own title, since this branch is the vault's. */}
      <WindowTitle />
      {/* M57.6 — a chat turn outlives its panel, so what its end does to
          the vault (end its run record, rescan, checkpoint) is settled here,
          once, whether or not the assistant is open. */}
      <ChatTurnsHost />
    </div>
  );
}

export { App };
export default App;
