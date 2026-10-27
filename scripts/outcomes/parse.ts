import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { OutcomeCase } from './report';

const LIMIT = 262144;
const ADAPTERS = [
  'source_location',
  'ledger_conformance',
  'transcript',
  'native_broker',
  'unavailable',
];
const STATUSES = ['exact', 'relocated', 'changed', 'unavailable', 'unsupported'];
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Unknown field: ${key}`);
}
export function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 16384)
    throw new Error('Invalid bounded string.');
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error('Invalid bounded array.');
  return value;
}
function strings(value: unknown): string[] {
  return array(value).map(string);
}
export function safeRelative(value: unknown): string {
  const path = string(value);
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    [...path].some((character) => {
      const scalar = character.codePointAt(0)!;
      return scalar <= 0x1f || scalar === 0x7f;
    }) ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid relative path.');
  return path;
}
export function boundedJson(path: string, limit = LIMIT): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Input must be a regular file.');
    if (stat.size > limit) throw new Error('Input size limit exceeded.');
    // The extra byte catches growth after fstat without an unbounded read.
    const raw = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < raw.length) {
      const count = readSync(fd, raw, length, raw.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > limit) throw new Error('Input size limit exceeded.');
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, length));
  } finally {
    closeSync(fd);
  }
  const parsed: unknown = JSON.parse(text);
  const pending: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (depth > 16) throw new Error('Input depth limit exceeded.');
    if (typeof value === 'string' && Buffer.byteLength(value) > 16384)
      throw new Error('String size limit exceeded.');
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
    }
  }
  return parsed;
}
function range(value: unknown): { start: number; end: number } {
  const row = object(value);
  keys(row, ['start', 'end']);
  if (
    !Number.isSafeInteger(row.start) ||
    !Number.isSafeInteger(row.end) ||
    (row.start as number) < 0 ||
    (row.end as number) <= (row.start as number) ||
    (row.end as number) > 102400
  )
    throw new Error('Invalid UTF-8 range.');
  return { start: row.start as number, end: row.end as number };
}
function validateInputs(adapter: string, raw: unknown): Record<string, unknown> {
  const input = object(raw);
  if (adapter === 'source_location') {
    keys(input, ['vectors', 'variants']);
    const vectors = strings(input.vectors);
    const variants = input.variants === undefined ? [] : array(input.variants);
    if (vectors.length + variants.length > 128) throw new Error('Source vector cap exceeded.');
    for (const rawVariant of variants) {
      const row = object(rawVariant);
      keys(row, [
        'id',
        'original',
        'current',
        'vaultId',
        'path',
        'readable',
        'range',
        'otherFiles',
      ]);
      string(row.id);
      string(row.original);
      string(row.vaultId);
      safeRelative(row.path);
      range(row.range);
      if (row.current !== null) string(row.current);
      if (typeof row.readable !== 'boolean') throw new Error('Invalid readable flag.');
      if (row.otherFiles !== undefined) {
        const otherFiles = Object.entries(object(row.otherFiles));
        if (otherFiles.length > 128) throw new Error('Other source files cap exceeded.');
        for (const [path, body] of otherFiles) {
          safeRelative(path);
          string(body);
        }
      }
    }
  } else if (adapter === 'ledger_conformance') {
    keys(input, ['vector']);
    if (input.vector !== 'contradiction') throw new Error('Unknown ledger vector.');
  } else if (adapter === 'transcript') {
    keys(input, ['events']);
    const fields: Record<string, string[]> = {
      ToolStart: ['kind', 'tool_name', 'tool_id', 'input', 'parent', 'at'],
      SubagentStarted: [
        'kind',
        'tool_id',
        'agent_id',
        'subagent_type',
        'description',
        'background',
        'depth',
      ],
      ToolDone: ['kind', 'tool_id', 'output', 'is_error', 'parent', 'at'],
      Error: ['kind', 'message', 'parent'],
      SubagentDone: ['kind', 'tool_id', 'status'],
      Text: ['kind', 'message_id', 'text', 'parent', 'at'],
      TurnEnded: ['kind', 'stop_reason', 'last_uuid'],
    };
    for (const rawEvent of array(input.events)) {
      const event = object(rawEvent);
      const kind = string(event.kind);
      if (!Object.hasOwn(fields, kind)) throw new Error('Unsupported folded event.');
      keys(event, fields[kind]);
      for (const [key, value] of Object.entries(event)) {
        if (key === 'is_error' || key === 'background') {
          if (typeof value !== 'boolean') throw new Error('Invalid event flag.');
        } else if (key === 'depth') {
          if (!Number.isSafeInteger(value) || (value as number) < 0)
            throw new Error('Invalid event depth.');
        } else if (value !== null) string(value);
      }
      const required: Record<string, string[]> = {
        ToolStart: ['tool_id', 'tool_name', 'input'],
        SubagentStarted: ['tool_id', 'agent_id', 'subagent_type', 'description', 'background'],
        ToolDone: ['tool_id'],
        Error: ['message'],
        SubagentDone: ['tool_id', 'status'],
        Text: ['message_id', 'text'],
        TurnEnded: [],
      };
      for (const key of required[kind])
        if (!(key in event)) throw new Error('Missing folded event field.');
    }
  } else if (adapter === 'native_broker') {
    keys(input, ['scenario']);
    if (input.scenario !== 'lost-response') throw new Error('Unknown native scenario.');
  } else {
    keys(input, ['capability', 'reason']);
    string(input.capability);
    string(input.reason);
  }
  return input;
}
export function parseCase(raw: unknown): OutcomeCase {
  const row = object(raw);
  keys(row, [
    'version',
    'id',
    'title',
    'adapter',
    'inputs',
    'allowedEffects',
    'forbiddenEffects',
    'expectedSources',
    'expectedArtifacts',
    'injections',
    'requiredCapabilities',
  ]);
  if (row.version !== 1) throw new Error('Unsupported case version.');
  const id = string(row.id);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid case id.');
  const adapter = string(row.adapter);
  if (!ADAPTERS.includes(adapter)) throw new Error('Unknown adapter.');
  return {
    version: 1,
    id,
    title: string(row.title),
    adapter: adapter as OutcomeCase['adapter'],
    inputs: validateInputs(adapter, row.inputs),
    allowedEffects: strings(row.allowedEffects),
    forbiddenEffects: strings(row.forbiddenEffects),
    expectedSources: array(row.expectedSources).map((value) => {
      const item = object(value);
      keys(item, ['id', 'status', 'range']);
      const status = string(item.status);
      if (!STATUSES.includes(status)) throw new Error('Invalid source status.');
      return {
        id: string(item.id),
        status,
        ...(item.range === undefined ? {} : { range: range(item.range) }),
      };
    }),
    expectedArtifacts: array(row.expectedArtifacts).map((value) => {
      const item = object(value);
      keys(item, ['id', 'state']);
      return { id: string(item.id), state: string(item.state) };
    }),
    injections: strings(row.injections),
    requiredCapabilities: strings(row.requiredCapabilities),
  };
}
export function loadManifest(path: string): { clock: string; cases: OutcomeCase[] } {
  const manifest = object(boundedJson(path));
  keys(manifest, ['version', 'clock', 'cases']);
  if (manifest.version !== 1) throw new Error('Unsupported manifest version.');
  const clock = string(manifest.clock);
  if (!Number.isFinite(Date.parse(clock))) throw new Error('Invalid manifest clock.');
  const paths = strings(manifest.cases);
  if (paths.length === 0 || paths.length > 24) throw new Error('Manifest case limit exceeded.');
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate case path.');
  const root = realpathSync(dirname(resolve(path)));
  const cases = paths.map((file) => {
    const local = resolve(root, safeRelative(file));
    const actual = realpathSync(local);
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error('Case path escapes manifest.');
    return parseCase(boundedJson(local));
  });
  if (new Set(cases.map((item) => item.id)).size !== cases.length)
    throw new Error('Duplicate case id.');
  return { clock, cases };
}
