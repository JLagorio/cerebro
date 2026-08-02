import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { ConnectorSettings } from '@/app/ConnectorSettings';
import { jobQueue } from '@/engine/jobs';
import { GitSettings } from '@/git/GitSettings';
import { listConcepts } from '@/engine/okf';
import { pickVault } from '@/lib/ipc';
import { todayIso } from '@/lib/templates';
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
  const shellAccess = useUiStore((s) => s.agentShellAccess);
  const setShellAccess = useUiStore((s) => s.setAgentShellAccess);
  const connectors = useUiStore((s) => s.agentConnectors);
  const setConnectors = useUiStore((s) => s.setAgentConnectors);
  const issuePrefixes = useUiStore((s) => s.issuePrefixes);
  const setIssuePrefixes = useUiStore((s) => s.setIssuePrefixes);
  const autoLearn = useUiStore((s) => s.autoLearn);
  const setAutoLearn = useUiStore((s) => s.setAutoLearn);
  const learningPath = useUiStore((s) => s.learningPath);
  const filed = useUiStore((s) => s.filedForLearning);
  const attempts = useUiStore((s) => s.learnAttempts);
  const entries = useVaultStore((s) => s.entries);

  // The one place the outstanding count is shown at all. It belongs in
  // Settings and nowhere else: a number on the Rail that ticks up is the
  // "you have 47 unread" pattern the knowledge surfaces are barred from.
  const skillRuns = useUiStore((s) => s.skillRuns);
  const pending = useMemo(
    () =>
      jobQueue(entries, listConcepts(entries, todayIso()), {
        filed,
        attempts,
        // The fire-key ledger is vault-scoped (PR #5 review) — the count
        // must read the same slice of it the runner does.
        skillRuns: vaultPath === null ? {} : (skillRuns[vaultPath] ?? {}),
        connectors,
        // Render-time clock is honest enough here: this page re-renders on
        // every visit, and a due schedule missing until then costs a label.
        now: new Date(),
      }).length,
    [attempts, connectors, entries, filed, skillRuns, vaultPath],
  );

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
      <h1 className="mb-6 text-[18px] font-semibold tracking-[-0.01em] text-[var(--n-900)]">
        Settings
      </h1>
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
        <h2 className="mb-1 text-[14px] font-semibold text-[var(--n-900)]">Assistant</h2>
        <p className="mb-4 text-[12.5px] leading-[18px] text-[var(--n-500)]">
          What the assistant may change follows from where it is writing, not from a mode you pick
          each time: it owns <span className="[font-family:var(--font-mono)]">knowledge/</span> and
          writes there directly, and it reaches everything else through cerebro's own tools. Shell
          access is the one thing a folder boundary cannot express.
        </p>
        <SettingRow
          label="Shell access"
          hint="Let the assistant run commands and edit files directly inside the vault folder. Off — cerebro's tools only."
          checked={shellAccess}
          onChange={setShellAccess}
        />
        <SettingRow
          label="Connectors"
          hint="Let the assistant use MCP servers — Jira, Confluence — to fetch what a note refers to. Anything it fetches is written down under sources/, so the same ticket is only ever fetched once, and a cached copy past its refresh date is re-fetched in the background."
          checked={connectors}
          onChange={setConnectors}
        />
        {connectors && <ConnectorSettings />}
        <div className={`flex items-start gap-3 py-2 ${connectors ? '' : 'opacity-50'}`}>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[var(--n-800)]">Issue keys</div>
            <div className="mt-0.5 text-[11.5px] leading-[16px] text-[var(--n-500)]">
              Your tracker's project keys, comma separated —{' '}
              <span className="[font-family:var(--font-mono)]">PHX, SYN</span>. These cannot be
              guessed: <span className="[font-family:var(--font-mono)]">PHX-421</span> and{' '}
              <span className="[font-family:var(--font-mono)]">UTF-8</span> are the same shape, so
              without them nothing is treated as a ticket.
            </div>
          </div>
          <Input
            ariaLabel="Issue keys"
            value={issuePrefixes}
            placeholder="PHX, SYN"
            disabled={!connectors}
            onChange={(e) => setIssuePrefixes(e.target.value)}
            className="w-[140px] flex-none"
          />
        </div>
      </section>
      <section className="mb-6 rounded-[14px] border border-[var(--n-200)] p-5">
        <h2 className="mb-1 text-[14px] font-semibold text-[var(--n-900)]">Knowledge</h2>
        <p className="mb-4 text-[12.5px] text-[var(--n-500)]">
          The AI knowledge base in{' '}
          <span className="[font-family:var(--font-mono)]">knowledge/</span> is written by the agent
          and read-only here. Verifying a concept records who confirmed it.
        </p>
        <SettingRow
          label="Learn on its own"
          hint="Read filed captures, re-read notes you have edited since the base last read them, and run any skills that carry a schedule. Runs in the background, never interrupts, and unattended runs are additive-only. Off: the base grows only when you press Learn from this, and schedules do not fire."
          checked={autoLearn}
          onChange={setAutoLearn}
        />
        {pending > 0 && (
          <p className="m-0 mb-2 text-[11.5px] leading-[16px] text-[var(--n-500)]">
            {learningPath !== null
              ? `Reading ${learningPath} now.`
              : `${pending} background job${pending === 1 ? '' : 's'} waiting.`}
          </p>
        )}
        <div className="flex items-start gap-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-[var(--n-800)]">Your identity</div>
            <div className="mt-0.5 text-[11.5px] leading-[16px] text-[var(--n-500)]">
              Stamped as{' '}
              <span className="[font-family:var(--font-mono)]">human:{actorId || 'me'}</span> when
              you verify. The <span className="[font-family:var(--font-mono)]">human:</span> prefix
              is what separates your review from a machine's.
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
      <section className="mb-6 rounded-[14px] border border-[var(--n-200)] p-5">
        <GitSettings />
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
