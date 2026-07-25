import { Button } from '@/components/ui/Button';
import { pickVault } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const APP_VERSION = '0.1.0';

export function SettingsPage() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const openVault = useVaultStore((s) => s.openVault);
  const status = useVaultStore((s) => s.status);
  const error = useVaultStore((s) => s.error);

  const changeVault = async () => {
    // Deviation from the plan's verbatim body (execution-log note 17b guard
    // discipline, reported): the folder picker itself can reject — catch and
    // toast instead of leaving an unhandled rejection. openVault never
    // rejects (it contains failures in store state), so no double-toast.
    try {
      const picked = await pickVault();
      if (picked) await openVault(picked);
    } catch {
      useUiStore.getState().toast("Couldn't open the folder picker");
    }
  };

  return (
    <div className="mx-auto w-full max-w-[640px] px-8 py-8">
      <h1 className="mb-6 text-[18px] font-semibold tracking-[-0.01em] text-[var(--n-900)]">Settings</h1>
      <section className="mb-6 rounded-[14px] border border-[var(--n-200)] p-5">
        <h2 className="mb-1 text-[14px] font-semibold text-[var(--n-900)]">Vault</h2>
        <p className="mb-3 text-[12.5px] text-[var(--n-500)]">
          Cerebro reads and writes plain markdown files in this folder.
        </p>
        <div className="mb-4 rounded-lg border border-[var(--n-200)] bg-[var(--n-25)] px-3 py-2 [font-family:var(--font-mono)] text-[12px] text-[var(--n-700)]">
          {vaultPath ?? 'No vault open'}
        </div>
        {status === 'error' && error ? (
          // Deviation from the plan's verbatim body (execution-log note 15a,
          // reported): vaultStore.status === 'error' was displayed nowhere —
          // surface it beside the recovery action.
          <p className="mb-4 text-[12px] text-[var(--danger-500)]">{error}</p>
        ) : null}
        <Button variant="secondary" size="sm" icon="folder-open" onClick={() => void changeVault()}>
          Change vault…
        </Button>
      </section>
      <section className="rounded-[14px] border border-[var(--n-200)] p-5">
        <h2 className="mb-1 text-[14px] font-semibold text-[var(--n-900)]">About</h2>
        <p className="text-[12.5px] text-[var(--n-500)]">
          Cerebro <span className="[font-family:var(--font-mono)]">{APP_VERSION}</span>
        </p>
      </section>
    </div>
  );
}
