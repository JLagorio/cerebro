import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AgentActions } from '@/agent/AgentActions';
import { AiPanel } from '@/agent/AiPanel';
import { JobRunnerHost } from '@/agent/useJobRunner';
import { CheckpointHost } from '@/git/CheckpointHost';
import { Rail } from '@/app/Rail';
import { Sidebar } from '@/app/Sidebar';
import { StatusBar } from '@/app/StatusBar';
import { createList } from '@/app/listActions';
import { newViewDefinition, ViewSettingsDialog } from '@/app/ViewSettingsDialog';
import { QuickOpen } from '@/app/QuickOpen';
import { ToastHost } from '@/app/ToastHost';
import { DetailPanel } from '@/detail/DetailPanel';
import { ChangesPage } from '@/pages/ChangesPage';
import { CollectionPage } from '@/pages/CollectionPage';
import { ListPage } from '@/pages/ListPage';
import { DocPage } from '@/pages/DocPage';
import { DocsPage } from '@/pages/DocsPage';
import { HomePage } from '@/pages/HomePage';
import { InboxPage } from '@/pages/InboxPage';
import { KnowledgePage } from '@/pages/KnowledgePage';
import { PulsePage } from '@/pages/PulsePage';
import { SettingsPage } from '@/pages/SettingsPage';
import { TypePage } from '@/pages/TypePage';
import { Topbar } from '@/app/Topbar';
import { Button } from '@/components/ui/Button';
import { RemindersHost } from '@/hooks/useReminders';
import { captureNote } from '@/lib/capture';
import { getLastVault, openDemoVault, pickVault } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { CANVAS_MIN_WIDTH, RIGHT_PANEL_MIN_WIDTH, useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

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
 * Below this the rail, a full-width sidebar, a right-hand panel and a readable
 * canvas cannot all fit: 56 (rail) + 264 (sidebar) + 400 (canvas floor) + 320
 * (panel floor) = 1040, with slack for the window chrome.
 */
const SHELL_NARROW_MAX = 1120;

function CanvasOutlet() {
  const selection = useNavStore((s) => s.selection);
  switch (selection.kind) {
    case 'home':
      return <HomePage />;
    case 'inbox':
      return <InboxPage />;
    case 'knowledge':
      return <KnowledgePage selection={selection} />;
    // M12.5: `project` retired — a project is a folder, and a folder on
    // screen is a Collection.
    case 'doc':
      return <DocPage selection={selection} />;
    case 'docs':
      return <DocsPage />;
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
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const openVault = useVaultStore((s) => s.openVault);
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const navigate = useNavStore((s) => s.navigate);
  const [booted, setBooted] = useState(false);
  const aiPanelOpen = useUiStore((s) => s.aiPanelOpen);
  const detailPath = useUiStore((s) => s.detailPath);
  const narrow = useMediaQuery(`(max-width: ${SHELL_NARROW_MAX}px)`);
  // ONE right-hand slot (M15). The store keeps these two mutually exclusive;
  // this is only which of them is drawn.
  const rightPanel: 'assistant' | 'detail' | null = aiPanelOpen
    ? 'assistant'
    : detailPath !== null
      ? 'detail'
      : null;
  // M3.5: the sidebar's + opens the view builder — "New project" is gone,
  // because a project is just a saved view over Work items.
  // M10: null = the dialog is shut. Otherwise it holds the Collection folder the
  // new List lands in — never null, because a Collection-less List is forbidden
  // and the only entry point is a Collection's own + affordance.
  const [newList, setNewList] = useState<{ collection: string } | null>(null);

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
    <div className="flex h-screen overflow-hidden bg-n-0 text-sm leading-5 text-n-900">
      {/* The rail and the whole sidebar tree sit between the top of the tab
          order and the content, which in a real vault is dozens of stops. */}
      <button
        type="button"
        onClick={() => document.getElementById('main')?.focus()}
        className="sr-only rounded-md bg-cortex-500 px-3 py-1.5 text-xs font-medium text-n-0 focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        Skip to content
      </button>
      <Rail />
      <Sidebar narrow={narrow} onNewView={(collection) => setNewList({ collection })} />
      {/* M15: the floor that makes the sidebar yield first. Without a minimum
          here the main column shrinks to nothing and the canvas absorbs every
          pixel of a narrow window; with it, flex has to take the shortfall out
          of the sidebar (which is shrinkable down to SIDEBAR_WIDTH_MIN). */}
      <div
        className="flex min-w-0 flex-1 flex-col"
        style={{
          minWidth: CANVAS_MIN_WIDTH + (rightPanel !== null ? RIGHT_PANEL_MIN_WIDTH : 0),
        }}
      >
        <Topbar />
        {/* M11: the record panel is a COLUMN here, beside the canvas, rather
            than a fixed overlay on top of it. That is what lets a table keep
            its full horizontal scroll while a record is open.
            M15: the assistant moved in here too. As a sibling of the whole main
            column it stole width from the Topbar and the StatusBar as well as
            the canvas. `overflow-hidden` is the box nothing may paint outside,
            and `@container/canvas` lets a page respond to the width it actually
            has rather than the viewport's. */}
        <div className="@container/canvas flex min-h-0 min-w-0 flex-1 overflow-hidden bg-n-0">
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
          {/* ONE slot, and it is capped against the CANVAS ROW rather than the
              viewport — a vw cap resolves against a box the panel does not live
              in, so it never engaged. */}
          {rightPanel !== null && (
            <div
              data-testid="right-panel-slot"
              className="flex min-w-0 flex-none overflow-hidden"
              style={{ maxWidth: `calc(100% - ${CANVAS_MIN_WIDTH}px)` }}
            >
              {rightPanel === 'assistant' ? <AiPanel /> : <DetailPanel />}
            </div>
          )}
        </div>
        {/* M9.7 — everything ambient about the vault in one strip, and every
            segment of it is a control rather than a readout. */}
        <StatusBar />
      </div>
      {newList !== null && (
        <ViewSettingsDialog
          initial={newViewDefinition(null, schema)}
          entries={entries}
          schema={schema}
          title="New list"
          onCancel={() => setNewList(null)}
          onSubmit={async (definition) => {
            const collection = newList.collection;
            const id = await createList(definition, collection);
            // Close only on success (M14.8) — a failed write already toasted,
            // and the dialog keeps the view the user configured.
            if (id === null) return false;
            setNewList(null);
            // Navigate WITH the collection: ids are unique per folder, so
            // "roadmap" alone could resolve to another collection's list.
            navigate({ kind: 'list', id, collection });
            return true;
          }}
        />
      )}
      <QuickOpen />
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
