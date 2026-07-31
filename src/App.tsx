import { useEffect, useState } from 'react';
import { AgentActions } from '@/agent/AgentActions';
import { AiPanel } from '@/agent/AiPanel';
import { useLearnRunner } from '@/agent/useLearnRunner';
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
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

function CanvasOutlet() {
  const selection = useNavStore((s) => s.selection);
  switch (selection.kind) {
    case 'home': return <HomePage />;
    case 'inbox': return <InboxPage />;
    case 'knowledge': return <KnowledgePage selection={selection} />;
    // M12.5: `project` retired — a project is a folder, and a folder on
    // screen is a Collection.
    case 'doc': return <DocPage selection={selection} />;
    case 'docs': return <DocsPage />;
    // M10: a Collection is the container's page; a List is the record canvas.
    case 'collection': return <CollectionPage selection={selection} />;
    case 'list': return <ListPage selection={selection} />;
    case 'type': return <TypePage selection={selection} />;
    case 'changes': return <ChangesPage />;
    case 'pulse': return <PulsePage />;
    case 'settings': return <SettingsPage />;
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
    <div className="flex h-screen items-center justify-center bg-[var(--n-25)]">
      <div className="flex w-[380px] flex-col gap-3 rounded-[14px] border border-[var(--n-200)] bg-[var(--n-0)] p-7 shadow-[var(--shadow-md)]">
        <span className="text-[18px] font-bold tracking-[-0.02em]">
          cerebro<span className="text-[var(--synapse-500)]">.</span>
        </span>
        <h1 className="m-0 text-[16px] font-semibold text-[var(--n-900)]">Open a vault</h1>
        <p className="m-0 text-[13px] leading-[19px] text-[var(--n-600)]">
          A vault is a folder of markdown files — projects, docs, and work items live there as
          plain text.
        </p>
        {(error ?? pickError) ? (
          <p className="m-0 text-[12px] text-[var(--danger-500)]">{error ?? pickError}</p>
        ) : null}
        <div className="mt-1 flex gap-2">
          <Button variant="primary" onClick={guarded(openDemo)}>Open demo vault</Button>
          <Button variant="secondary" onClick={guarded(chooseFolder)}>Choose folder…</Button>
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
  // M3.5: the sidebar's + opens the view builder — "New project" is gone,
  // because a project is just a saved view over Work items.
  // M10: null = the dialog is shut. Otherwise it holds the Collection folder the
  // new List lands in — never null, because a Collection-less List is forbidden
  // and the only entry point is a Collection's own + affordance.
  const [newList, setNewList] = useState<{ collection: string } | null>(null);
  // M8.6 — the base reads filed captures and edited notes on its own. Mounted
  // here rather than in the AI panel: the panel unmounts when you close it,
  // and a knowledge base that only grows while a panel is open is not one.
  useLearnRunner();

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
      // Quick capture (M4): writes an untyped note and opens the Inbox on
      // it, so capture never costs more than the keystroke.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void captureNote()
          .then(() => useNavStore.getState().navigate({ kind: 'inbox' }))
          .catch((err: unknown) => {
            useUiStore
              .getState()
              .toast(`Couldn't capture: ${err instanceof Error ? err.message : String(err)}`);
          });
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
    <div className="flex h-screen overflow-hidden bg-[var(--n-0)] text-[13px] leading-5 text-[var(--n-900)]">
      <Rail />
      <Sidebar onNewView={(collection) => setNewList({ collection })} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        {/* M11: the record panel is a COLUMN here, beside the canvas, rather
            than a fixed overlay on top of it. That is what lets a table keep
            its full horizontal scroll while a record is open. */}
        <div className="flex min-h-0 min-w-0 flex-1 bg-[var(--n-0)]">
          <CanvasOutlet />
          <DetailPanel />
        </div>
        {/* M9.7 — everything ambient about the vault in one strip, and every
            segment of it is a control rather than a readout. */}
        <StatusBar />
      </div>
      {aiPanelOpen && <AiPanel />}
      {newList !== null && (
        <ViewSettingsDialog
          initial={newViewDefinition(null, schema)}
          entries={entries}
          schema={schema}
          title="New list"
          onCancel={() => setNewList(null)}
          onSubmit={(definition) => {
            const collection = newList.collection;
            setNewList(null);
            void (async () => {
              const id = await createList(definition, collection);
              // Navigate WITH the collection: ids are unique per folder, so
              // "roadmap" alone could resolve to another collection's list.
              if (id !== null) navigate({ kind: 'list', id, collection });
            })();
          }}
        />
      )}
      <QuickOpen />
      <ToastHost />
      <RemindersHost />
      <CheckpointHost />
      <AgentActions />
    </div>
  );
}

export { App };
export default App;
