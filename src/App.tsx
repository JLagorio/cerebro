import { useEffect, useState } from 'react';
import { Rail } from '@/app/Rail';
import { Sidebar } from '@/app/Sidebar';
import { Topbar } from '@/app/Topbar';
import { Button } from '@/components/ui/Button';
import { getLastVault, pickVault } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function CanvasPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--n-400)]">
      {label}
    </div>
  );
}

function CanvasOutlet() {
  const selection = useNavStore((s) => s.selection);
  switch (selection.kind) {
    case 'home': return <CanvasPlaceholder label="Home" />;
    case 'space': return <CanvasPlaceholder label="Space" />;
    case 'project': return <CanvasPlaceholder label="Project" />;
    case 'view': return <CanvasPlaceholder label="View" />;
    case 'settings': return <CanvasPlaceholder label="Settings" />;
  }
}

function VaultChooser() {
  const openVault = useVaultStore((s) => s.openVault);
  const error = useVaultStore((s) => s.error);

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

  return (
    <div className="flex h-screen items-center justify-center bg-[var(--n-25)]">
      <div className="flex w-[380px] flex-col gap-3 rounded-[14px] border border-[var(--n-200)] bg-[var(--n-0)] p-7 shadow-[var(--shadow-md)]">
        <span className="text-[18px] font-bold tracking-[-0.02em]">
          cerebro<span className="text-[var(--synapse-500)]">.</span>
        </span>
        <h1 className="m-0 text-[16px] font-semibold text-[var(--n-900)]">Open a vault</h1>
        <p className="m-0 text-[13px] leading-[19px] text-[var(--n-600)]">
          A vault is a folder of markdown files — spaces, projects, and work items live there as
          plain text.
        </p>
        {error ? <p className="m-0 text-[12px] text-[var(--danger-500)]">{error}</p> : null}
        <div className="mt-1 flex gap-2">
          <Button variant="primary" onClick={openDemo}>Open demo vault</Button>
          <Button variant="secondary" onClick={chooseFolder}>Choose folder…</Button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const openVault = useVaultStore((s) => s.openVault);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const last = await getLastVault();
      if (last && !cancelled) await openVault(last);
      if (!cancelled) setBooted(true);
    })();
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
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onNew={() => { /* CreateMenu wiring lands in Task 23 */ }} />
        <div className="flex min-h-0 flex-1 bg-[var(--n-0)]">
          <CanvasOutlet />
        </div>
      </div>
    </div>
  );
}

export { App };
export default App;
