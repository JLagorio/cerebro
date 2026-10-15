/** Import policy is shared data; this interpreter is held to Rust by its cases. */
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { splitFrontmatter } from './frontmatter';
import raw from '../../shared/import/sources.v1.json';
import { sha256Hex } from '@/lib/sha256';
import { isHiddenName } from './trash';
import { diskFolded } from './okf';

export type IdStep =
  | {
      op:
        | 'trim'
        | 'drop_query_and_fragment'
        | 'trim_trailing_slashes'
        | 'last_segment'
        | 'ascii_lower'
        | 'require_uuid';
    }
  | { op: 'remove'; chars: string }
  | { op: 'take_last'; count: number }
  | { op: 'require_hex'; length: number }
  | { op: 'require_printable'; max: number }
  | { op: 'sha256_hex'; domain: string };
export interface ImportSystem {
  id: string;
  label: string;
  record: string;
  id_steps: IdStep[];
}
export interface ImportSources {
  format: number;
  artifact_version: number;
  rule_version: string;
  about: string;
  agent_guard: string[];
  cache: { stamped_by: string; keys: string[]; kinds: string[] };
  import: { stamped_by: string; keys: string[]; methods: string[] };
  systems: ImportSystem[];
  stamp: { order: string[]; value: string; volatile: string[]; optional: string[] };
  import_hash: { domain: string };
  url_pattern: string;
  refused: { types: string[]; roots: string[] };
  outcomes: Record<'created' | 'replaced' | 'unchanged' | 'kept' | 'duplicate', string>;
  kept_reasons: Record<'changed_since_import' | 'stamp_unreadable', string>;
  messages: Record<
    | 'unknown_system'
    | 'bad_record_id'
    | 'bad_url'
    | 'bad_shape'
    | 'stamped_key'
    | 'refused_type'
    | 'bad_path'
    | 'path_twice'
    | 'stamp_refusal',
    string
  >;
  cases: {
    stamp_guard: { name: string; before: string; after: string; refusal: string | null }[];
    urls: { input: string; accepted: boolean }[];
    record_ids: { system: string; input: string; expected: string | null }[];
    import_hashes: {
      name: string;
      system: string;
      record_id: string;
      url: string | null;
      method: string | null;
      content: string;
      now: string;
      actor: string;
      hash: string;
      composed: string;
    }[];
    stamps: { content: string; expected: string | null }[];
  };
}
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
const trim = (text: string) => text.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
const failure = (path: string, why: string): never => {
  throw new Error(`Invalid sources artifact: ${path}: ${why}`);
};
const object = (value: unknown, path: string, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return failure(path, 'must be an object');
  const row = value as Record<string, unknown>;
  for (const key of keys) if (!Object.hasOwn(row, key)) failure(`${path}.${key}`, 'is required');
  for (const key of Object.keys(row))
    if (!keys.includes(key)) failure(`${path}.${key}`, 'is not a field');
  return row;
};
const textAt = (value: unknown, path: string): string =>
  typeof value === 'string' && value.length > 0 ? value : failure(path, 'must be non-empty text');
const positive = (value: unknown, path: string): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : failure(path, 'must be a positive integer');
const list = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value) || value.length === 0) return failure(path, 'must be a non-empty list');
  const result = value.map((item, i) => textAt(item, `${path}[${i}]`));
  if (new Set(result).size !== result.length) failure(path, 'must not repeat a value');
  return result;
};
const STEP_KEYS: Record<IdStep['op'], string[]> = {
  trim: [],
  drop_query_and_fragment: [],
  trim_trailing_slashes: [],
  last_segment: [],
  ascii_lower: [],
  require_uuid: [],
  remove: ['chars'],
  take_last: ['count'],
  require_hex: ['length'],
  require_printable: ['max'],
  sha256_hex: ['domain'],
};
export function loadImportSources(value: unknown): ImportSources {
  const row = object(value, 'sources', [
    'format',
    'artifact_version',
    'rule_version',
    'about',
    'agent_guard',
    'cache',
    'import',
    'systems',
    'stamp',
    'import_hash',
    'url_pattern',
    'refused',
    'outcomes',
    'kept_reasons',
    'messages',
    'cases',
  ]);
  if (row.format !== 1) failure('sources.format', 'must be 1');
  positive(row.artifact_version, 'sources.artifact_version');
  for (const key of ['rule_version', 'about']) textAt(row[key], `sources.${key}`);
  list(row.agent_guard, 'sources.agent_guard');
  for (const [name, extra] of [
    ['cache', 'kinds'],
    ['import', 'methods'],
  ] as const) {
    const family = object(row[name], `sources.${name}`, ['stamped_by', 'keys', extra]);
    textAt(family.stamped_by, `sources.${name}.stamped_by`);
    for (const key of ['keys', extra]) list(family[key], `sources.${name}.${key}`);
  }
  if (!Array.isArray(row.systems) || row.systems.length === 0)
    failure('sources.systems', 'must be a non-empty list');
  const ids: string[] = [];
  for (const [i, value] of (row.systems as unknown[]).entries()) {
    const path = `sources.systems[${i}]`;
    const system = object(value, path, ['id', 'label', 'record', 'id_steps']);
    const id = textAt(system.id, `${path}.id`);
    if (!/^[a-z][a-z0-9_]*$/.test(id) || (ids.length > 0 && ids.at(-1)! >= id))
      failure(`${path}.id`, 'must be a unique sorted lowercase id');
    ids.push(id);
    textAt(system.label, `${path}.label`);
    textAt(system.record, `${path}.record`);
    if (!Array.isArray(system.id_steps) || system.id_steps.length === 0)
      failure(`${path}.id_steps`, 'must be a non-empty list');
    for (const [j, stepValue] of (system.id_steps as unknown[]).entries()) {
      const at = `${path}.id_steps[${j}]`;
      const candidate = stepValue as Record<string, unknown> | null;
      if (
        candidate === null ||
        typeof candidate !== 'object' ||
        typeof candidate.op !== 'string' ||
        !Object.hasOwn(STEP_KEYS, candidate.op)
      )
        failure(`${at}.op`, 'is not a canonicalizer step');
      const step = object(candidate, at, ['op', ...STEP_KEYS[candidate!.op as IdStep['op']]]);
      for (const key of Object.keys(step).filter((key) => key !== 'op')) {
        if (['count', 'length', 'max'].includes(key)) positive(step[key], `${at}.${key}`);
        else textAt(step[key], `${at}.${key}`);
      }
    }
  }
  const stamp = object(row.stamp, 'sources.stamp', ['order', 'value', 'volatile', 'optional']);
  if (stamp.value !== 'json_string') failure('sources.stamp.value', 'must be json_string');
  const order = list(stamp.order, 'sources.stamp.order');
  const imported = row.import as ImportSources['import'];
  if (JSON.stringify(order) !== JSON.stringify(imported.keys))
    failure('sources.stamp.order', 'must list the import keys in order');
  for (const key of ['volatile', 'optional'])
    for (const name of list(stamp[key], `sources.stamp.${key}`))
      if (!order.includes(name)) failure(`sources.stamp.${key}`, 'must name import keys');
  const pattern = textAt(row.url_pattern, 'sources.url_pattern');
  try {
    new RegExp(pattern);
  } catch {
    failure('sources.url_pattern', 'must be a regular expression');
  }
  const domain = object(row.import_hash, 'sources.import_hash', ['domain']);
  textAt(domain.domain, 'sources.import_hash.domain');
  const refused = object(row.refused, 'sources.refused', ['types', 'roots']);
  list(refused.types, 'sources.refused.types');
  list(refused.roots, 'sources.refused.roots');
  for (const [key, keys] of [
    ['outcomes', ['created', 'replaced', 'unchanged', 'kept', 'duplicate']],
    ['kept_reasons', ['changed_since_import', 'stamp_unreadable']],
    [
      'messages',
      [
        'unknown_system',
        'bad_record_id',
        'bad_url',
        'bad_shape',
        'stamped_key',
        'refused_type',
        'bad_path',
        'path_twice',
        'stamp_refusal',
      ],
    ],
  ] as const) {
    const words = object(row[key], `sources.${key}`, keys);
    for (const name of keys) textAt(words[name], `sources.${key}.${name}`);
  }
  const cases = object(row.cases, 'sources.cases', [
    'record_ids',
    'import_hashes',
    'stamps',
    'urls',
    'stamp_guard',
  ]);
  for (const key of Object.keys(cases))
    if (!Array.isArray(cases[key]) || cases[key].length === 0)
      failure(`sources.cases.${key}`, 'must be a non-empty list');
  return value as ImportSources;
}
export const IMPORT_SOURCES = loadImportSources(raw);
export const CACHE_KINDS: readonly string[] = IMPORT_SOURCES.cache.kinds;
export const IMPORT_KEYS: readonly string[] = IMPORT_SOURCES.import.keys;
export function importWords(
  key: keyof ImportSources['messages'],
  values: Record<string, string> = {},
): string {
  return IMPORT_SOURCES.messages[key].replace(
    /\{(\w+)\}/g,
    (whole, name: string) => values[name] ?? whole,
  );
}
export function importSystem(system: string): ImportSystem {
  const row = IMPORT_SOURCES.systems.find((row) => row.id === system);
  if (row === undefined)
    throw new Error(
      importWords('unknown_system', {
        system,
        systems: IMPORT_SOURCES.systems.map((row) => row.id).join(', '),
      }),
    );
  return row;
}
export function canonicalRecordId(system: string, input: string): string {
  const row = importSystem(system);
  let value = input;
  const bad = () => {
    throw new Error(importWords('bad_record_id', { input, label: row.label, record: row.record }));
  };
  for (const step of row.id_steps) {
    switch (step.op) {
      case 'trim':
        value = trim(value);
        break;
      case 'ascii_lower':
        value = asciiLower(value);
        break;
      case 'drop_query_and_fragment':
        value = value.split(/[?#]/)[0];
        break;
      case 'trim_trailing_slashes':
        value = value.replace(/\/+$/, '');
        break;
      case 'last_segment':
        value = value.split('/').at(-1) ?? '';
        break;
      case 'remove':
        value = [...value].filter((c) => !step.chars.includes(c)).join('');
        break;
      case 'take_last':
        value = [...value].slice(-step.count).join('');
        break;
      case 'require_hex':
        if (value.length !== step.length || !/^[0-9a-f]+$/.test(value)) bad();
        break;
      case 'require_uuid':
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) bad();
        break;
      case 'require_printable':
        if (
          !value ||
          [...value].length > step.max ||
          [...value].some((c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127)
        )
          bad();
        break;
      case 'sha256_hex':
        value = sha256Hex(`${step.domain}\0${value}`);
        break;
    }
  }
  return value;
}
/** Stored digest identities are already canonical, so never hash them twice. */
export function storedRecordId(system: string, value: string): string | null {
  try {
    if (importSystem(system).id_steps.at(-1)?.op === 'sha256_hex')
      return /^[0-9a-f]{64}$/.test(value) ? value : null;
    return canonicalRecordId(system, value);
  } catch {
    return null;
  }
}
export function importPathRefusal(path: string): string | null {
  const lower = asciiLower(path);
  return path.includes('\\') ||
    path.startsWith('/') ||
    !lower.endsWith('.md') ||
    path.split('/').some((part) => !part || part === '..' || part === '.' || isHiddenName(part)) ||
    IMPORT_SOURCES.refused.roots.some((root) => diskFolded(path).startsWith(diskFolded(root)))
    ? importWords('bad_path', { path })
    : null;
}
function sourceShape(content: string): { end: number; fields: Record<string, unknown> } {
  const end = content.indexOf('\n---\n', 3);
  if (!content.startsWith('---\n') || content.includes('\r') || end < 3)
    throw new Error(importWords('bad_shape'));
  try {
    const parsed = parseDocument(end === 3 ? '' : content.slice(4, end));
    const value: unknown = parsed.toJS({ maxAliasCount: 100 });
    if (
      parsed.errors.length ||
      (value !== null && (typeof value !== 'object' || Array.isArray(value)))
    )
      throw new Error(importWords('bad_shape'));
    return { end, fields: (value ?? {}) as Record<string, unknown> };
  } catch {
    throw new Error(importWords('bad_shape'));
  }
}
export interface ImportStamp {
  system: string;
  recordId: string;
  url?: string;
  method?: string;
  now: string;
  actor: string;
}
/** recordId is canonical at this seam; input canonicalization happens at the planner. */
export function validImportUrl(url: string): boolean {
  return new RegExp(IMPORT_SOURCES.url_pattern).exec(url)?.[0] === url;
}
export function composeImport(
  content: string,
  stamp: ImportStamp,
): { content: string; hash: string } {
  importSystem(stamp.system);
  if (stamp.url !== undefined && !validImportUrl(stamp.url))
    throw new Error(importWords('bad_url', { input: stamp.url }));
  const { end, fields } = sourceShape(content);
  const keys = [...new Set([...IMPORT_SOURCES.cache.keys, ...IMPORT_KEYS])].filter((key) =>
    Object.hasOwn(fields, key),
  );
  if (keys.length) throw new Error(importWords('stamped_key', { keys: keys.join(', ') }));
  if (
    typeof fields.type === 'string' &&
    IMPORT_SOURCES.refused.types.some(
      (type) => asciiLower(type) === asciiLower(trim(fields.type as string)),
    )
  )
    throw new Error(importWords('refused_type', { type: fields.type }));
  if (stamp.method !== undefined && !IMPORT_SOURCES.import.methods.includes(stamp.method))
    throw new Error(importWords('bad_shape'));
  const values: Record<string, string | undefined> = {
    source_system: stamp.system,
    source_record_id: stamp.recordId,
    source_url: stamp.url,
    imported_at: stamp.now,
    imported_by: stamp.actor,
    import_method: stamp.method,
    import_hash: '',
  };
  const write = (blank: boolean) =>
    content.slice(0, end) +
    '\n' +
    IMPORT_SOURCES.stamp.order
      .filter((key) => values[key] !== undefined)
      .map(
        (key) =>
          `${key}: ${JSON.stringify(blank && IMPORT_SOURCES.stamp.volatile.includes(key) ? '' : values[key])}`,
      )
      .join('\n') +
    content.slice(end);
  const hash = sha256Hex(`${IMPORT_SOURCES.import_hash.domain}\0${write(true)}`);
  values.import_hash = hash;
  const composed = write(false);
  sourceShape(composed);
  return { content: composed, hash };
}
export function storedImportHash(content: string): { stored: string; current: string } | null {
  try {
    const { end, fields } = sourceShape(content);
    if (typeof fields.import_hash !== 'string' || !/^[0-9a-f]{64}$/.test(fields.import_hash))
      return null;
    const lines = content.slice(0, end).split('\n');
    for (const key of IMPORT_SOURCES.stamp.volatile) {
      const matches = lines.flatMap((line, index) => (line.startsWith(`${key}: `) ? [index] : []));
      if (
        matches.length !== 1 ||
        typeof fields[key] !== 'string' ||
        lines[matches[0]] !== `${key}: ${JSON.stringify(fields[key])}`
      )
        return null;
      lines[matches[0]] = `${key}: ""`;
    }
    return {
      stored: fields.import_hash,
      current: sha256Hex(
        `${IMPORT_SOURCES.import_hash.domain}\0${lines.join('\n')}${content.slice(end)}`,
      ),
    };
  } catch {
    return null;
  }
}

function stampFields(content: string): Record<string, string> {
  try {
    const yaml = splitFrontmatter(content).yaml;
    if (yaml === null) return {};
    const parsed = parseDocument(yaml, { intAsBigInt: true });
    if (parsed.errors.length) return {};
    // Enforce the parser's alias expansion budget before resolving nodes.
    parsed.toJS({ maxAliasCount: 100 });
    const active = new Set<unknown>();
    const value = (node: unknown): string => {
      if (active.has(node) || active.size > 128) throw new Error('recursive YAML');
      active.add(node);
      let result: unknown;
      if (node === null) result = ['null'];
      else if (isAlias(node)) result = JSON.parse(value(node.resolve(parsed)));
      else if (isMap(node)) {
        const pairs = node.items.map((pair) => [value(pair.key), value(pair.value)]);
        if (new Set(pairs.map(([key]) => key)).size !== pairs.length)
          throw new Error('duplicate YAML key');
        result = ['map', pairs.sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0))];
      } else if (isSeq(node)) result = ['seq', node.items.map(value)];
      else if (isScalar(node)) {
        const scalar: unknown = node.value;
        if (typeof scalar === 'bigint') {
          result =
            scalar < -(2n ** 63n) || scalar > 2n ** 64n - 1n
              ? ['float', String(Number(scalar))]
              : ['integer', String(scalar)];
        } else result = [typeof scalar === 'number' ? 'float' : typeof scalar, String(scalar)];
      } else throw new Error('unreadable YAML');
      // serde_yaml preserves custom tags, while standard YAML tags select
      // the scalar/collection type. Plain toJS would lose that distinction.
      if (
        (isScalar(node) || isMap(node) || isSeq(node)) &&
        node.tag &&
        !node.tag.startsWith('tag:yaml.org,2002:')
      )
        result = ['tag', node.tag.replace(/^!/, ''), result];
      active.delete(node);
      return JSON.stringify(result);
    };
    // Validate the whole document, including recursive aliases outside the
    // protected fields, as serde_yaml does before producing a Mapping.
    value(parsed.contents);
    const root = isAlias(parsed.contents) ? parsed.contents.resolve(parsed) : parsed.contents;
    if (!isMap(root)) return {};
    return Object.fromEntries(
      root.items.flatMap((pair) => {
        const key = isAlias(pair.key) ? pair.key.resolve(parsed) : pair.key;
        return isScalar(key) &&
          typeof key.value === 'string' &&
          (!key.tag || key.tag === 'tag:yaml.org,2002:str')
          ? [[key.value, value(pair.value)]]
          : [];
      }),
    );
  } catch {
    return {};
  }
}
/** Absence and an explicit null are distinct; malformed YAML carries no keys. */
export function stampRefusal(before: string, after: string): string | null {
  const old = stampFields(before),
    next = stampFields(after);
  const changed = IMPORT_SOURCES.agent_guard.filter(
    (key) => Object.hasOwn(old, key) !== Object.hasOwn(next, key) || old[key] !== next[key],
  );
  return changed.length ? importWords('stamp_refusal', { keys: changed.join(', ') }) : null;
}
