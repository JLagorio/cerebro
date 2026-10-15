import { useEffect, useMemo, useState } from 'react';
import { useLedgerReview, useQuarantine } from '@/stores/ledgerStore';
import { Button } from '@/components/ui/Button';
import { ClaudeCodeRow } from '@/pages/ClaudeCodeRow';
import { RecentlyOpenedSettings } from '@/pages/RecentlyOpenedSettings';
import { CliWorkspaceRow } from '@/pages/CliWorkspaceRow';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Switch } from '@/components/ui/Switch';
import { ConnectorSettings } from '@/app/ConnectorSettings';
import { TrashSettings } from '@/app/TrashSettings';
import { listAgents } from '@/engine/agents';
import { isPaused, jobQueue } from '@/engine/jobs';
import type { Entry } from '@/engine/types';
import { GitSettings } from '@/git/GitSettings';
import { listConcepts } from '@/engine/okf';
import { APP_VERSION } from '@/lib/appVersion';
import { pickVault } from '@/lib/ipc';
import { todayIso } from '@/lib/templates';
import { claudeUserSettings } from '@/agent/agentIpc';
import type { ClaudeUserSettings } from '@/agent/types';
import { parseShellCeiling, type ShellCeiling } from '@/lib/policy/toolApproval';
import { asThemeMode, useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: 'sun', testId: 'theme-light' },
  { value: 'dark', label: 'Dark', icon: 'moon', testId: 'theme-dark' },
  { value: 'system', label: 'System', icon: 'monitor', testId: 'theme-system' },
];

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
        <div className="text-sm font-medium text-n-800">{label}</div>
        <div className="mt-0.5 text-xs leading-[16px] text-n-500">{hint}</div>
      </div>
      <Switch ariaLabel={label} checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

const SHELL_OPTIONS = [
  { value: 'off', label: 'Off', testId: 'shell-off' },
  { value: 'ask', label: 'Ask', testId: 'shell-ask' },
  { value: 'on', label: 'On', testId: 'shell-on' },
];

/** One hint per shell ceiling (Appendix C, M57.2). */
export const SHELL_HINTS: Record<ShellCeiling, string> = {
  off: "Cerebro's tools only. The assistant can't run commands or edit files directly.",
  ask: "A card in the conversation names each command or file change and waits for you. Scheduled agents can't ask, so they run without the shell, and their run says so.",
  on: 'The assistant runs commands and edits files directly in the vault folder without asking, and so do scheduled agents that declare the shell.',
};

/** The Web access hint (M57.7, Appendix C): a second ceiling, two states. */
export const WEB_HINT =
  "Let the assistant search the web and fetch pages with Claude Code's WebSearch and WebFetch. Pages it fetches are written down under sources/. Off — no web, even if your own Claude Code settings allow it. Cerebro's background upkeep never gets it.";

/** What the person's own settings act with, as a sentence (M57.2). Never a
 * promise that every command asks: their rules and hooks act first. */
export function userRulesSentence(settings: ClaudeUserSettings): string {
  const managed = "Settings your organization manages can act too, and Cerebro can't see them.";
  switch (settings.state) {
    case 'browser':
      return 'Desktop app only.';
    case 'unreadable':
      return `Couldn't read ${settings.path}, so Cerebro can't tell which commands your own rules allow without a card.`;
    case 'absent':
      return `No Claude Code settings file at ${settings.path}. ${managed}`;
    case 'read': {
      const events = settings.hook_events;
      if (settings.allow === 0 && events.length === 0) {
        return `Your Claude Code settings hold no allow rules or hooks. ${managed}`;
      }
      const rules = `${settings.allow} allow ${settings.allow === 1 ? 'rule' : 'rules'}`;
      const hooks =
        events.length === 0
          ? 'no hooks'
          : `hooks on ${events.length} ${events.length === 1 ? 'event' : 'events'} (${events.join(', ')})`;
      return `Your own Claude Code settings act before Cerebro asks: ${rules}, and ${hooks}. A command they allow runs without a card. ${managed}`;
    }
  }
}

/**
 * Shell access (M57.2): off, ask or on, and beside it what the person's own
 * Claude Code settings act with before Cerebro asks, re-read whenever the
 * window comes back, since they edit those settings elsewhere. A read that
 * failed says so (CV-05), never that there is nothing.
 */
function ShellAccessRow({ vaultPath }: { vaultPath: string | null }) {
  const shell = useUiStore((s) => s.agentShell);
  const setShell = useUiStore((s) => s.setAgentShell);
  const [settings, setSettings] = useState<ClaudeUserSettings | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => {
      claudeUserSettings(vaultPath).then(
        (found) => {
          if (live) setSettings(found);
        },
        (err: unknown) => {
          if (live) {
            setSettings({
              state: 'unreadable',
              path: 'your Claude Code settings',
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        },
      );
    };
    read();
    window.addEventListener('focus', read);
    return () => {
      live = false;
      window.removeEventListener('focus', read);
    };
  }, [vaultPath]);
  return (
    <div className="py-2">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-n-800">Shell access</div>
          <div data-testid="shell-hint" className="mt-0.5 text-xs leading-[16px] text-n-500">
            {SHELL_HINTS[shell]}
          </div>
        </div>
        <SegmentedControl
          ariaLabel="Shell access"
          options={SHELL_OPTIONS}
          value={shell}
          onChange={(v) => setShell(parseShellCeiling(v))}
          className="flex-none"
        />
      </div>
      {settings !== null && (
        <div
          data-testid="shell-user-rules"
          data-state={settings.state}
          className="mt-1.5 text-xs leading-[16px] text-n-500"
        >
          {userRulesSentence(settings)}
        </div>
      )}
    </div>
  );
}

/** The Select's value for "no agent": the plain assistant answers. */
const NO_AGENT = '';

/**
 * Who answers in this vault's assistant panel (M56.6). The binding is the
 * app's config, by vault path (app_config.rs), so the vault cannot choose
 * it; the choices are this vault's Agent records, by title.
 */
function PanelAgentRow({ vaultPath, entries }: { vaultPath: string; entries: Entry[] }) {
  const bound = useUiStore((s) => s.panelAgents[vaultPath] ?? null);
  const loadPanelAgent = useUiStore((s) => s.loadPanelAgent);
  const setPanelAgent = useUiStore((s) => s.setPanelAgent);
  useEffect(() => {
    void loadPanelAgent(vaultPath);
  }, [loadPanelAgent, vaultPath]);
  const agents = useMemo(() => {
    const byPath = new Map(entries.map((e) => [e.path, e]));
    return listAgents(entries).map((agent) => {
      const entry = byPath.get(agent.path);
      return { agent, paused: entry !== undefined && isPaused(entry) };
    });
  }, [entries]);
  const dangling = bound !== null && !agents.some(({ agent }) => agent.handle === bound);
  const options = [
    { value: NO_AGENT, label: 'Claude Code (no agent)' },
    ...agents.map(({ agent, paused }) => ({
      value: agent.handle,
      label: paused ? `${agent.title} (paused)` : agent.title,
    })),
    ...(dangling && bound !== null ? [{ value: bound, label: `@${bound} (not found)` }] : []),
  ];
  return (
    <div className="py-2">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-n-800">Panel assistant</div>
          <div className="mt-0.5 text-xs leading-[16px] text-n-500">
            Who answers in the assistant panel. An agent answers with its own instructions,
            preferences and limits, and its writes are attributed to it. A turn that names someone
            with @ still goes to them.
          </div>
        </div>
        <Select
          ariaLabel="Panel assistant"
          testId="panel-agent-select"
          size="sm"
          options={options}
          value={bound ?? NO_AGENT}
          onChange={(e) =>
            void setPanelAgent(vaultPath, e.target.value === NO_AGENT ? null : e.target.value)
          }
          className="w-[180px] flex-none"
        />
      </div>
      {dangling && (
        <div
          data-testid="panel-agent-dangling"
          className="mt-1 flex items-center gap-2 text-xs leading-[16px] text-warn-600"
        >
          <span className="min-w-0 flex-1">
            @{bound} — no agent answers to this name, so the assistant answers
          </span>
          <Button variant="secondary" size="sm" onClick={() => void setPanelAgent(vaultPath, null)}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const openVault = useVaultStore((s) => s.openVault);
  const status = useVaultStore((s) => s.status);
  const error = useVaultStore((s) => s.error);
  const themeMode = useUiStore((s) => s.themeMode);
  const setThemeMode = useUiStore((s) => s.setThemeMode);
  const inboxEnabled = useUiStore((s) => s.inboxEnabled);
  const setInboxEnabled = useUiStore((s) => s.setInboxEnabled);
  const inboxAutoAdvance = useUiStore((s) => s.inboxAutoAdvance);
  const setInboxAutoAdvance = useUiStore((s) => s.setInboxAutoAdvance);
  const actorId = useUiStore((s) => s.actorId);
  const setActorId = useUiStore((s) => s.setActorId);
  const webAccess = useUiStore((s) => s.agentWebAccess);
  const setWebAccess = useUiStore((s) => s.setAgentWebAccess);
  const connectors = useUiStore((s) => s.agentConnectors);
  const setConnectors = useUiStore((s) => s.setAgentConnectors);
  const issuePrefixes = useUiStore((s) => s.issuePrefixes);
  const setIssuePrefixes = useUiStore((s) => s.setIssuePrefixes);
  const autoLearn = useUiStore((s) => s.autoLearn);
  const setAutoLearn = useUiStore((s) => s.setAutoLearn);
  const reading = useUiStore((s) => s.runs.find((r) => r.owner === 'job')?.path ?? null);
  const attempts = useUiStore((s) => s.learnAttempts);
  const entries = useVaultStore((s) => s.entries);

  // The one place the outstanding count is shown at all. It belongs in
  // Settings and nowhere else: a number in the nav chrome that ticks up is the
  // "you have 47 unread" pattern the knowledge surfaces are barred from.
  const skillRuns = useUiStore((s) => s.skillRuns);
  const quarantine = useQuarantine();
  const ledgerReview = useLedgerReview();
  const pending = useMemo(
    () =>
      jobQueue(entries, listConcepts(entries, todayIso(), quarantine, ledgerReview), {
        attempts,
        // The fire-key ledger is vault-scoped (PR #5 review) — the count
        // must read the same slice of it the runner does.
        skillRuns: vaultPath === null ? {} : (skillRuns[vaultPath] ?? {}),
        // Render-time clock is honest enough here: this page re-renders on
        // every visit, and a due schedule missing until then costs a label.
        now: new Date(),
      }).length,
    [attempts, entries, skillRuns, vaultPath, quarantine, ledgerReview],
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
    // The scroll host Settings never had. Without `min-h-0 flex-1
    // overflow-y-auto` the column simply overflowed the flex row: everything
    // below the fold — Issue keys, Knowledge, Git, About — was unreachable by
    // scroll or by keyboard, and painted ON TOP of the status bar, swallowing
    // its clicks. PulsePage/ChangesPage already use exactly this pattern.
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-testid="settings-page">
      <div className="mx-auto w-full max-w-[640px] px-8 py-8">
        <h1 className="mb-6 text-xl font-semibold tracking-[-0.01em] text-n-900">Settings</h1>
        <section className="mb-6 rounded-xl border border-n-200 p-5">
          <h2 className="mb-1 text-md font-semibold text-n-900">Vault</h2>
          <p className="mb-3 text-sm text-n-500">
            Cerebro reads and writes plain markdown files in this folder.
          </p>
          <div className="mb-4 rounded-lg border border-n-200 bg-n-25 px-3 py-2 [font-family:var(--font-mono)] text-xs text-n-700">
            {vaultPath ?? 'No vault open'}
          </div>
          {status === 'error' && error ? (
            // Deviation from the plan's verbatim body (execution-log note 15a,
            // reported): vaultStore.status === 'error' was displayed nowhere —
            // surface it beside the recovery action.
            <p className="mb-4 text-xs text-danger-500">{error}</p>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            icon="folder-open"
            onClick={() => void changeVault()}
          >
            Change vault…
          </Button>
        </section>
        <TrashSettings />
        <section className="mb-6 rounded-xl border border-n-200 p-5">
          <h2 className="mb-1 text-md font-semibold text-n-900">Appearance</h2>
          <p className="mb-4 text-sm text-n-500">
            How cerebro looks. The choice is remembered on this machine.
          </p>
          <div className="flex items-start gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-n-800">Theme</div>
              <div className="mt-0.5 text-xs leading-[16px] text-n-500">
                System follows your operating system and changes with it — including when it
                switches on its own at sunset.
              </div>
            </div>
            <SegmentedControl
              ariaLabel="Theme"
              options={THEME_OPTIONS}
              value={themeMode}
              // asThemeMode rather than a cast: SegmentedControl's onChange is
              // typed `string`, and a cast would let a typo in THEME_OPTIONS
              // through the compiler and into localStorage.
              onChange={(v) => setThemeMode(asThemeMode(v))}
              className="flex-none"
            />
          </div>
        </section>
        <section className="mb-6 rounded-xl border border-n-200 p-5">
          <h2 className="mb-1 text-md font-semibold text-n-900">Workflow</h2>
          <p className="mb-4 text-sm text-n-500">
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
        <RecentlyOpenedSettings />
        <section className="mb-6 rounded-xl border border-n-200 p-5">
          <h2 className="mb-1 text-md font-semibold text-n-900">Assistant</h2>
          <p className="mb-4 text-sm leading-[18px] text-n-500">
            What the assistant may change follows from where it is writing, not from a mode you pick
            each time: it owns <span className="[font-family:var(--font-mono)]">knowledge/</span>{' '}
            and writes there directly, and it reaches everything else through cerebro's own tools.
            Shell access decides what Claude Code's own commands and file edits may do: never, after
            you answer a card, or directly.
          </p>
          <ClaudeCodeRow />
          {vaultPath !== null && <PanelAgentRow vaultPath={vaultPath} entries={entries} />}
          <ShellAccessRow vaultPath={vaultPath} />
          <SettingRow
            label="Web access"
            hint={WEB_HINT}
            checked={webAccess}
            onChange={setWebAccess}
          />
          <SettingRow
            label="Connectors"
            hint="Let the assistant use MCP servers — Jira, Confluence — to fetch what a note refers to. Anything it fetches is written down under sources/, so the same ticket is only ever fetched once. A cached copy past its refresh date is marked stale; ask for a fresh one when you need it."
            checked={connectors}
            onChange={setConnectors}
          />
          {connectors && <ConnectorSettings />}
          <CliWorkspaceRow />
          <div className={`flex items-start gap-3 py-2 ${connectors ? '' : 'opacity-50'}`}>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-n-800">Issue keys</div>
              <div className="mt-0.5 text-xs leading-[16px] text-n-500">
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
        <section className="mb-6 rounded-xl border border-n-200 p-5">
          <h2 className="mb-1 text-md font-semibold text-n-900">Knowledge</h2>
          <p className="mb-4 text-sm text-n-500">
            The AI knowledge base in{' '}
            <span className="[font-family:var(--font-mono)]">knowledge/</span> is written by the
            agent and recorded in its history. Your edits are recorded as edits, and verifying a
            concept records who confirmed it.
          </p>
          <SettingRow
            label="Learn on its own"
            hint="Recheck concepts that have gone stale or whose type changed, refresh cached sources, and run any skills or agents that carry a schedule. Runs in the background, never interrupts, and unattended runs are additive-only. Off by default: schedules do not fire and nothing is rechecked."
            checked={autoLearn}
            onChange={setAutoLearn}
          />
          {pending > 0 && (
            <p className="m-0 mb-2 text-xs leading-[16px] text-n-500">
              {reading !== null
                ? `Reading ${reading} now.`
                : `${pending} background job${pending === 1 ? '' : 's'} waiting.`}
            </p>
          )}
          <div className="flex items-start gap-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-n-800">Your identity</div>
              <div className="mt-0.5 text-xs leading-[16px] text-n-500">
                Stamped as{' '}
                <span className="[font-family:var(--font-mono)]">human:{actorId || 'me'}</span> when
                you verify. The <span className="[font-family:var(--font-mono)]">human:</span>{' '}
                prefix is what separates your review from a machine's.
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
        <section className="mb-6 rounded-xl border border-n-200 p-5">
          <GitSettings />
        </section>
        <section className="rounded-xl border border-n-200 p-5">
          <h2 className="mb-1 text-md font-semibold text-n-900">About</h2>
          <p className="text-sm text-n-500">
            Cerebro <span className="[font-family:var(--font-mono)]">{APP_VERSION}</span>
          </p>
        </section>
      </div>
    </div>
  );
}
