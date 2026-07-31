/**
 * Connector config (M13.3) — the TS view of `.cerebro/connectors.json`.
 *
 * The file names the MCP servers the agent may reach from this vault. The UI
 * models the common fields; anything else a server entry carries (headers,
 * env, custom keys) rides through `extra` untouched, so hand-edited config
 * survives the Settings page. Parsing is fail-quiet — a broken file shows an
 * empty list here, and the Rust side independently fails CLOSED when merging
 * (a broken explicit list must never widen into "everything").
 */

export interface ConnectorSpec {
  name: string;
  transport: 'http' | 'stdio';
  /** http: the server URL. */
  url: string;
  /** stdio: the launch command. */
  command: string;
  /** stdio: arguments, space-joined in the UI. */
  args: string[];
  enabled: boolean;
  /** Unmodeled keys (headers, env, …), preserved verbatim on round-trip. */
  extra: Record<string, unknown>;
}

const MODELED = new Set(['transport', 'url', 'command', 'args', 'enabled']);

export function parseConnectors(raw: string): ConnectorSpec[] {
  if (raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const servers = (parsed as { servers?: unknown }).servers;
  if (servers === null || typeof servers !== 'object') return [];
  const out: ConnectorSpec[] = [];
  for (const [name, spec] of Object.entries(servers as Record<string, unknown>)) {
    if (spec === null || typeof spec !== 'object') continue;
    const s = spec as Record<string, unknown>;
    const transport = s.transport === 'stdio' ? 'stdio' : 'http';
    out.push({
      name,
      transport,
      url: typeof s.url === 'string' ? s.url : '',
      command: typeof s.command === 'string' ? s.command : '',
      args: Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : [],
      enabled: s.enabled === true,
      extra: Object.fromEntries(Object.entries(s).filter(([k]) => !MODELED.has(k))),
    });
  }
  return out;
}

export function serializeConnectors(specs: ConnectorSpec[]): string {
  const servers: Record<string, unknown> = {};
  for (const spec of specs) {
    const entry: Record<string, unknown> = { transport: spec.transport };
    if (spec.transport === 'http') entry.url = spec.url;
    else {
      entry.command = spec.command;
      if (spec.args.length > 0) entry.args = spec.args;
    }
    Object.assign(entry, spec.extra);
    entry.enabled = spec.enabled;
    servers[spec.name] = entry;
  }
  return `${JSON.stringify({ servers }, null, 2)}\n`;
}
