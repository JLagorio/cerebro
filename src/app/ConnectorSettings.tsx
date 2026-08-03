import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import {
  parseConnectors,
  serializeConnectors,
  stdioApprovalKey,
  stdioEnv,
  type ConnectorSpec,
} from '@/engine/connectors';
import { readConnectors, saveConnectors } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The vault's connector list (M13.3) — `.cerebro/connectors.json` with a
 * face. Naming a server here pins the agent's runs to EXACTLY this list
 * (--strict-mcp-config with the enabled entries merged in); a vault with no
 * list keeps the legacy behavior of inheriting the user's own MCP config.
 * Credentials never enter cerebro: entries reference the user's own servers,
 * and headers/env are edited in the file itself, not here.
 */
export function ConnectorSettings() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);
  // stdio approvals live in the store — OUTSIDE the vault — so the file
  // cannot approve itself; see uiStore.stdioApprovals (PR #5 security review).
  const stdioApprovals = useUiStore((s) => s.stdioApprovals);
  const approveStdio = useUiStore((s) => s.approveStdio);
  const revokeStdio = useUiStore((s) => s.revokeStdio);
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
        <p className="m-0 text-[10.5px] leading-[14px] text-warn-600">
          The connector list can’t be read, so agent runs are pinned to no connectors until this is
          fixed: {loadError}{' '}
          <button
            type="button"
            onClick={() => setLoadSeq((n) => n + 1)}
            className="cursor-pointer border-0 bg-transparent p-0 text-[10.5px] underline"
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
    void saveConnectors(vaultPath, serializeConnectors(next)).catch((e) => {
      toast(e instanceof Error ? e.message : String(e));
      // A failed save must not leave the UI describing a list the run will
      // not use — show what is actually on disk.
      void reload();
    });
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
    // Typing the command right here IS the approval — the ledger just
    // records its digest (outside the vault) so a later hand-edit to the
    // file has to be approved again.
    const fp = stdioApprovalKey(spec);
    if (fp !== null) approveStdio(vaultPath, fp);
    setName('');
    setTarget('');
  };

  return (
    <div className="mt-1 flex flex-col gap-1.5" data-testid="connector-settings">
      {specs.map((spec) => {
        // A stdio entry names a command this app would EXECUTE, and the file
        // naming it travels with the vault — so it stays out of runs until a
        // person approves this exact command line on this machine. null =
        // malformed (non-string env), which can never be approved. The
        // ledger holds digests, never the env-bearing fingerprint itself.
        const fp = stdioApprovalKey(spec);
        const unapproved =
          spec.transport === 'stdio' &&
          (fp === null || !(stdioApprovals[vaultPath] ?? []).includes(fp));
        // What Approve approves is name+command+args+ENV — so the env pairs
        // must be on the table, not just the command line (PR #5 security
        // review): an env value can redirect a benign-looking command.
        // Rendered shell-style, sorted like the fingerprint sorts them.
        const shown =
          spec.transport === 'http'
            ? spec.url
            : [
                ...Object.entries(stdioEnv(spec) ?? {})
                  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                  .map(([k, v]) => `${k}=${v}`),
                spec.command,
                ...spec.args,
              ].join(' ');
        return (
          <div
            key={spec.name}
            className="flex items-center gap-2 rounded-[9px] border border-n-200 px-2.5 py-1.5"
          >
            <span className="text-xs font-medium text-n-800">{spec.name}</span>
            <span
              title={shown}
              className="min-w-0 flex-1 truncate text-2xs text-n-500 [font-family:var(--font-mono)]"
            >
              {shown}
            </span>
            {unapproved && (
              <>
                <span className="flex-none text-[10.5px] text-warn-600">
                  {fp === null ? 'malformed env' : 'runs a local command'}
                </span>
                {fp !== null && (
                  <Button variant="secondary" size="sm" onClick={() => approveStdio(vaultPath, fp)}>
                    Approve
                  </Button>
                )}
              </>
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
                if (fp !== null) revokeStdio(vaultPath, fp);
                persist(specs.filter((s) => s.name !== spec.name));
              }}
            />
          </div>
        );
      })}
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
        <p className="m-0 text-[10.5px] leading-[14px] text-warn-600">
          The list exists but is empty — runs are pinned to no connectors at all.{' '}
          <button
            type="button"
            onClick={resetToGlobal}
            className="cursor-pointer border-0 bg-transparent p-0 text-[10.5px] underline"
          >
            Use my global MCP config instead
          </button>
        </p>
      )}
      <p className="m-0 text-[10.5px] leading-[14px] text-n-400">
        Stored in .cerebro/connectors.json — headers and env vars are edited there, kept out of git
        checkpoints, and your credentials never leave this vault. Naming servers here pins the
        assistant to exactly this list; with no list, turns you watch inherit your global MCP config
        — background jobs never do, they only ever get this list. stdio connectors run a local
        command, so one the file names on its own stays out of runs until you approve that exact
        command here — approval is per machine and any edit to the file asks again.
      </p>
    </div>
  );
}
