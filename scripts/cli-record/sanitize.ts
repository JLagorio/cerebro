// The sanitizer (M56.2): one real Claude Code run in, one recording out, in
// src-tauri/fixtures/cli-stream/real/. Unlike the reducer it keeps the CLI's
// whole framing, every line and field as written, so a sweep can hold Cerebro
// to what the CLI really sends. That makes it the stricter of the two:
//
//   pnpm tsx scripts/cli-record/sanitize.ts --stream <raw.stream.jsonl>
//     [--session <file>] --name <name> --source spike|scripted|app
//     --proves <one sentence> [--transport per-turn|stream-json-input]
//     [--ends result|killed|deferred|refused] [--scenario <words>] [--dir <record folder>]
//     [--allow-server <exact CLI name>] (repeat once per reviewed connector)
//   pnpm tsx scripts/cli-record/sanitize.ts corpus <name|all>
//   pnpm tsx scripts/cli-record/sanitize.ts --line <session.jsonl> --at <n>
//     --name <name> [--dir <record folder>]
//
// `--line` (M56.4) takes one API-error line from a session file, such as a
// usage-limit line from the owner's own history, read-only, and writes
// src-tauri/fixtures/cli-stream/jsonl/<name>.json by `sanitizeHistoryLine`:
// an allowlist of the fields the failure classifier reads, a synthetic uuid,
// the reset pinned to HISTORY_RESET, and the same post-scan.
//
// Without --session it finds <dir>/claude-config/projects/*/<id>.jsonl from
// the stream's init. `corpus` sanitizes the spike's own raw runs by the
// CORPUS table. In order, `sanitizeRecording`:
//
// 1. parses every line, and refuses a line that does not parse, by number;
// 2. allowlists system/init: INIT_KEEP stays, INIT_DROP goes (each with its
//    reason), and any other key refuses, by name. So do a server or an
//    mcp__<server>__ tool other than the toys or an explicitly allowed server,
//    another CLI version, and any API-key source but none. The owner's own
//    listings drop from the control protocol's answers and the session file;
// 3. replaces secrets (scan.ts's SECRETS) with redacted-<kind>-<n>, ids
//    through one IdMap across stream, session and the session file's name,
//    thinking signatures with sig-<n>, and this machine's strings with the
//    reducer's placeholders;
// 4. shifts every timestamp so the first is 2026-01-01T00:00:00.000Z, gaps
//    kept;
// 5. writes one line per event, DEL escaped as \u007f (CV-13).
//
// `writeRecording` then scans what it would write with scan.ts plus this
// machine's user, host and git email, and writes nothing on a hit. The report
// counts; it never prints a value. Raw runs stay in the record folder.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyPlaceholders,
  CLI_VERSION,
  formatJson,
  IdMap,
  placeholders,
  TOY_SERVERS,
  type Machine,
} from './reduce';
import { FORBIDDEN, SECRETS } from './scan';
import { findSessionFile, layout, machine, recordRoot } from './spike';

type JsonObject = Record<string, unknown>;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const REAL = join(REPO, 'src-tauri/fixtures/cli-stream/real');

/** The meta file's format, and this sanitizer's version, both in every meta. */
export const META_FORMAT = 1;
export const SANITIZER_VERSION = 2;
/** One recording file may hold this much, and real/ this much in all. */
export const FILE_CAP = 256 * 1024;
export const FOLDER_CAP = 2 * 1024 * 1024;
/** Where shifted time begins. */
export const EPOCH = '2026-01-01T00:00:00.000Z';

/** The system/init keys a recording keeps. */
export const INIT_KEEP = [
  'type',
  'subtype',
  'session_id',
  'uuid',
  'cwd',
  'model',
  'permissionMode',
  'claude_code_version',
  'apiKeySource',
  'output_style',
  'tools',
  'mcp_servers',
  'capabilities',
  'fast_mode_state',
  'fast_mode_disabled_reason',
  'analytics_disabled',
  'product_feedback_disabled',
] as const;

/** The system/init keys a recording drops, each with why. */
export const INIT_DROP: Readonly<Record<string, string>> = {
  slash_commands: "the owner's own commands and skills, which say who they are",
  terminal_slash_commands: "the owner's own terminal commands",
  agents: "the owner's own subagents",
  skills: "the owner's own skills",
  plugins: "the owner's own plugins",
  memory_paths: 'a path into the config folder, which no test reads',
  messaging_socket_path: "a socket named for the CLI's process id",
};

/** What the control protocol's answers (stream-json) drop, each with why. */
export const ANSWER_DROP: Readonly<Record<string, string>> = {
  account: "the owner's account, email included",
  commands: "the owner's own commands and skills",
  agents: "the owner's own subagents",
};

/** Session-file attachments whose payload is the owner's own setup. */
export const LISTING_ATTACHMENTS: Readonly<Record<string, string>> = {
  skill_listing: "the owner's own skills, described",
  agent_listing_delta: "the owner's own subagents, described",
};

export type Source = 'spike' | 'scripted' | 'app';
export type Transport = 'per-turn' | 'stream-json-input';
export type Ends = 'result' | 'killed' | 'deferred' | 'refused';

const SOURCES: readonly Source[] = ['spike', 'scripted', 'app'];
const TRANSPORTS: readonly Transport[] = ['per-turn', 'stream-json-input'];
const ENDINGS: readonly Ends[] = ['result', 'killed', 'deferred', 'refused'];

export interface RecordingInput {
  stream: string;
  /** The run's session file, by its own name, when it wrote one. */
  session?: { name: string; text: string } | null;
}

export interface SanitizeContext {
  name: string;
  source: Source;
  proves: string;
  scenario?: string;
  transport?: Transport;
  /** Defaults to result for a run that reached one; a run that did not must say. */
  ends?: Ends;
  /** For a recording written from the CLI's own code, owed a live run. */
  derivedFrom?: string[];
  machine: Machine;
  /** Exact CLI server names explicitly reviewed for this one recording. */
  allowServers?: string[];
}

export interface Meta {
  format: number;
  cli_version: string;
  source: Source;
  recorded: 'live' | 'derived';
  derived_from?: string[];
  transport: Transport;
  scenario: string;
  proves: string;
  ends: Ends;
  session: string | null;
  sanitizer: number;
  allowed_servers?: string[];
}

export interface Sanitized {
  name: string;
  stream: string;
  session: string | null;
  meta: Meta;
  /** Counts by kind, never a value. */
  report: string[];
}

/** Why a recording may not enter the repo. Its message names keys and line numbers, never values. */
export class Refusal extends Error {}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every non-empty line of `text`, parsed; a line that does not parse refuses. */
export function parseLines(text: string, label: string): unknown[] {
  const out: unknown[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      throw new Refusal(`${label} line ${index + 1} is not JSON.`);
    }
  }
  return out;
}

/** The server an mcp__<server>__<tool> name belongs to, or null. */
function serverOf(tool: unknown): string | null {
  return typeof tool === 'string' ? (/^mcp__(.+?)__/.exec(tool)?.[1] ?? null) : null;
}

/** One init, kept to INIT_KEEP, or a refusal naming what it may not carry. */
export function allowInit(
  init: JsonObject,
  at: number,
  allowServers: readonly string[] = [],
): JsonObject {
  for (const key of Object.keys(init)) {
    if (!(INIT_KEEP as readonly string[]).includes(key) && !(key in INIT_DROP)) {
      throw new Refusal(
        `The init on stream line ${at} carries "${key}", which the sanitizer neither keeps nor drops; add it to INIT_KEEP or INIT_DROP with its reason.`,
      );
    }
  }
  if (init.claude_code_version !== CLI_VERSION) {
    throw new Refusal(`The init on stream line ${at} is not Claude Code ${CLI_VERSION}.`);
  }
  if (init.apiKeySource !== 'none') {
    throw new Refusal(
      `The init on stream line ${at} names an API-key source; recordings use the owner's login only.`,
    );
  }
  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  const names = servers.map((server) => (isObject(server) ? server.name : undefined));
  const tools = Array.isArray(init.tools) ? init.tools : [];
  const foreign = [...names, ...tools.map(serverOf).filter((name) => name !== null)].filter(
    (name) =>
      typeof name !== 'string' || (!TOY_SERVERS.includes(name) && !allowServers.includes(name)),
  );
  if (foreign.length > 0) {
    throw new Refusal(
      `The init on stream line ${at} lists ${foreign.length} server(s) or tool(s) from servers other than ${[...TOY_SERVERS, ...allowServers].join(' and ')}; re-record with them off.`,
    );
  }
  // The CLI's own key order, less what drops.
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(init)) {
    if (key in INIT_DROP) continue;
    out[key] =
      key === 'mcp_servers'
        ? servers.map((server) => ({
            name: (server as JsonObject).name,
            status: (server as JsonObject).status,
          }))
        : value;
  }
  return out;
}

function dropKeys(value: JsonObject, drop: Readonly<Record<string, string>>): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !(key in drop)));
}

/** A stream line with the structural rules applied: init allowlisted, the owner's listings out. */
function structureStream(line: unknown, at: number, allowServers: readonly string[]): unknown {
  if (!isObject(line)) return line;
  if (line.type === 'system' && line.subtype === 'init') return allowInit(line, at, allowServers);
  if (line.type === 'control_response' && isObject(line.response)) {
    const answer = line.response.response;
    if (isObject(answer)) {
      return { ...line, response: { ...line.response, response: dropKeys(answer, ANSWER_DROP) } };
    }
  }
  return line;
}

/** A session-file line with the owner's own listings reduced to their type. */
function structureSession(line: unknown): unknown {
  if (!isObject(line) || !isObject(line.attachment)) return line;
  const kind = line.attachment.type;
  if (typeof kind === 'string' && kind in LISTING_ATTACHMENTS) {
    return { ...line, attachment: { type: kind } };
  }
  return line;
}

/** Counts of what the string scrub replaced, by kind. */
type Counts = Map<string, number>;

function bump(counts: Counts, key: string): number {
  const next = (counts.get(key) ?? 0) + 1;
  counts.set(key, next);
  return next;
}

/** Every secret in `text`, replaced with redacted-<kind>-<n>, the same secret the same way. */
export function redactSecrets(
  text: string,
  seen: Map<string, string>,
  counts: Counts = new Map(),
): string {
  return SECRETS.reduce(
    (out, { kind, pattern }) =>
      out.replace(pattern, (match) => {
        const known = seen.get(match);
        if (known) return known;
        const stand = `redacted-${kind}-${bump(counts, `secret:${kind}`)}`;
        seen.set(match, stand);
        return stand;
      }),
    text,
  );
}

/** Every string in `value`, keys included, through `scrub`. */
function scrubDeep(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [scrub(key), scrubDeep(inner, scrub)]),
    );
  }
  return value;
}

/** Thinking signatures and redacted-thinking data as sig-<n>, one stand-in per value. */
function replaceSignatures(value: unknown, seen: Map<string, string>): unknown {
  const stand = (raw: string) => {
    const known = seen.get(raw);
    if (known) return known;
    const made = `sig-${seen.size + 1}`;
    seen.set(raw, made);
    return made;
  };
  if (Array.isArray(value)) return value.map((item) => replaceSignatures(item, seen));
  if (!isObject(value)) return value;
  const redacted = value.type === 'redacted_thinking';
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      if (typeof inner === 'string' && (key === 'signature' || (redacted && key === 'data'))) {
        return [key, stand(inner)];
      }
      return [key, replaceSignatures(inner, seen)];
    }),
  );
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function timestamps(value: unknown, into: number[]): void {
  if (typeof value === 'string') {
    if (ISO.test(value)) into.push(Date.parse(value));
  } else if (Array.isArray(value)) {
    for (const item of value) timestamps(item, into);
  } else if (isObject(value)) {
    for (const inner of Object.values(value)) timestamps(inner, into);
  }
}

function shiftTimes(value: unknown, by: number): unknown {
  if (typeof value === 'string') {
    return ISO.test(value) ? new Date(Date.parse(value) + by).toISOString() : value;
  }
  if (Array.isArray(value)) return value.map((item) => shiftTimes(item, by));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, shiftTimes(inner, by)]),
    );
  }
  return value;
}

/** One line per event, DEL written as an escape (CV-13). */
export function jsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line).replace(/\x7f/g, '\\u007f')).join('\n') + '\n';
}

/** A line's label for the report: its type, subtype and stream event. */
function label(line: unknown): string {
  if (!isObject(line)) return '-';
  const parts = [typeof line.type === 'string' ? line.type : '-'];
  if (typeof line.subtype === 'string') parts.push(line.subtype);
  if (isObject(line.event) && typeof line.event.type === 'string') parts.push(line.event.type);
  if (isObject(line.attachment) && typeof line.attachment.type === 'string') {
    parts.push(line.attachment.type);
  }
  return parts.join('/');
}

function tally(lines: unknown[]): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) bump(counts, label(line));
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `  ${k}: ${n}`);
}

const SYNTHETIC =
  /00000000-0000-4000-8000-[0-9a-f]{12}|\b(?:msg|toolu|srvtoolu|req)_0{8,}[0-9a-f]*/g;

/** One raw run, sanitized. Throws a Refusal rather than let anything through. */
export function sanitizeRecording(input: RecordingInput, context: SanitizeContext): Sanitized {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(context.name)) {
    throw new Refusal('A recording name is lowercase words joined by hyphens.');
  }
  if (!SOURCES.includes(context.source)) throw new Refusal('The source is spike, scripted or app.');
  if (context.proves.trim() === '') throw new Refusal('Say, in one sentence, what it proves.');
  const allowServers = [...new Set(context.allowServers ?? [])];
  if (allowServers.some((name) => !/^[A-Za-z0-9_-]{1,64}$/.test(name) || name.includes('__'))) {
    throw new Refusal('Each --allow-server names one exact CLI server, without a tool suffix.');
  }
  // 1. Parse, and 2. the structural rules.
  const rawStream = parseLines(input.stream, 'stream');
  const rawSession = input.session ? parseLines(input.session.text, 'session') : null;
  if (rawStream.length === 0) throw new Refusal('The stream is empty.');
  const inits = rawStream.filter(
    (line) => isObject(line) && line.type === 'system' && line.subtype === 'init',
  );
  if (inits.length === 0)
    throw new Refusal('The stream has no init, so nothing says which CLI wrote it.');
  let stream = rawStream.map((line, index) => structureStream(line, index + 1, allowServers));
  let session = rawSession?.map(structureSession) ?? null;
  const hasResult = rawStream.some((line) => isObject(line) && line.type === 'result');
  const ends = context.ends ?? (hasResult ? 'result' : undefined);
  if (ends === undefined) {
    throw new Refusal('The run never reached a result, so name how it ended with --ends.');
  }
  if (!ENDINGS.includes(ends)) throw new Refusal('It ends as result, killed, deferred or refused.');
  if (ends === 'result' && !hasResult)
    throw new Refusal('It says it ended in a result, and has none.');
  const transport = context.transport ?? 'per-turn';
  if (!TRANSPORTS.includes(transport)) {
    throw new Refusal('The transport is per-turn or stream-json-input.');
  }

  // 3. Secrets, ids, signatures and this machine's strings.
  const counts: Counts = new Map();
  const secrets = new Map<string, string>();
  const signatures = new Map<string, string>();
  const ids = new IdMap();
  const pairs = placeholders(context.machine);
  const scrub = (text: string) =>
    applyPlaceholders(ids.replaceIn(redactSecrets(text, secrets, counts)), pairs);
  stream = stream.map((line) => scrubDeep(replaceSignatures(line, signatures), scrub));
  session = session?.map((line) => scrubDeep(replaceSignatures(line, signatures), scrub)) ?? null;
  const sessionName = input.session ? scrub(input.session.name) : null;

  // 4. Time starts at EPOCH.
  const times: number[] = [];
  timestamps(stream, times);
  if (session) timestamps(session, times);
  if (times.length > 0) {
    const by = Date.parse(EPOCH) - Math.min(...times);
    stream = stream.map((line) => shiftTimes(line, by));
    session = session?.map((line) => shiftTimes(line, by)) ?? null;
  }

  // 5. One line per event.
  const streamText = jsonl(stream);
  const sessionText = session ? jsonl(session) : null;
  const meta: Meta = {
    format: META_FORMAT,
    cli_version: CLI_VERSION,
    source: context.source,
    recorded: context.derivedFrom ? 'derived' : 'live',
    ...(context.derivedFrom ? { derived_from: context.derivedFrom } : {}),
    transport,
    scenario: context.scenario ?? context.name,
    proves: context.proves,
    ends,
    session: sessionName,
    sanitizer: SANITIZER_VERSION,
    ...(allowServers.length > 0 ? { allowed_servers: allowServers } : {}),
  };
  const synthetic = new Set(
    [streamText, sessionText ?? ''].flatMap((text) =>
      [...text.matchAll(SYNTHETIC)].map((m) => m[0]),
    ),
  );
  const secretCounts = SECRETS.map(({ kind }) => [kind, counts.get(`secret:${kind}`) ?? 0] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `  ${kind}: ${n}`);
  const report = [
    `${context.name}: ${stream.length} stream line(s)`,
    ...tally(stream),
    `session: ${session ? `${session.length} line(s)` : 'none'}`,
    ...(session ? tally(session) : []),
    `ids made synthetic: ${synthetic.size}`,
    `signatures replaced: ${signatures.size}`,
    `secrets redacted: ${secrets.size}`,
    ...secretCounts,
    `timestamps shifted: ${times.length}`,
  ];
  return { name: context.name, stream: streamText, session: sessionText, meta, report };
}

/** Every leak in `text`: scan.ts's patterns plus this machine's own strings, as counts by what. */
export function leaks(text: string, machine: Machine): string[] {
  const found = FORBIDDEN.map(({ what, find }) => [what, find(text).length] as const);
  const own: [string, string | undefined][] = [
    ["this machine's user", machine.user],
    ["this machine's host", machine.host],
    ["this machine's host", machine.host.split('.')[0]],
    ["this machine's git email", machine.gitEmail],
  ];
  const lower = text.toLowerCase();
  for (const [what, value] of own) {
    if (value && value.length >= 3) {
      found.push([what, lower.split(value.toLowerCase()).length - 1]);
    }
  }
  return found.filter(([, n]) => n > 0).map(([what, n]) => `${what} (${n})`);
}

/**
 * Write a sanitized recording into `out` (real/ by default): its stream, its
 * session file when there is one, and its meta, formatted by prettier. Nothing
 * is written when any of the three leaks or is over the cap.
 */
export async function writeRecording(
  recording: Sanitized,
  machine: Machine,
  out: string = REAL,
): Promise<string[]> {
  const meta = await formatJson(recording.meta);
  const files: [string, string | null][] = [
    [`${recording.name}.stream.jsonl`, recording.stream],
    [`${recording.name}.session.jsonl`, recording.session],
    [`${recording.name}.meta.json`, meta],
  ];
  const problems: string[] = [];
  for (const [file, text] of files) {
    if (text === null) continue;
    for (const leak of leaks(text, machine)) problems.push(`${file}: ${leak}`);
    if (Buffer.byteLength(text) > FILE_CAP) problems.push(`${file}: over ${FILE_CAP} bytes`);
  }
  if (problems.length > 0) {
    throw new Refusal(`Refusing to write ${recording.name}: ${problems.join('; ')}.`);
  }
  mkdirSync(out, { recursive: true });
  const written: string[] = [];
  for (const [file, text] of files) {
    const path = join(out, file);
    if (text === null) {
      rmSync(path, { force: true });
      continue;
    }
    writeFileSync(path, text);
    written.push(path);
  }
  return written;
}

// ---------------------------------------------------------------------------
// One session-history line (M56.4).
// ---------------------------------------------------------------------------

export const HISTORY = join(REPO, 'src-tauri/fixtures/cli-stream/jsonl');

/** Where a history line's reset is pinned: 2026-01-01T00:00:00Z, a Thursday. */
export const HISTORY_RESET = 1767225600;
/** The text's reset clause, rewritten to that instant as the CLI words it. */
export const HISTORY_RESET_WORDS = 'Thu, Jan 1, 12am (UTC)';

/** The top-level keys a history line keeps. Everything else drops: cwd,
 * gitBranch, sessionId, requestId, parentUuid, timestamp, userType,
 * perTurnEffort, upgradePaths and whatever a later CLI adds. */
export const HISTORY_KEEP = [
  'type',
  'uuid',
  'isApiErrorMessage',
  'error',
  'apiErrorStatus',
  'quotaLimits',
  'message',
  'version',
  'entrypoint',
] as const;
export const QUOTA_KEEP = [
  'status',
  'resetsAt',
  'rateLimitType',
  'overageStatus',
  'isUsingOverage',
] as const;

export interface HistoryLine {
  recorded: { cli: string; entrypoint: string; from: string };
  line: JsonObject;
}

function pick(value: JsonObject, keys: readonly string[]): JsonObject {
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));
}

/** A reply's text with its reset clause ("resets …", up to a · or the end)
 * pinned to HISTORY_RESET_WORDS. */
export function pinResetClause(text: string): string {
  return text.replace(/\bresets [^·\n]*?(?=\s*·|\s*$)/g, `resets ${HISTORY_RESET_WORDS}`);
}

/** One raw session line, reduced to what the failure classifier reads.
 * Throws a Refusal for a line that is not an API-error reply. */
export function sanitizeHistoryLine(raw: string): HistoryLine {
  const [parsed] = parseLines(raw, 'history');
  if (!isObject(parsed) || parsed.type !== 'assistant' || parsed.isApiErrorMessage !== true) {
    throw new Refusal('The line is not an API-error reply (type assistant, isApiErrorMessage).');
  }
  if (typeof parsed.version !== 'string' || typeof parsed.entrypoint !== 'string') {
    throw new Refusal('The line names no version or entrypoint, so nothing says what wrote it.');
  }
  const line = pick(parsed, HISTORY_KEEP);
  line.uuid = '00000000-0000-4000-8000-000000000001';
  if (isObject(parsed.quotaLimits)) {
    const quota = pick(parsed.quotaLimits, QUOTA_KEEP);
    if ('resetsAt' in quota) quota.resetsAt = HISTORY_RESET;
    line.quotaLimits = quota;
  }
  const message = isObject(parsed.message) ? parsed.message : {};
  const content = Array.isArray(message.content) ? message.content : [];
  line.message = {
    ...pick(message, ['role', 'model', 'stop_reason']),
    content: content
      .filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => ({
        type: 'text',
        text: pinResetClause((block as JsonObject).text as string),
      })),
  };
  return {
    recorded: {
      cli: parsed.version,
      entrypoint: parsed.entrypoint,
      from: 'owner session history, sanitized',
    },
    line,
  };
}

/** Write a history line as jsonl/<name>.json, formatted; nothing on a leak. */
export async function writeHistoryLine(
  name: string,
  history: HistoryLine,
  machine: Machine,
  out: string = HISTORY,
): Promise<string> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Refusal('A history line name is lowercase words joined by hyphens.');
  }
  const text = await formatJson(history);
  const found = leaks(text, machine);
  if (found.length > 0) {
    throw new Refusal(`Refusing to write ${name}: ${found.join('; ')}.`);
  }
  mkdirSync(out, { recursive: true });
  const path = join(out, `${name}.json`);
  writeFileSync(path, text);
  return path;
}

// ---------------------------------------------------------------------------
// The corpus: the spike's raw runs, by name.
// ---------------------------------------------------------------------------

export interface CorpusEntry {
  /** The spike scenario, and which of its steps, under <record>/raw/. */
  scenario: string;
  step: number;
  source: Exclude<Source, 'app'>;
  proves: string;
  transport?: Transport;
  ends?: Ends;
}

/** The spike and scripted recordings real/ holds. App recordings come from the tee by hand. */
export const CORPUS: Readonly<Record<string, CorpusEntry>> = {
  'spike-not-signed-in': {
    scenario: 'not-signed-in',
    step: 0,
    source: 'spike',
    proves:
      'A fresh config with no sign-in still starts, then ends in one synthetic authentication_failed reply and a success result marked is_error.',
  },
  'spike-defer': {
    scenario: 'defer-resume',
    step: 0,
    source: 'spike',
    ends: 'deferred',
    proves:
      'A PreToolUse defer ends the run as tool_deferred, naming the call it held, with no tool result.',
  },
  'spike-defer-resumed': {
    scenario: 'defer-resume',
    step: 1,
    source: 'spike',
    proves: 'Resumed after a defer and allowed, the held call runs and the turn answers.',
  },
  'spike-prompt-tool': {
    scenario: 'prompt-tool',
    step: 1,
    source: 'spike',
    proves: 'With a permission prompt tool that allows it, a Write runs on the input it returned.',
  },
  'spike-ask-question': {
    scenario: 'ask-question',
    step: 1,
    source: 'spike',
    proves: 'With a permission prompt tool, AskUserQuestion is offered and its answer comes back.',
  },
  'spike-stream-json': {
    scenario: 'stream-json',
    step: 0,
    source: 'spike',
    transport: 'stream-json-input',
    proves:
      'The long-lived stream-json child speaks the control protocol and writes one result per message.',
  },
  'spike-killed-mid-tool': {
    scenario: 'kill-resume',
    step: 0,
    source: 'spike',
    ends: 'killed',
    proves: 'A run stopped while its tool runs ends with the call unanswered and no result.',
  },
  'spike-killed-resumed': {
    scenario: 'kill-resume',
    step: 1,
    source: 'spike',
    proves: 'Resumed after a stop mid-tool, the run answers anew without the stopped call.',
  },
  'scripted-thinking': {
    scenario: 'thinking',
    step: 0,
    source: 'scripted',
    proves:
      'A sonnet turn at effort high streams thinking deltas and a signature before its reply.',
  },
  'scripted-bash': {
    scenario: 'bash',
    step: 0,
    source: 'scripted',
    proves: 'A granted Bash call runs ls notes and its output comes back as a tool result.',
  },
  'scripted-max-turns': {
    scenario: 'max-turns',
    step: 0,
    source: 'scripted',
    proves: 'With --max-turns 1, a two-tool task ends as error_max_turns after its first call.',
  },
};

/** The raw files of one corpus entry, read from the spike's record folder. */
export function corpusInput(root: string, entry: CorpusEntry): RecordingInput | null {
  const step = join(layout(root).raw, entry.scenario, String(entry.step));
  if (!existsSync(`${step}.stdout.jsonl`)) return null;
  const sessionPath = `${step}.session.jsonl`;
  const named = existsSync(`${step}.session.json`)
    ? (JSON.parse(readFileSync(`${step}.session.json`, 'utf8')) as { file: string | null }).file
    : null;
  return {
    stream: readFileSync(`${step}.stdout.jsonl`, 'utf8'),
    session:
      named && existsSync(sessionPath)
        ? { name: named, text: readFileSync(sessionPath, 'utf8') }
        : null,
  };
}

/** The session id a stream's init names, or null. */
export function initSession(stream: string): string | null {
  for (const line of stream.split('\n')) {
    try {
      const value = JSON.parse(line) as JsonObject;
      if (
        value.type === 'system' &&
        value.subtype === 'init' &&
        typeof value.session_id === 'string'
      ) {
        return value.session_id;
      }
    } catch {
      // Not a line the init could be.
    }
  }
  return null;
}

/** `--name value` pairs; a flag may repeat. */
export function parseFlags(argv: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let at = 0; at < argv.length; at += 2) {
    const name = argv[at];
    const value = argv[at + 1];
    if (!name.startsWith('--') || value === undefined) {
      throw new Refusal(`Expected --flag value pairs, not ${JSON.stringify(name)}.`);
    }
    flags.set(name.slice(2), [...(flags.get(name.slice(2)) ?? []), value]);
  }
  return flags;
}

async function main(argv: string[]): Promise<void> {
  const write = async (input: RecordingInput, context: SanitizeContext) => {
    const recording = sanitizeRecording(input, context);
    const written = await writeRecording(recording, context.machine);
    for (const line of recording.report) console.log(line);
    for (const path of written) console.log(`wrote ${basename(path)}`);
  };
  if (argv[0] === 'corpus') {
    const root = recordRoot(process.env, tmpdir());
    const names = argv[1] === 'all' ? Object.keys(CORPUS) : [argv[1] ?? ''];
    for (const name of names) {
      const entry = CORPUS[name];
      if (!entry)
        throw new Refusal(`Name a corpus recording or all: ${Object.keys(CORPUS).join(', ')}.`);
      const input = corpusInput(root, entry);
      if (!input) {
        console.log(`${name}: not recorded (spike.ts run ${entry.scenario}), left as it is`);
        continue;
      }
      await write(input, {
        name,
        ...entry,
        scenario: `${entry.scenario} step ${entry.step}`,
        machine: machine(layout(root)),
      });
    }
    return;
  }
  const flags = parseFlags(argv);
  const one = (name: string) => flags.get(name)?.at(-1);
  const linePath = one('line');
  if (linePath !== undefined) {
    const at = Number(one('at'));
    const name = one('name');
    if (!Number.isInteger(at) || at < 1 || !name) {
      throw new Refusal(
        'usage: sanitize.ts --line <session.jsonl> --at <line number> --name <name>',
      );
    }
    const raw = readFileSync(linePath, 'utf8').split('\n')[at - 1] ?? '';
    const root = resolve(one('dir') ?? recordRoot(process.env, tmpdir()));
    const path = await writeHistoryLine(name, sanitizeHistoryLine(raw), machine(layout(root)));
    console.log(`wrote ${basename(path)}`);
    return;
  }
  const streamPath = one('stream');
  const name = one('name');
  const proves = one('proves');
  const source = one('source') as Source | undefined;
  if (!streamPath || !name || !proves || !source) {
    throw new Refusal(
      'usage: sanitize.ts --stream <file> --name <name> --source <source> --proves <sentence> …, or corpus <name|all>',
    );
  }
  const root = resolve(one('dir') ?? recordRoot(process.env, tmpdir()));
  const stream = readFileSync(streamPath, 'utf8');
  let sessionPath = one('session') ?? null;
  if (sessionPath === null) {
    const id = initSession(stream);
    sessionPath = id ? findSessionFile(join(layout(root).config, 'projects'), id) : null;
  }
  await write(
    {
      stream,
      session: sessionPath
        ? { name: basename(sessionPath), text: readFileSync(sessionPath, 'utf8') }
        : null,
    },
    {
      name,
      source,
      proves,
      scenario: one('scenario'),
      transport: one('transport') as Transport | undefined,
      ends: one('ends') as Ends | undefined,
      allowServers: flags.get('allow-server'),
      machine: machine(layout(root)),
    },
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
