/**
 * Connector config (M13.3) — the TS view of `.cerebro/connectors.json`.
 *
 * The file names the MCP servers the agent may reach from this vault. The UI
 * models the common fields; anything else a server entry carries (headers,
 * env, oauth, custom keys) rides through `extra` untouched, so hand-edited config
 * survives the Settings page. Parsing is fail-quiet — a broken file shows an
 * empty list here, and the Rust side independently fails CLOSED when merging
 * (a broken explicit list must never widen into "everything").
 */

import { sha256Hex } from '@/lib/sha256';

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

/**
 * The env block of a stdio spec, or null when malformed. Values must all be
 * strings — a non-string value makes the spec ineligible to run, mirrored in
 * the Rust merge (connectors.rs), so the fingerprint below always covers the
 * whole environment the command would receive.
 */
export function stdioEnv(spec: ConnectorSpec): Record<string, string> | null {
  const env = spec.extra.env;
  if (env === undefined) return {};
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') return null;
    out[key] = value;
  }
  return out;
}

/**
 * What a person approves when they approve a stdio connector: this exact
 * name + command + args + env, byte for byte (PR #5 security review). The
 * approval ledger lives in uiStore — OUTSIDE the vault — because
 * `.cerebro/connectors.json` travels with the vault, and an untrusted vault
 * must not get to run a command by writing its own config. Rust computes
 * the identical string when merging (connectors::stdio_fingerprint) and
 * drops entries with no match; any edit to the file invalidates the
 * approval, which is the point. Null = not a stdio spec, or one whose env
 * cannot be represented — never approvable.
 *
 * The fingerprint itself never leaves this computation: its env pairs are
 * credential material, so the LEDGER stores only its digest — see
 * stdioApprovalKey below.
 */
export function stdioFingerprint(spec: ConnectorSpec): string | null {
  if (spec.transport !== 'stdio') return null;
  const env = stdioEnv(spec);
  if (env === null) return null;
  const pairs = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([spec.name, spec.command, spec.args, pairs]);
}

/**
 * What the approval ledger actually stores: the SHA-256 of the fingerprint
 * (PR #5 security review). The fingerprint embeds env VALUES — an API key
 * a connector needs is exactly the kind of thing a spec's env carries —
 * and the ledger persists to localStorage, so storing it raw would copy
 * credentials into a second plaintext location outside the vault boundary.
 * The digest keeps the exact-match semantics (any edit to the spec still
 * invalidates the approval) while nothing recoverable resides in app
 * storage. Rust hashes its identically-computed fingerprint the same way
 * (connectors::stdio_approval_key); the twin hex literals pinned in both
 * suites keep the two from drifting apart.
 */
export function stdioApprovalKey(spec: ConnectorSpec): string | null {
  const fingerprint = stdioFingerprint(spec);
  return fingerprint === null ? null : sha256Hex(fingerprint);
}

/**
 * The headers block of an http spec, or null when malformed (M54.9). Values
 * must all be strings — a non-string value makes the spec ineligible to
 * merge, mirrored in the Rust merge (connectors.rs), so the fingerprint below
 * always covers every header the server would receive.
 */
export function httpHeaders(spec: ConnectorSpec): Record<string, string> | null {
  const headers = spec.extra.headers;
  if (headers === undefined) return {};
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') return null;
    out[key] = value;
  }
  return out;
}

/** OAuth's printable ASCII, with or without the space (RFC 6749 A.1, A.4). */
function asciiText(text: string, space: boolean, min: number, max: number): boolean {
  if (text.length < min || text.length > max) return false;
  return (space ? /^[\x20-\x7E]*$/ : /^[\x21-\x7E]*$/).test(text);
}

/** An https URL whose host Claude Code's URL check is sure to accept, as
 * connectors.rs#https_url reads one. */
function httpsUrl(text: string): boolean {
  if (!text.startsWith('https://') || !asciiText(text, false, 9, 2048)) return false;
  const rest = text.slice('https://'.length);
  const authority = rest.split(/[/?#]/, 1)[0];
  return /^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(authority);
}

/** The oauth keys Cerebro passes to Claude Code, sorted (connectors.rs#OAUTH_KEYS). */
const OAUTH_KEYS = ['authServerMetadataUrl', 'callbackPort', 'clientId', 'scopes'] as const;

export type ConnectorOAuth = Partial<Record<(typeof OAUTH_KEYS)[number], string | number>>;

/**
 * An http entry's `oauth` block as the run's mcp-config carries it (M69.1),
 * twin of connectors.rs#http_oauth: undefined when absent or empty, null when
 * Claude Code would refuse it, else its keys sorted. Only clientId, a
 * callbackPort from 1 to 65535, an https authServerMetadataUrl and ONE scopes
 * string pass; xaa, clientSecret and anything else are malformed. Both sides
 * replay src-tauri/fixtures/connector-approvals.json.
 */
export function httpOAuth(spec: ConnectorSpec): ConnectorOAuth | null | undefined {
  const oauth = spec.extra.oauth;
  if (oauth === undefined) return undefined;
  if (oauth === null || typeof oauth !== 'object' || Array.isArray(oauth)) return null;
  const given = oauth as Record<string, unknown>;
  const out: ConnectorOAuth = {};
  for (const key of OAUTH_KEYS) {
    if (!Object.hasOwn(given, key)) continue;
    const value = given[key];
    const ok =
      key === 'callbackPort'
        ? typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
        : typeof value === 'string' &&
          (key === 'clientId'
            ? asciiText(value, true, 1, 256)
            : key === 'scopes'
              ? asciiText(value, true, 1, 1024)
              : httpsUrl(value));
    if (!ok) return null;
    out[key] = value as string | number;
  }
  if (Object.keys(given).length !== Object.keys(out).length) return null;
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * An http entry's `timeout` in milliseconds (M69.1), twin of
 * connectors.rs#http_timeout: undefined when absent, null unless a whole
 * number from 1000 to 600000.
 */
export function httpTimeout(spec: ConnectorSpec): number | null | undefined {
  const timeout = spec.extra.timeout;
  if (timeout === undefined) return undefined;
  return typeof timeout === 'number' &&
    Number.isInteger(timeout) &&
    timeout >= 1000 &&
    timeout <= 600000
    ? timeout
    : null;
}

/**
 * What a person approves when they approve an http connector (M54.9): this
 * exact name + URL + headers and, when present, oauth (M69.1). A run is
 * granted an http connector's tools by name, and `.cerebro/connectors.json`
 * travels with the vault, so an untrusted vault must not get to point a run
 * at a server of its choosing by writing its own config. Rust computes the
 * identical string when merging (connectors::http_oauth_fingerprint) and
 * drops entries with no match; any edit invalidates the approval. The
 * transport sits in it, so no stdio fingerprint can equal an http one. With
 * no oauth it is M54.9's four elements byte for byte; with oauth a fifth
 * holds its pairs sorted by key, since a metadata URL can send the sign-in
 * elsewhere. timeout stays out: it bounds a call and cannot redirect one.
 * Null = not an http spec, or one whose headers, oauth or timeout cannot be
 * carried — never approvable. Never stored: see httpApprovalKey.
 */
export function httpFingerprint(spec: ConnectorSpec): string | null {
  if (spec.transport !== 'http') return null;
  const headers = httpHeaders(spec);
  const oauth = httpOAuth(spec);
  if (headers === null || oauth === null || httpTimeout(spec) === null) return null;
  const pairs = sortedEntries(headers);
  return JSON.stringify(
    oauth === undefined
      ? [spec.name, 'http', spec.url, pairs]
      : [spec.name, 'http', spec.url, pairs, sortedEntries(oauth)],
  );
}

function sortedEntries<V>(record: Record<string, V>): [string, V][] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The ledger's key for an http connector (M54.9): the SHA-256 of its
 * fingerprint. A header value is often a credential, so like an env value it
 * never resides in app storage. Rust hashes its fingerprint the same way
 * (connectors::http_approval_key); the twin hex literals pinned in both
 * suites keep the two from drifting apart.
 */
export function httpApprovalKey(spec: ConnectorSpec): string | null {
  const fingerprint = httpFingerprint(spec);
  return fingerprint === null ? null : sha256Hex(fingerprint);
}

/** The approval key for either transport (M54.9), null when not approvable. */
export function approvalKey(spec: ConnectorSpec): string | null {
  return spec.transport === 'stdio' ? stdioApprovalKey(spec) : httpApprovalKey(spec);
}

/**
 * Heals a ledger persisted before approvals were digests: any entry that is
 * not a SHA-256 hex string is a raw stdio fingerprint from an earlier build —
 * hash it in place, so the approval survives and the plaintext does not.
 * (Hashing a non-fingerprint stray is harmless: the key matches nothing.)
 */
export function scrubStdioApprovals(map: Record<string, string[]>): {
  map: Record<string, string[]>;
  changed: boolean;
} {
  let changed = false;
  const out: Record<string, string[]> = {};
  for (const [vault, list] of Object.entries(map)) {
    out[vault] = list.map((entry) => {
      if (/^[0-9a-f]{64}$/.test(entry)) return entry;
      changed = true;
      return sha256Hex(entry);
    });
  }
  return { map: out, changed };
}

/**
 * What the newest run that used a connector concluded about it (M54.11).
 * Null is "not observed yet", which is not a state: a connector no run has
 * used says nothing about whether it works.
 */
export type ConnectorState = 'working' | 'needs_sign_in' | 'failed' | 'not_approved';

/**
 * One row of `connector_status` (M54.11), snake_case as Rust sends it, like
 * the fleet's rows: an entry of the vault's connector list, why its name can
 * never be granted (`refused`, in Rust's own words; the browser mock has no
 * such check, so only a seeded row carries one), and the newest observation
 * any run recorded for it, whose four fields are all null when none has.
 */
export interface ConnectorStatusRow {
  connector: string;
  cli_name: string;
  refused: string | null;
  state: ConnectorState | null;
  signal: string | null;
  seen_at: string | null;
  run_id: string | null;
}

/** A connector's status as Settings says it. */
export function stateLabel(state: ConnectorState | null): string {
  switch (state) {
    case 'working':
      return 'working';
    case 'needs_sign_in':
      return 'needs sign-in';
    case 'failed':
      return 'failed';
    case 'not_approved':
      return 'not approved';
    case null:
      return 'not observed yet';
  }
}

/** A word as a POSIX shell reads it: bare when no shell treats any of its
 * characters specially, else single-quoted, each ' closed, escaped and
 * reopened. A leading = stays quoted, since zsh expands `=word`. Printable
 * ASCII only (signInBlocker): quotes keep a word whole for the shell, but a
 * pasted control character acts on the terminal before any shell reads it. */
function shellWord(word: string): string {
  if (/^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** U+0020 to U+007E, all a sign-in command may carry; httpOAuth admits no
 * other in an oauth value. */
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;

/** Why Settings shows no sign-in command for an entry (M54.11). */
export type SignInBlocker = 'stdio' | 'name' | 'entry';

/**
 * What keeps an entry from a sign-in command, or null when nothing does. A
 * stdio entry has nothing to add. `claude mcp add` refuses a name outside
 * letters, digits, - and _ (recorded on 2.1.250). And the entry's URL and
 * every header key and value must be printable ASCII strings, since the
 * person pastes the command into a terminal and the vault's file is not
 * theirs to trust: quotes protect the shell parser, not the tty or the line
 * editor, so a pasted ETX can abort the line and a CR run what follows it,
 * and a bidi or format character makes the command read as something other
 * than what it runs.
 */
export function signInBlocker(spec: ConnectorSpec): SignInBlocker | null {
  if (spec.transport !== 'http') return 'stdio';
  if (!/^[A-Za-z0-9_-]+$/.test(spec.name)) return 'name';
  const headers = httpHeaders(spec);
  // An oauth Claude Code would refuse never reaches a run, so there is
  // nothing to sign in to; a valid one is printable ASCII by httpOAuth.
  if (headers === null || httpOAuth(spec) === null) return 'entry';
  const words = [spec.url, ...Object.entries(headers).flat()];
  return words.every((word) => PRINTABLE_ASCII.test(word)) ? null : 'entry';
}

/**
 * The command that adds an http connector to the person's own Claude Code,
 * so `/mcp` there can sign in to it (M54.11). With no oauth block it is
 * `claude mcp add --transport http <name> <url>`, then `--header 'K: V'` for
 * each header. With one (M69.1) it is `claude mcp add-json <name> '<json>'`,
 * the JSON holding type, url, headers when there are any, and oauth, since
 * `claude mcp add` has no scopes flag and Linear's sign-in needs them; each '
 * inside is closed, escaped and reopened. Built from the vault's entry
 * exactly: read from 2.1.250, Claude Code files a sign-in under the server's
 * name and a hash of its type, URL and headers, in their order, and a run
 * finds it only when its own config hashes the same. So the headers go in
 * sorted by name, the order the run's config holds them (connectors.rs).
 * Header values are written out as they are: whoever copies the command sees
 * them.
 *
 * Null whenever signInBlocker names a blocker. A name that starts with -
 * follows a `--`, with the headers before it, or the CLI reads the name as
 * an option.
 */
export function signInCommand(spec: ConnectorSpec): string | null {
  const headers = httpHeaders(spec);
  const oauth = httpOAuth(spec);
  if (headers === null || oauth === null || signInBlocker(spec) !== null) return null;
  const sorted = sortedEntries(headers);
  const dashed = spec.name.startsWith('-');
  if (oauth !== undefined) {
    const json = JSON.stringify({
      type: 'http',
      url: spec.url,
      ...(sorted.length > 0 ? { headers: Object.fromEntries(sorted) } : {}),
      oauth,
    });
    const target = [shellWord(spec.name), shellWord(json)];
    return ['claude', 'mcp', 'add-json', ...(dashed ? ['--', ...target] : target)].join(' ');
  }
  const headerWords = sorted.flatMap(([key, value]) => ['--header', shellWord(`${key}: ${value}`)]);
  const target = [shellWord(spec.name), shellWord(spec.url)];
  const words = dashed ? [...headerWords, '--', ...target] : [...target, ...headerWords];
  return ['claude', 'mcp', 'add', '--transport', 'http', ...words].join(' ');
}

/** A server a person can add with one click (M69.1). */
export interface ConnectorPreset {
  /** The name Claude Code signs in under; the vault entry's key. */
  readonly name: string;
  readonly label: string;
  readonly url: string;
  readonly oauth?: Readonly<ConnectorOAuth>;
  /** One line on what the server reaches, the button's title. */
  readonly about: string;
}

/**
 * The servers Settings offers to add (M69.1). Only servers that register
 * their OAuth client dynamically qualify: Claude Code signs in to them with
 * nothing but the URL, so Cerebro never holds a client id or a secret.
 * GitHub's and Slack's need a token or a pre-registered app, so they have no
 * preset. Each name is the one Claude Code files the sign-in under, so a
 * preset added here and signed in with signInCommand meet. Another server
 * joins as a row once a live sign-in proves it.
 */
export const CONNECTOR_PRESETS: readonly ConnectorPreset[] = Object.freeze([
  // Linear's MCP server registers clients dynamically and needs its scopes
  // asked for explicitly (Macro's provider registry, read 2026-10-13).
  Object.freeze({
    name: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    oauth: Object.freeze({ scopes: 'read write' }),
    about: 'Issues and projects',
  }),
  // Notion's MCP server registers clients dynamically with no scopes asked
  // for (Macro's provider registry, read 2026-10-13).
  Object.freeze({
    name: 'notion',
    label: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    about: 'Pages and databases',
  }),
]);

/** The enabled http entry a preset adds, carrying its oauth when it has one. */
export function presetSpec(preset: ConnectorPreset): ConnectorSpec {
  return {
    name: preset.name,
    transport: 'http',
    url: preset.url,
    command: '',
    args: [],
    enabled: true,
    extra: preset.oauth === undefined ? {} : { oauth: { ...preset.oauth } },
  };
}

/** A URL as presetHolder compares it: scheme and host lowercased, one
 * trailing / dropped. */
function sameServerUrl(url: string): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*)(.*)$/.exec(url.trim());
  const spelled = match === null ? url.trim() : match[1].toLowerCase() + match[2];
  return spelled.endsWith('/') ? spelled.slice(0, -1) : spelled;
}

/**
 * The listed entry that already holds a preset, if any: the one under its
 * name, else an http one at its URL, compared ignoring one trailing / and
 * the host's case.
 */
export function presetHolder(
  preset: ConnectorPreset,
  specs: readonly ConnectorSpec[],
): ConnectorSpec | undefined {
  const url = sameServerUrl(preset.url);
  return (
    specs.find((spec) => spec.name === preset.name) ??
    specs.find((spec) => spec.transport === 'http' && sameServerUrl(spec.url) === url)
  );
}

/**
 * What Settings says when an http entry is removed (M69.1): the sign-in
 * Claude Code stored stays there, and Cerebro never held it. Null for stdio,
 * which signs in to nothing.
 */
export function removalNote(spec: ConnectorSpec): string | null {
  if (spec.transport !== 'http') return null;
  const name = spec.name;
  return `Removed ${name}. Claude Code keeps the sign-in it stored for ${name} in your keychain; Cerebro never held it. To sign out, run claude, type /mcp, pick ${name} and clear its authentication.`;
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
