// The spike's reducer (M56.1): one raw recording in, one fixture out, holding
// only the fields the D4 record's facts read. M54's fixture rule, made code:
//
// - an allowlist per line type: ids, types and subtypes, message.model and
//   stop_reason, block types, tool names and inputs, tool results (is_error,
//   text cut at 200 chars), result counts, usage numbers and denials, init's
//   model, permissionMode, version, apiKeySource, tools and servers, and the
//   control protocol's subtypes and payloads. stream_event lines, thinking
//   text, timestamps, paths the facts never read and any account or email
//   field all drop;
// - one IdMap per scenario, across argv, stream, session file, probe log and
//   file names, so every session, message, tool and request id is synthetic;
// - placeholders for the record folder (as given and as its realpath), the
//   repo, $HOME, the user, host and git name and email, and their slug forms;
// - prettier's own output, and no write past a scan.ts hit.
//
// The IdMap, placeholders and formatJson are exported for M56.2's sanitizer
// (the M56 plan's contract), so ids and paths leave this machine one way.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { SYNTHETIC_ID, SYNTHETIC_UUID } from './scan';

type JsonObject = Record<string, unknown>;

/** M54's pin: the CLI every recording must come from. */
export const CLI_VERSION = '2.1.250';
/** The toy servers a recording may load. Any other server refuses it. */
export const TOY_SERVERS = ['probe', 'cerebro'];
/** How much of any text a fixture keeps. */
export const TEXT_LIMIT = 200;

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ONE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED = /\b(msg|toolu|srvtoolu|req)_[A-Za-z0-9]+/g;

/**
 * Real ids to synthetic ones, numbered in order of first appearance: UUIDs
 * become 00000000-0000-4000-8000-<12 hex>, and msg_, toolu_, srvtoolu_ and
 * req_ ids that prefix plus a zero-padded counter. One map per scenario.
 */
export class IdMap {
  private readonly real = new Map<string, string>();
  private readonly made = new Set<string>();
  private readonly counts = new Map<string, number>();

  private next(kind: string): number {
    const count = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, count);
    return count;
  }

  private remember(key: string, synthetic: string): string {
    this.real.set(key, synthetic);
    this.made.add(synthetic);
    return synthetic;
  }

  /** One id's stand-in, the same wherever it appears. */
  id(value: string): string {
    if (this.made.has(value)) return value;
    const key = ONE_UUID.test(value) ? value.toLowerCase() : value;
    const known = this.real.get(key);
    if (known) return known;
    const prefix = /^(msg|toolu|srvtoolu|req)_/.exec(value)?.[1];
    if (prefix)
      return this.remember(key, `${prefix}_${String(this.next(prefix)).padStart(24, '0')}`);
    const hex = this.next('uuid').toString(16).padStart(12, '0');
    return this.remember(key, `00000000-0000-4000-8000-${hex}`);
  }

  /** A control request id, whatever its shape, as a req_ counter. */
  request(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    if (this.made.has(value)) return value;
    return this.id(SYNTHETIC_UUID.test(value) || SYNTHETIC_ID.test(value) ? value : `req_${value}`);
  }

  /** Every UUID and prefixed id in `text`, replaced. */
  replaceIn(text: string): string {
    return text
      .replace(UUID, (match) => this.id(match))
      .replace(PREFIXED, (match) => this.id(match));
  }
}

/** What this machine would leak into a fixture. */
export interface Machine {
  recordDir: string;
  /** The record folder's realpath, when it differs (macOS adds /private). */
  realRecordDir?: string;
  repo: string;
  home: string;
  user: string;
  host: string;
  gitName: string;
  gitEmail: string;
}

/** Claude Code's project-folder form of a path: anything not a letter or digit is a dash. */
export function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Every machine string and its placeholder, longest first, so the record
 * folder wins over $HOME when it sits inside it and $HOME over the user.
 * Values shorter than three characters are left alone, so a short name
 * cannot rewrite ordinary words.
 */
export function placeholders(machine: Machine): [string, string][] {
  const pairs = new Map<string, string>();
  const add = (from: string | undefined, to: string) => {
    if (from && from.length >= 3 && !pairs.has(from)) pairs.set(from, to);
  };
  for (const dir of [machine.recordDir, machine.realRecordDir]) {
    add(dir, '/RECORD');
    add(dir && slug(dir), '-RECORD');
  }
  add(machine.repo, '/REPO');
  add(slug(machine.repo), '-REPO');
  add(machine.home, '~');
  add(slug(machine.home), '-HOME');
  add(machine.gitEmail, 'GIT_EMAIL');
  add(slug(machine.gitEmail), 'GIT-EMAIL');
  add(machine.host, 'HOST');
  add(slug(machine.host), 'HOST');
  add(machine.host.split('.')[0], 'HOST');
  add(machine.gitName, 'GIT_NAME');
  add(slug(machine.gitName), 'GIT-NAME');
  add(machine.user, 'USER');
  return [...pairs].sort(([a], [b]) => b.length - a.length);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/** `text` with every placeholder pair applied, each only where it stands alone. */
export function applyPlaceholders(text: string, pairs: [string, string][]): string {
  return pairs.reduce(
    (out, [from, to]) =>
      out.replace(new RegExp(`(?<![A-Za-z0-9])${escape(from)}(?![A-Za-z0-9])`, 'g'), to),
    text,
  );
}

/** Prettier's output for `value`, under the repo's own config. */
export async function formatJson(value: unknown): Promise<string> {
  const filepath = join(REPO, 'src-tauri/fixtures/cli-stream/spike/fixture.json');
  const config = (await resolveConfig(filepath)) ?? {};
  return format(JSON.stringify(value, null, 2), { ...config, filepath, parser: 'json' });
}

// ---------------------------------------------------------------------------
// The allowlist.
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cut(text: string): string {
  return text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text;
}

/** Every string inside `value` cut to the limit. */
function cutDeep(value: unknown): unknown {
  if (typeof value === 'string') return cut(value);
  if (Array.isArray(value)) return value.map(cutDeep);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, cutDeep(inner)]));
  }
  return value;
}

function keep(source: unknown, keys: readonly string[]): JsonObject {
  const out: JsonObject = {};
  if (!isObject(source)) return out;
  for (const key of keys) if (source[key] !== undefined) out[key] = cutDeep(source[key]);
  return out;
}

/** The numbers in `source`, nested objects of numbers included. */
function numbers(source: unknown): JsonObject | undefined {
  if (!isObject(source)) return undefined;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number') out[key] = value;
    else if (isObject(value)) {
      const inner = numbers(value);
      if (inner && Object.keys(inner).length > 0) out[key] = inner;
    }
  }
  return out;
}

function block(source: unknown): JsonObject {
  if (!isObject(source)) return { type: 'unknown' };
  switch (source.type) {
    case 'text':
      return { type: 'text', text: typeof source.text === 'string' ? cut(source.text) : '' };
    case 'tool_use':
    case 'server_tool_use':
      return keep(source, ['type', 'id', 'name', 'input']);
    case 'tool_result':
      return {
        ...keep(source, ['type', 'tool_use_id', 'is_error']),
        content: content(source.content),
      };
    default:
      // thinking, redacted_thinking, image and the rest: the kind, never the payload.
      return { type: typeof source.type === 'string' ? source.type : 'unknown' };
  }
}

function content(value: unknown): unknown {
  if (typeof value === 'string') return cut(value);
  return Array.isArray(value) ? value.map(block) : undefined;
}

function message(source: unknown): JsonObject {
  const out = keep(source, ['role', 'id', 'model', 'stop_reason']);
  if (!isObject(source)) return out;
  if (source.content !== undefined) out.content = content(source.content);
  if (isObject(source.usage)) out.usage = numbers(source.usage);
  return out;
}

const INIT_KEYS = [
  'type',
  'subtype',
  'uuid',
  'session_id',
  'model',
  'permissionMode',
  'claude_code_version',
  'apiKeySource',
  'tools',
];
const SYSTEM_KEYS = [
  'type',
  'subtype',
  'uuid',
  'session_id',
  'status',
  'attempt',
  'max_retries',
  'error_status',
  'error',
];
const RESULT_KEYS = [
  'type',
  'subtype',
  'uuid',
  'session_id',
  'is_error',
  'num_turns',
  'result',
  'errors',
  'stop_reason',
  'terminal_reason',
  'api_error_status',
  'total_cost_usd',
  'queued_turn_count',
];
const MODEL_KEYS = [
  'value',
  'resolvedModel',
  'displayName',
  'supportsEffort',
  'supportedEffortLevels',
  'supportsAdaptiveThinking',
  'supportsFastMode',
  'supportsAutoMode',
];

function servers(list: unknown): unknown {
  return Array.isArray(list) ? list.map((server) => keep(server, ['name', 'status'])) : undefined;
}

function names(list: unknown): unknown {
  return Array.isArray(list) ? list.map((item) => (isObject(item) ? item.name : item)) : undefined;
}

function result(line: JsonObject): JsonObject {
  const out = keep(line, RESULT_KEYS);
  if (Array.isArray(line.permission_denials)) {
    out.permission_denials = line.permission_denials.map((denial) =>
      keep(denial, ['tool_name', 'tool_use_id', 'tool_input']),
    );
  }
  if (line.deferred_tool_use !== undefined) {
    out.deferred_tool_use = keep(line.deferred_tool_use, ['id', 'name', 'input']);
  }
  if (isObject(line.usage)) out.usage = numbers(line.usage);
  if (isObject(line.modelUsage)) out.modelUsage = numbers(line.modelUsage);
  return out;
}

/** What the CLI answered to one of the driver's own control requests. */
function answer(subtype: string | undefined, payload: unknown): unknown {
  if (!isObject(payload)) return payload;
  switch (subtype) {
    case 'initialize': {
      const out = keep(payload, ['output_style', 'current_model', 'current_permission_mode']);
      out.commands = names(payload.commands);
      out.agents = names(payload.agents);
      if (Array.isArray(payload.models))
        out.models = payload.models.map((m) => keep(m, MODEL_KEYS));
      return out;
    }
    case 'mcp_status':
      return { mcpServers: servers(payload.mcpServers) };
    case 'interrupt':
      return keep(payload, ['still_queued', 'cancelled']);
    default:
      // Anything else keeps its plain fields only.
      return Object.fromEntries(
        Object.entries(payload)
          .filter(([, value]) => typeof value !== 'object' || value === null)
          .map(([key, value]) => [key, cutDeep(value)]),
      );
  }
}

export interface ReduceContext {
  ids: IdMap;
  /** The subtype of each control request the driver sent, by its id. */
  sent: Map<unknown, string>;
}

/** One stdout line, kept to its allowlist, or null when the line drops. */
export function keepStreamLine(line: unknown, context: ReduceContext): JsonObject | null {
  if (!isObject(line)) return { unparsed: true };
  switch (line.type) {
    case 'stream_event':
      return null;
    case 'system':
      return line.subtype === 'init'
        ? { ...keep(line, INIT_KEYS), mcp_servers: servers(line.mcp_servers) }
        : keep(line, SYSTEM_KEYS);
    case 'assistant':
    case 'user':
      return {
        ...keep(line, [
          'type',
          'uuid',
          'session_id',
          'parent_tool_use_id',
          'error',
          'is_api_error_message',
          'isReplay',
        ]),
        message: message(line.message),
      };
    case 'result':
      return result(line);
    case 'control_request': {
      const request = isObject(line.request) ? line.request : {};
      const kept = keep(request, [
        'subtype',
        'tool_name',
        'input',
        'tool_use_id',
        'decision_reason',
      ]);
      return { type: line.type, request_id: context.ids.request(line.request_id), request: kept };
    }
    case 'control_response': {
      const response = isObject(line.response) ? line.response : {};
      const id = context.ids.request(response.request_id);
      const out = { ...keep(response, ['subtype', 'error']), request_id: id };
      return {
        type: line.type,
        response: { ...out, response: answer(context.sent.get(id), response.response) },
      };
    }
    case 'rate_limit_event':
      return {
        ...keep(line, ['type', 'uuid', 'session_id']),
        rate_limit_info: keep(line.rate_limit_info, ['status', 'rateLimitType']),
      };
    default:
      return keep(line, ['type', 'subtype', 'uuid', 'session_id']);
  }
}

/** One line the driver wrote to a stream-json child's stdin. */
export function keepStdinLine(line: unknown, context: ReduceContext): JsonObject {
  if (!isObject(line)) return { unparsed: true };
  if (line.type === 'control_request') {
    const id = context.ids.request(line.request_id);
    const request = keep(line.request, ['subtype', 'model']);
    if (typeof request.subtype === 'string') context.sent.set(id, request.subtype);
    return { type: line.type, request_id: id, request };
  }
  if (line.type === 'control_response') {
    const response = isObject(line.response) ? line.response : {};
    return {
      type: line.type,
      response: {
        ...keep(response, ['subtype']),
        request_id: context.ids.request(response.request_id),
        response: keep(response.response, ['behavior', 'message', 'updatedInput']),
      },
    };
  }
  return { ...keep(line, ['type']), message: message(line.message) };
}

const SESSION_KEYS = [
  'type',
  'subtype',
  'uuid',
  'parentUuid',
  'logicalParentUuid',
  'sessionId',
  'isSidechain',
  'isMeta',
  'isApiErrorMessage',
  'error',
  'apiErrorStatus',
  'interruptedByShutdown',
  'entrypoint',
  'version',
  'effort',
  'operation',
];

/** One line of Claude Code's session file. */
export function keepSessionLine(line: unknown): JsonObject {
  if (!isObject(line)) return { unparsed: true };
  const out = keep(line, SESSION_KEYS);
  if (isObject(line.message)) out.message = message(line.message);
  if (isObject(line.attachment)) {
    out.attachment = keep(line.attachment, ['type', 'toolUseID', 'toolName']);
  }
  return out;
}

/** One line of the probe's log: what the prompt tool or the hook was asked and said. */
export function keepProbeEntry(entry: unknown): JsonObject {
  if (!isObject(entry)) return { unparsed: true };
  if (entry.mode === 'hook') {
    const input = keep(entry.input, [
      'hook_event_name',
      'tool_name',
      'tool_input',
      'tool_use_id',
      'session_id',
      'permission_mode',
    ]);
    return { mode: 'hook', input, answer: cutDeep(entry.answer) };
  }
  return keep(entry, ['mode', 'tool_name', 'input', 'tool_use_id', 'answer']);
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

export interface RawStep {
  argv: string[];
  stdout: string[];
  stdin: string[];
  stderr: string;
  exit: { code: number | null; signal: string | null; stopped?: boolean };
  session: { file: string | null; files: string[]; lines: string[] };
  probe: string[];
}

export interface RawScenario {
  cli_version: string;
  scenario: string;
  steps: RawStep[];
}

export interface FixtureStep {
  argv: string[];
  exit: { code: number | null; signal: string | null; stopped: boolean };
  stderr: string;
  stdin?: JsonObject[];
  stream: JsonObject[];
  session: { file: string | null; files: string[]; lines: JsonObject[] };
  probe: JsonObject[];
}

export interface SpikeFixture {
  cli_version: string;
  scenario: string;
  /** recorded: reduced from a live run. derived: written from the CLI's own code, owed a live run. */
  source: 'recorded' | 'derived';
  derived_from?: string[];
  steps: FixtureStep[];
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Every string in `value`, keys included, through `scrub`, in document order. */
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

/** Why a recording may not become a fixture, or null when it may. */
function refusal(raw: RawScenario): string | null {
  if (raw.cli_version !== CLI_VERSION) {
    return `it was recorded on Claude Code ${raw.cli_version}, not ${CLI_VERSION}`;
  }
  for (const step of raw.steps) {
    for (const line of step.stdout.map(parse)) {
      if (!isObject(line) || line.type !== 'system' || line.subtype !== 'init') continue;
      if (line.claude_code_version !== CLI_VERSION) {
        return `an init reports Claude Code ${String(line.claude_code_version)}`;
      }
      if (line.apiKeySource !== undefined && line.apiKeySource !== 'none') {
        return `an init names the API-key source ${String(line.apiKeySource)}; recordings use the owner's login only`;
      }
      const foreign = (Array.isArray(line.mcp_servers) ? line.mcp_servers : [])
        .map((server) => (isObject(server) ? String(server.name) : ''))
        .filter((name) => !TOY_SERVERS.includes(name));
      if (foreign.length > 0)
        return `an init lists servers other than the toys: ${foreign.join(', ')}`;
    }
  }
  return null;
}

/** One raw recording, reduced to its fixture. Throws rather than reduce a refused one. */
export function reduceScenario(raw: RawScenario, machine: Machine): SpikeFixture {
  const why = refusal(raw);
  if (why) throw new Error(`Refusing to reduce ${raw.scenario}: ${why}.`);
  const ids = new IdMap();
  const pairs = placeholders(machine);
  const scrub = (text: string) => applyPlaceholders(ids.replaceIn(text), pairs);
  const steps = raw.steps.map((step): FixtureStep => {
    const context: ReduceContext = { ids, sent: new Map() };
    const argv = scrubDeep(step.argv, scrub) as string[];
    const stdin = step.stdin.map((line) => keepStdinLine(scrubDeep(parse(line), scrub), context));
    const stream = step.stdout
      .map((line) => keepStreamLine(scrubDeep(parse(line), scrub), context))
      .filter((line): line is JsonObject => line !== null);
    const session = {
      file: step.session.file === null ? null : scrub(step.session.file),
      files: step.session.files.map(scrub),
      lines: step.session.lines.map((line) => keepSessionLine(scrubDeep(parse(line), scrub))),
    };
    const probe = step.probe.map((line) => keepProbeEntry(scrubDeep(parse(line), scrub)));
    return {
      argv,
      exit: { code: step.exit.code, signal: step.exit.signal, stopped: step.exit.stopped === true },
      stderr: cut(scrub(step.stderr)),
      ...(stdin.length > 0 ? { stdin } : {}),
      stream,
      session,
      probe,
    };
  });
  return { cli_version: raw.cli_version, scenario: raw.scenario, source: 'recorded', steps };
}
