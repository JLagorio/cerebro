import { useEffect, useState } from 'react';
import { Rail } from '@/app/Rail';
import { Sidebar } from '@/app/Sidebar';
import { NewProjectDialog } from '@/app/CreateMenu';
import { QuickOpen } from '@/app/QuickOpen';
import { ToastHost } from '@/app/ToastHost';
import { DetailPanel } from '@/detail/DetailPanel';
import { DocPage } from '@/pages/DocPage';
import { HomePage } from '@/pages/HomePage';
import { ProjectPage } from '@/pages/ProjectPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { Topbar } from '@/app/Topbar';
import { Button } from '@/components/ui/Button';
import { getLastVault, pickVault } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function CanvasOutlet() {
  const selection = useNavStore((s) => s.selection);
  switch (selection.kind) {
    case 'home': return <HomePage />;
    case 'project': return <ProjectPage selection={selection} />;
    case 'doc': return <DocPage selection={selection} />;
    case 'view': return <ProjectPage selection={selection} />;
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

  const openDemo = async () => {
    if (isTauri) {
      const path = await pickVault();
      if (path) await openVault(path);
    } else {
      await openVault('/demo-vault');
    }
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
  const [booted, setBooted] = useState(false);
  // The Sidebar's "New project" row opens the project dialog (v2: no spaces).
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useUiStore.getState().setQuickOpen(true);
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
      <Sidebar onNewProject={() => setNewProjectOpen(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <div className="flex min-h-0 flex-1 bg-[var(--n-0)]">
          <CanvasOutlet />
        </div>
      </div>
      {newProjectOpen && <NewProjectDialog onClose={() => setNewProjectOpen(false)} />}
      <DetailPanel />
      <QuickOpen />
      <ToastHost />
    </div>
  );
}

export { App };
export default App;
