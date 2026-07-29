import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { pickVault } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const APP_VERSION = '0.1.0';

/** One labelled toggle with its explanation — settings rows read as prose. */
function SettingRow({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`flex items-start gap-3 py-2 ${disabled ? 'opacity-50' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--n-800)]">{label}</div>
        <div className="mt-0.5 text-[11.5px] leading-[16px] text-[var(--n-500)]">{hint}</div>
      </div>
      <Switch ariaLabel={label} checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export function SettingsPage() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const openVault = useVaultStore((s) => s.openVault);
  const status = useVaultStore((s) => s.status);
  const error = useVaultStore((s) => s.error);
  const inboxEnabled = useUiStore((s) => s.inboxEnabled);
  const setInboxEnabled = useUiStore((s) => s.setInboxEnabled);
  const inboxAutoAdvance = useUiStore((s) => s.inboxAutoAdvance);
  const setInboxAutoAdvance = useUiStore((s) => s.setInboxAutoAdvance);
  const actorId = useUiStore((s) => s.actorId);
  const setActorId = useUiStore((s) => s.setActorId);

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
      <section className="mb-6 rounded-[14px] border border-[var(--n-200)] p-5">
        <h2 className="mb-1 text-[14px] font-semibold text-[var(--n-900)]">Workflow</h2>
        <p className="mb-4 text-[12.5px] text-[var(--n-500)]">
          Capture fast, organize deliberately. A note stays in the Inbox until it has a type.
        </p>
        <SettingRow
          label="Inbox"
          hint="Queue untyped captures for review. Off — every note reads as organized."
          checked={inboxEnabled}
          onChange={setInboxEnabled}
        />
        <SettingRow
          label="Auto-advance"
          hint="After marking a note organized, open the next one in the queue."
          checked={inboxAutoAdvance}
          onChange={setInboxAutoAdvance}
          disabled={!inboxEnabled}
        />
      </section>
      <section className="mb-6 rounded-[14px] border border-[var(--n-200)] p-5">
        <h2 className="mb-1 text-[14px] font-semibold text-[var(--n-900)]">Knowledge</h2>
        <p className="mb-4 text-[12.5px] text-[var(--n-500)]">
          The AI knowledge base in <span className="[font-family:var(--font-mono)]">knowledge/</span> is
          written by the agent and read-only here. Verifying a concept records who confirmed it.
        </p>
        <div className="flex items-start gap-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[var(--n-800)]">Your identity</div>
            <div className="mt-0.5 text-[11.5px] leading-[16px] text-[var(--n-500)]">
              Stamped as{' '}
              <span className="[font-family:var(--font-mono)]">human:{actorId || 'me'}</span> when you
              verify. The <span className="[font-family:var(--font-mono)]">human:</span> prefix is what
              separates your review from a machine's.
            </div>
          </div>
          <Input
            ariaLabel="Your identity"
            value={actorId}
            onChange={(e) => setActorId(e.target.value.trim())}
            className="w-[140px] flex-none"
          />
        </div>
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
