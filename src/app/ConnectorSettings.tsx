import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import {
  approvalKey,
  CONNECTOR_PRESETS,
  httpHeaders,
  httpOAuth,
  httpTimeout,
  parseConnectors,
  presetHolder,
  presetSpec,
  removalNote,
  serializeConnectors,
  signInBlocker,
  signInCommand,
  stateLabel,
  stdioEnv,
  type ConnectorSpec,
  type ConnectorState,
  type ConnectorStatusRow,
} from '@/engine/connectors';
import { relativeWhen } from '@/engine/whenText';
import { connectorStatus, readConnectors, saveConnectors } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** Pairs sorted by key, the order a fingerprint sorts them in. */
function sortedPairs<V>(record: Record<string, V>): [string, V][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The status read (M54.11). A failed read is its own state, never no rows. */
type StatusRead =
  | { kind: 'loading' }
  | { kind: 'ready'; rows: ConnectorStatusRow[] }
  | { kind: 'unavailable'; reason: string };

/** What a row says after its name: a switch or an approval this machine
 * decides, a refusal Rust found, or what the last run that used it saw.
 * `words` is null while the status is loading or unreadable, so no row
 * claims an observation nobody could read. */
interface RowStatus {
  key:
    'off' | 'refused' | 'unapproved' | 'loading' | 'unavailable' | 'not_observed' | ConnectorState;
  words: string | null;
}

const OBSERVED: readonly string[] = ['working', 'needs_sign_in', 'failed', 'not_approved'];

/** One line on what to do about a state, where there is something to do. */
const HINTS: Partial<Record<RowStatus['key'], string>> = {
  failed:
    'The last run that used it got no answer from it — check that the server is up and its URL is right.',
  not_approved:
    'Your own Claude Code permission rules stopped its tools in the last run — allow them with /permissions in claude.',
};

/** What a row that needs sign-in says in place of a command it cannot show. */
function withoutCommand(spec: ConnectorSpec): string {
  switch (signInBlocker(spec)) {
    case 'name':
      return `Claude Code adds a connector only under a name of letters, digits, - and _, so rename ${spec.name} here, then sign in.`;
    case 'entry':
      return 'Its URL or one of its headers holds a character other than printable ASCII, which a pasted command must not carry, so fix this entry in .cerebro/connectors.json, then sign in.';
    case 'stdio':
    case null:
      return `Run claude, type /mcp, and sign in to ${spec.name}.`;
  }
}

/**
 * The vault's connector list (M13.3) — `.cerebro/connectors.json` with a
 * face. Naming a server here pins the agent's runs to EXACTLY this list
 * (--strict-mcp-config): an entry that is on and approved on this machine is
 * merged in, and a run is granted its tools by name unless its agent's record
 * narrows it (M54.9). A vault with no list keeps the legacy behavior for
 * turns you watch that name no connector: your own MCP config loads, and
 * Cerebro grants none of its tools. Credentials never enter cerebro: entries
 * reference the user's own servers, and headers/env are edited in the file
 * itself, not here. A preset (M69.1) writes its own name, URL and oauth
 * scopes, and its sign-in happens in Claude Code like any other.
 *
 * Each entry shows the last status a run saw it in (M54.11), read on mount
 * and again whenever the window regains focus, since a sign-in finishes in a
 * terminal. One that needs sign-in shows the command that adds it to Claude
 * Code, where `/mcp` signs in: the token stays there, never here. An entry
 * the command cannot carry safely, such as a URL holding a control
 * character, shows what to fix instead of a command to paste.
 */
export function ConnectorSettings() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);
  // Approvals live in the store — OUTSIDE the vault — so the file cannot
  // approve itself; see uiStore.stdioApprovals (PR #5 security review),
  // which holds both transports' keys since M54.9.
  const approvals = useUiStore((s) => s.stdioApprovals);
  const approve = useUiStore((s) => s.approveStdio);
  const revoke = useUiStore((s) => s.revokeStdio);
  const [specs, setSpecs] = useState<ConnectorSpec[] | null>(null);
  // True while `.cerebro/connectors.json` exists — an EMPTY list with the
  // file present still pins runs to no servers, so the two need telling
  // apart to say so, and to offer the way back.
  const [filePresent, setFilePresent] = useState(false);
  // The read FAILED — permissions, or a symlinked `.cerebro` the backend
  // refuses to follow. Not the same state as "no list" (PR #5 review): runs
  // fail closed on a config they cannot read, so rendering this as "no
  // explicit list" would claim legacy open mode while runs are pinned to
  // zero connectors. Said out loud instead, with the reason.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadSeq, setLoadSeq] = useState(0);
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const [target, setTarget] = useState('');
  const [status, setStatus] = useState<StatusRead>({ kind: 'loading' });
  // The connector whose sign-in command the clipboard took, set only once
  // the write resolved.
  const [copied, setCopied] = useState<string | null>(null);
  // Only the newest status read lands: a focus read can overtake one still
  // in flight, and a vault switch drops both.
  const statusSeq = useRef(0);

  const readStatus = useCallback((vault: string) => {
    const seq = ++statusSeq.current;
    void connectorStatus(vault).then(
      (rows) => {
        if (seq === statusSeq.current) setStatus({ kind: 'ready', rows });
      },
      (e: unknown) => {
        if (seq === statusSeq.current) {
          setStatus({ kind: 'unavailable', reason: e instanceof Error ? e.message : String(e) });
        }
      },
    );
  }, []);

  useEffect(() => {
    setStatus({ kind: 'loading' });
    setCopied(null);
    if (vaultPath === null) return;
    readStatus(vaultPath);
    const onFocus = () => {
      setCopied(null);
      readStatus(vaultPath);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      statusSeq.current += 1;
    };
  }, [vaultPath, readStatus]);

  useEffect(() => {
    // Cleared FIRST: the previous vault's rows must not stay interactive
    // while the new vault's config loads — a click would write them there.
    setSpecs(null);
    setFilePresent(false);
    setLoadError(null);
    if (vaultPath === null) return;
    let stale = false;
    void readConnectors(vaultPath)
      .then((raw) => {
        if (stale) return;
        setSpecs(parseConnectors(raw));
        setFilePresent(raw.trim() !== '');
      })
      .catch((e: unknown) => {
        if (!stale) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      stale = true;
    };
  }, [vaultPath, loadSeq]);

  if (vaultPath === null) return null;

  if (loadError !== null) {
    return (
      <div className="mt-1" data-testid="connector-settings-blocked">
        <p className="m-0 text-2xs leading-[14px] text-warn-600">
          The connector list can’t be read, so agent runs are pinned to no connectors until this is
          fixed: {loadError}{' '}
          <button
            type="button"
            onClick={() => setLoadSeq((n) => n + 1)}
            className="cursor-pointer border-0 bg-transparent p-0 text-2xs underline"
          >
            Retry
          </button>
        </p>
      </div>
    );
  }

  if (specs === null) return null;

  const reload = () =>
    readConnectors(vaultPath)
      .then((raw) => {
        setSpecs(parseConnectors(raw));
        setFilePresent(raw.trim() !== '');
      })
      .catch((e: unknown) => {
        setLoadError(e instanceof Error ? e.message : String(e));
      });

  const persist = (next: ConnectorSpec[]) => {
    setSpecs(next);
    setFilePresent(true);
    void saveConnectors(vaultPath, serializeConnectors(next)).then(
      // Rust decides which names can be granted from the list on disk, so a
      // saved list is read for status again.
      () => readStatus(vaultPath),
      (e: unknown) => {
        toast(e instanceof Error ? e.message : String(e));
        // A failed save must not leave the UI describing a list the run will
        // not use — show what is actually on disk.
        void reload();
      },
    );
  };

  const copyCommand = (connector: string, command: string) => {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    const written = clipboard?.writeText(command) ?? Promise.reject(new Error('no clipboard'));
    void written.then(
      () => setCopied(connector),
      () => toast('Couldn’t copy the command — select it and copy it yourself.'),
    );
  };

  const resetToGlobal = () => {
    setSpecs([]);
    setFilePresent(false);
    void saveConnectors(vaultPath, '').catch((e) => {
      toast(e instanceof Error ? e.message : String(e));
      void reload();
    });
  };

  const add = () => {
    const trimmedName = name.trim();
    const trimmedTarget = target.trim();
    if (trimmedName === '' || trimmedTarget === '') return;
    if (specs.some((s) => s.name === trimmedName)) {
      toast(`A connector named "${trimmedName}" already exists.`);
      return;
    }
    const [command, ...args] = trimmedTarget.split(/\s+/);
    const spec: ConnectorSpec = {
      name: trimmedName,
      transport,
      url: transport === 'http' ? trimmedTarget : '',
      command: transport === 'stdio' ? command : '',
      args: transport === 'stdio' ? args : [],
      enabled: true,
      extra: {},
    };
    persist([...specs, spec]);
    // Typing the command or the URL right here IS the approval — the ledger
    // just records its digest (outside the vault) so a later hand-edit to
    // the file has to be approved again.
    const key = approvalKey(spec);
    if (key !== null) approve(vaultPath, key);
    setName('');
    setTarget('');
  };

  // A preset is added and approved the way a typed entry is (M54 Q7):
  // clicking it here is the approval of exactly what it writes.
  const addPreset = (preset: (typeof CONNECTOR_PRESETS)[number]) => {
    if (presetHolder(preset, specs) !== undefined) return;
    const spec = presetSpec(preset);
    persist([...specs, spec]);
    const key = approvalKey(spec);
    if (key !== null) approve(vaultPath, key);
  };

  return (
    <div className="mt-1 flex flex-col gap-1.5" data-testid="connector-settings">
      {specs.map((spec) => {
        // The file naming an entry travels with the vault, so the entry
        // stays out of runs until a person approves its exact spec on this
        // machine: a stdio entry names a command this app would EXECUTE, and
        // an http one a server whose tools a run is granted (M54.9). null =
        // malformed (a non-string env value or header, or an oauth or
        // timeout Claude Code would refuse, M69.1), which can never be
        // approved. The ledger holds digests, never the fingerprint itself.
        const fp = approvalKey(spec);
        const unapproved = fp === null || !(approvals[vaultPath] ?? []).includes(fp);
        // What Approve approves is the whole spec — so the env pairs, the
        // headers and the oauth must be on the table, not just the command
        // line or the URL (PR #5 security review): an env value can redirect
        // a benign-looking command, a header can change who the server thinks
        // is calling. Sorted like the fingerprint sorts them.
        const shown =
          spec.transport === 'http'
            ? [
                spec.url,
                ...sortedPairs(httpHeaders(spec) ?? {}).map(([k, v]) => `${k}: ${v}`),
                // oauth is part of the approval too (M69.1): a metadata URL
                // can send the sign-in elsewhere.
                ...sortedPairs(httpOAuth(spec) ?? {}).map(([k, v]) => `oauth ${k}: ${v}`),
              ].join(' · ')
            : [
                ...sortedPairs(stdioEnv(spec) ?? {}).map(([k, v]) => `${k}=${v}`),
                spec.command,
                ...spec.args,
              ].join(' ');
        const why =
          spec.transport === 'stdio'
            ? fp === null
              ? 'malformed env'
              : 'runs a local command'
            : httpHeaders(spec) === null
              ? 'malformed headers'
              : httpOAuth(spec) === null
                ? 'oauth Claude Code would refuse'
                : httpTimeout(spec) === null
                  ? 'timeout Claude Code would refuse'
                  : 'not approved on this machine';
        // What the row says, first rule wins: the switch; a name Rust can
        // never grant; this machine's approval; then what the last run that
        // used it saw, or that none has (M54.11).
        const seen =
          status.kind === 'ready'
            ? status.rows.find((row) => row.connector === spec.name)
            : undefined;
        const said: RowStatus = !spec.enabled
          ? { key: 'off', words: 'off' }
          : seen?.refused != null
            ? { key: 'refused', words: `can’t be granted: ${seen.refused}` }
            : unapproved
              ? { key: 'unapproved', words: why }
              : status.kind !== 'ready'
                ? { key: status.kind, words: null }
                : {
                    key: seen?.state ?? 'not_observed',
                    words: stateLabel(seen?.state ?? null),
                  };
        const observedAt = OBSERVED.includes(said.key) ? (seen?.seen_at ?? null) : null;
        const hint = HINTS[said.key];
        // A preset no run has used yet shows its sign-in too (M69.1): it
        // was added to be signed in to, and the first run would only say so.
        const preset = CONNECTOR_PRESETS.some((p) => presetHolder(p, [spec]) !== undefined);
        const signIn = said.key === 'needs_sign_in' || (said.key === 'not_observed' && preset);
        const command = signIn ? signInCommand(spec) : null;
        return (
          <div key={spec.name} className="rounded-lg border border-n-200 px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              {/* The status words can be long (a refusal says why), so they
                  wrap in their own column and never push the controls out. */}
              <div className="min-w-0 flex-1">
                <span data-testid="connector-status" data-state={said.key} className="text-xs">
                  <span className="font-medium text-n-800">{spec.name}</span>
                  {said.words !== null && (
                    <>
                      {' — '}
                      <span
                        className={
                          said.key === 'working' ||
                          said.key === 'off' ||
                          said.key === 'not_observed'
                            ? 'text-n-500'
                            : 'text-warn-600'
                        }
                      >
                        {said.words}
                      </span>
                    </>
                  )}
                </span>
                <div
                  title={shown}
                  className="truncate text-2xs text-n-500 [font-family:var(--font-mono)]"
                >
                  {shown}
                </div>
              </div>
              {unapproved && fp !== null && said.key !== 'refused' && (
                <Button variant="secondary" size="sm" onClick={() => approve(vaultPath, fp)}>
                  Approve
                </Button>
              )}
              <Switch
                ariaLabel={`Enable ${spec.name}`}
                checked={spec.enabled}
                onChange={(v) =>
                  persist(specs.map((s) => (s.name === spec.name ? { ...s, enabled: v } : s)))
                }
              />
              <IconButton
                icon="trash-2"
                label={`Remove ${spec.name}`}
                size="sm"
                onClick={() => {
                  if (fp !== null) revoke(vaultPath, fp);
                  persist(specs.filter((s) => s.name !== spec.name));
                  // Removing the entry never signs out of Claude Code (M69.1).
                  const note = removalNote(spec);
                  if (note !== null) toast(note);
                }}
              />
            </div>
            {(observedAt !== null || hint !== undefined) && (
              <p className="m-0 mt-0.5 text-2xs leading-[14px] text-n-500">
                {observedAt !== null && (
                  <span data-testid="connector-seen" title={observedAt}>
                    seen {relativeWhen(observedAt, new Date())}
                  </span>
                )}
                {observedAt !== null && hint !== undefined && ' · '}
                {hint !== undefined && <span data-testid="connector-hint">{hint}</span>}
              </p>
            )}
            {signIn && (
              <div className="mt-1.5 flex flex-col gap-1" data-testid="connector-sign-in">
                {command !== null ? (
                  <>
                    <div className="flex items-start gap-1.5">
                      {/* A plain <pre>: base.css styles every <code> as an
                          inline chip, unlayered, so utilities cannot undo it. */}
                      <pre
                        data-testid="connector-sign-in-command"
                        className="m-0 min-w-0 flex-1 rounded-md border border-n-200 bg-n-50 px-2 py-1 text-2xs leading-[16px] whitespace-pre-wrap text-n-800 [overflow-wrap:anywhere] [font-family:var(--font-mono)]"
                      >
                        {command}
                      </pre>
                      <Button
                        variant="secondary"
                        size="sm"
                        testId={`connector-signin-${spec.name}`}
                        onClick={() => copyCommand(spec.name, command)}
                      >
                        {copied === spec.name ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <p className="m-0 text-2xs leading-[14px] text-n-500">
                      Then run claude, type /mcp, and sign in to {spec.name}. The sign-in stays in
                      Claude Code; Cerebro never holds the token.
                    </p>
                  </>
                ) : (
                  <p className="m-0 text-2xs leading-[14px] text-n-500">
                    {withoutCommand(spec)} The sign-in stays in Claude Code; Cerebro never holds the
                    token.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
      {specs.length > 0 && status.kind === 'loading' && (
        <p
          className="m-0 text-2xs leading-[14px] text-n-400"
          data-testid="connector-status-loading"
        >
          Reading status…
        </p>
      )}
      {specs.length > 0 && status.kind === 'unavailable' && (
        <p className="m-0 text-2xs leading-[14px] text-warn-600" data-testid="section-unavailable">
          Connector status can’t be read, so these rows don’t say whether each connector works:{' '}
          {status.reason}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5" data-testid="connector-presets">
        <span className="text-2xs text-n-500">Add a connector:</span>
        {CONNECTOR_PRESETS.map((preset) => {
          const holder = presetHolder(preset, specs);
          // A native button in Button's own classes: Button carries no
          // title, and the title is what says why a preset is unavailable.
          return (
            <button
              key={preset.name}
              type="button"
              className="cb-btn cb-btn-sm cb-btn-secondary"
              data-testid={`connector-preset-${preset.name}`}
              title={holder === undefined ? preset.about : `Already listed as ${holder.name}`}
              disabled={holder !== undefined}
              onClick={() => addPreset(preset)}
            >
              Add {preset.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-28 flex-none">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <select
          aria-label="Connector transport"
          value={transport}
          onChange={(e) => setTransport(e.target.value as 'http' | 'stdio')}
          className="h-[28px] flex-none rounded-md border border-n-200 bg-n-0 px-1.5 text-xs text-n-800"
        >
          <option value="http">http</option>
          <option value="stdio">stdio</option>
        </select>
        <div className="min-w-0 flex-1">
          <Input
            placeholder={transport === 'http' ? 'https://…/mcp' : 'npx -y @some/mcp'}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
          />
        </div>
        <Button variant="secondary" size="sm" onClick={add}>
          Add
        </Button>
      </div>
      {specs.length === 0 && filePresent && (
        <p className="m-0 text-2xs leading-[14px] text-warn-600">
          The list exists but is empty — runs are pinned to no connectors at all.{' '}
          <button
            type="button"
            onClick={resetToGlobal}
            className="cursor-pointer border-0 bg-transparent p-0 text-2xs underline"
          >
            Use my global MCP config instead
          </button>
        </p>
      )}
      <p className="m-0 text-2xs leading-[14px] text-n-400" data-testid="connector-settings-note">
        Stored in .cerebro/connectors.json — headers and env vars are edited there, kept out of git
        checkpoints, and your credentials never leave this vault. Naming servers here pins the
        assistant to exactly this list, and a run may call the tools of a server that is on,
        approved here, and left in by its agent’s record. One the file names on its own stays out of
        runs until you approve it here — for stdio the exact command it runs, for http the exact
        URL, headers and oauth. Approval is per machine, and any edit to the entry asks again. With
        no list, a turn you watch loads your global MCP config but Cerebro grants none of its tools;
        a turn whose agent or skill names a connector loads none of it, and background jobs never
        load it. A background job reaches only the connectors its agent names.
      </p>
    </div>
  );
}
