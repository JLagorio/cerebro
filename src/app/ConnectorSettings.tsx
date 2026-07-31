import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import { parseConnectors, serializeConnectors, type ConnectorSpec } from '@/engine/connectors';
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
  const [specs, setSpecs] = useState<ConnectorSpec[] | null>(null);
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const [target, setTarget] = useState('');

  useEffect(() => {
    if (vaultPath === null) return;
    let stale = false;
    void readConnectors(vaultPath)
      .then((raw) => {
        if (!stale) setSpecs(parseConnectors(raw));
      })
      .catch(() => {
        if (!stale) setSpecs([]);
      });
    return () => {
      stale = true;
    };
  }, [vaultPath]);

  if (vaultPath === null || specs === null) return null;

  const persist = (next: ConnectorSpec[]) => {
    setSpecs(next);
    void saveConnectors(vaultPath, serializeConnectors(next)).catch((e) =>
      toast(e instanceof Error ? e.message : String(e)),
    );
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
    persist([
      ...specs,
      {
        name: trimmedName,
        transport,
        url: transport === 'http' ? trimmedTarget : '',
        command: transport === 'stdio' ? command : '',
        args: transport === 'stdio' ? args : [],
        enabled: true,
        extra: {},
      },
    ]);
    setName('');
    setTarget('');
  };

  return (
    <div className="mt-1 flex flex-col gap-1.5" data-testid="connector-settings">
      {specs.map((spec) => (
        <div
          key={spec.name}
          className="flex items-center gap-2 rounded-[9px] border border-[var(--n-200)] px-2.5 py-1.5"
        >
          <span className="text-[12px] font-medium text-[var(--n-800)]">{spec.name}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--n-500)] [font-family:var(--font-mono)]">
            {spec.transport === 'http' ? spec.url : [spec.command, ...spec.args].join(' ')}
          </span>
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
            onClick={() => persist(specs.filter((s) => s.name !== spec.name))}
          />
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <div className="w-28 flex-none">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <select
          aria-label="Connector transport"
          value={transport}
          onChange={(e) => setTransport(e.target.value as 'http' | 'stdio')}
          className="h-[28px] flex-none rounded-[8px] border border-[var(--n-200)] bg-[var(--n-0)] px-1.5 text-[12px] text-[var(--n-800)]"
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
      <p className="m-0 text-[10.5px] leading-[14px] text-[var(--n-400)]">
        Stored in .cerebro/connectors.json — headers and env vars are edited there, and your
        credentials never leave this vault. Naming servers here pins the assistant to exactly this
        list.
      </p>
    </div>
  );
}
