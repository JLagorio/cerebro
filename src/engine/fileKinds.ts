/**
 * File kinds (M66.1): `shared/files/kinds.v1.json`, which Rust's
 * `src-tauri/src/files/kinds.rs` reads too. One row per extension says what
 * the file is (kind, MIME), how the app shows it (viewer, Shiki language,
 * icon, colour), whether the Inbox takes it (ingest) and, for Rust alone, how
 * its bytes reach the webview and whether it may open outside the app.
 *
 * Both readers refuse a malformed table in the same words and replay
 * `src-tauri/fixtures/file-kind-cases.json` (D3). TS never reads `open` or
 * `bytes`: only Rust enforces them.
 */

import RAW from '../../shared/files/kinds.v1.json';

export const KINDS_PATH = 'shared/files/kinds.v1.json';
export const KINDS_DIGEST_PATH = 'shared/files/kinds.v1.sha256';
export const KINDS_FORMAT = 1;

// The closed vocabularies; the Rust reader keeps the same lists.
const KIND_WORDS = [
  'archive',
  'audio',
  'binary',
  'code',
  'data',
  'design',
  'diagram',
  'document',
  'executable',
  'font',
  'image',
  'markdown',
  'pdf',
  'presentation',
  'spreadsheet',
  'text',
  'unknown',
  'video',
] as const;
const VIEWERS = ['code', 'doc', 'image', 'media', 'none', 'pdf', 'table'] as const;
const EXTRACTORS = ['docx', 'pdf', 'pptx', 'xlsx'] as const;
const INGESTS = ['capture', 'extract', 'none'] as const;
const DOORS = ['scheme', 'ipc', 'none'] as const;
const OPENS = ['allow', 'confirm', 'deny'] as const;
const COLORS = [
  'blue',
  'green',
  'n-400',
  'n-500',
  'orange',
  'pink',
  'purple',
  'red',
  'yellow',
] as const;

export type FileKind = (typeof KIND_WORDS)[number];
export type Viewer = (typeof VIEWERS)[number];
export type Extractor = (typeof EXTRACTORS)[number];
export type Ingest = (typeof INGESTS)[number];
export type BytesDoor = (typeof DOORS)[number];
export type OpenPolicy = (typeof OPENS)[number];
export type KindColor = (typeof COLORS)[number];

/** One extension's facts, as the artifact states them. */
export interface KindRow {
  ext: string;
  kind: FileKind;
  mime: string;
  viewer: Viewer;
  extractor: Extractor | null;
  ingest: Ingest;
  shiki: string | null;
  icon: string;
  color: KindColor | null;
  bytes: BytesDoor;
  open: OpenPolicy;
}

/** An exact filename's presentation override: only the keys it states. */
export interface NameRow {
  name: string;
  icon?: string;
  color?: KindColor | null;
  shiki?: string | null;
}

export interface KindTable {
  format: number;
  artifact_version: number;
  limits: { capture_max_bytes: number };
  unknown: Omit<KindRow, 'ext'>;
  kinds: KindRow[];
  names: NameRow[];
}

const TOP_KEYS = ['format', 'artifact_version', 'limits', 'unknown', 'kinds', 'names'];
const LIMIT_KEYS = ['capture_max_bytes'];
const ROW_KEYS = [
  'ext',
  'kind',
  'mime',
  'viewer',
  'extractor',
  'ingest',
  'shiki',
  'icon',
  'color',
  'bytes',
  'open',
];
const UNKNOWN_KEYS = ROW_KEYS.slice(1);
const NAME_KEYS = ['name', 'icon', 'color', 'shiki'];
const NULLABLE = new Set(['extractor', 'shiki', 'color']);
const VOCAB: Record<string, readonly string[]> = {
  kind: KIND_WORDS,
  viewer: VIEWERS,
  extractor: EXTRACTORS,
  ingest: INGESTS,
  bytes: DOORS,
  open: OPENS,
  color: COLORS,
};
const VOCAB_ORDER = ['kind', 'viewer', 'extractor', 'ingest', 'bytes', 'open', 'color'];
const EXT = /^[a-z0-9]+$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const UNKNOWN_ROW: Omit<KindRow, 'ext'> = {
  kind: 'unknown',
  mime: 'application/octet-stream',
  viewer: 'code',
  extractor: null,
  ingest: 'none',
  shiki: null,
  icon: 'file',
  color: null,
  bytes: 'none',
  open: 'confirm',
};

type Json = Record<string, unknown>;

const fail = (message: string): never => {
  throw new Error(`kinds: ${message}`);
};

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** ASCII lowercase only, as Rust's `to_ascii_lowercase`: `İ` and `K` stay. */
const asciiLower = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** Byte order for ASCII, which is all the sorted keys may hold in practice. */
const before = (a: string, b: string): boolean => a < b;

function object(v: unknown, where: string): Json {
  if (!isObject(v)) fail(`${where} must be an object`);
  return v as Json;
}

/** Missing keys in the expected order first, then unknown keys sorted. */
function keys(o: Json, where: string, required: string[], allowed: string[]): void {
  for (const k of required) if (!Object.hasOwn(o, k)) fail(`${where} is missing ${k}`);
  const stray = Object.keys(o)
    .filter((k) => !allowed.includes(k))
    .sort();
  if (stray.length > 0) fail(`${where} has an unknown field ${stray[0]}`);
}

function strings(o: Json, where: string, fields: string[]): void {
  for (const f of fields) {
    if (!Object.hasOwn(o, f)) continue;
    const v = o[f];
    if (NULLABLE.has(f)) {
      if (v !== null && typeof v !== 'string') fail(`${where} ${f} must be a string or null`);
    } else if (typeof v !== 'string') {
      fail(`${where} ${f} must be a string`);
    }
  }
}

function vocab(o: Json, label: string): void {
  for (const f of VOCAB_ORDER) {
    if (!Object.hasOwn(o, f)) continue;
    const v = o[f];
    if (v === null && NULLABLE.has(f)) continue;
    if (!VOCAB[f].includes(v as string)) fail(`${label} has an unknown ${f} ${String(v)}`);
  }
}

function notEmpty(o: Json, label: string): void {
  if (o.icon === '') fail(`${label} has an empty icon`);
  if (o.shiki === '') fail(`${label} has an empty shiki`);
}

function positive(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** Parse and check a table, refusing in the words `files/kinds.rs` uses. */
export function parseKinds(raw: unknown): KindTable {
  const top = object(raw, 'the table');
  keys(top, 'the table', TOP_KEYS, TOP_KEYS);
  if (top.format !== KINDS_FORMAT) {
    fail(`format must be ${KINDS_FORMAT}, not ${JSON.stringify(top.format)}`);
  }
  if (!positive(top.artifact_version)) fail('artifact_version must be a positive integer');

  const limits = object(top.limits, 'limits');
  keys(limits, 'limits', LIMIT_KEYS, LIMIT_KEYS);
  for (const k of LIMIT_KEYS) {
    if (!positive(limits[k])) fail(`limits ${k} must be a positive integer`);
  }

  const unknown = object(top.unknown, 'unknown');
  keys(unknown, 'unknown', UNKNOWN_KEYS, UNKNOWN_KEYS);
  strings(unknown, 'unknown', UNKNOWN_KEYS);
  if (UNKNOWN_KEYS.some((k) => unknown[k] !== UNKNOWN_ROW[k as keyof typeof UNKNOWN_ROW])) {
    fail(
      'the unknown row must be kind unknown, application/octet-stream, viewer code, no extractor, ingest none, no shiki, icon file, no color, bytes none, open confirm',
    );
  }

  if (!Array.isArray(top.kinds)) fail('kinds must be a list');
  let prev: string | null = null;
  (top.kinds as unknown[]).forEach((value, i) => {
    const row = object(value, `kinds[${i}]`);
    const where = typeof row.ext === 'string' ? row.ext : `kinds[${i}]`;
    keys(row, where, ROW_KEYS, ROW_KEYS);
    strings(row, where, ROW_KEYS);
    const ext = row.ext as string;
    if (!EXT.test(ext)) fail(`ext ${ext} must match ^[a-z0-9]+$`);
    if (prev !== null && ext === prev) fail(`ext ${ext} is listed twice`);
    if (prev !== null && !before(prev, ext)) fail(`ext ${ext} is out of order`);
    prev = ext;
    vocab(row, ext);
    if (!MIME.test(row.mime as string)) {
      fail(`${ext} mime ${String(row.mime)} is not a lowercase type/subtype`);
    }
    notEmpty(row, ext);
    const kind = row.kind as FileKind;
    if (row.bytes === 'scheme' && !['image', 'audio', 'video'].includes(kind)) {
      fail(`${ext} serves bytes by scheme but is not an image, audio or video`);
    }
    if (row.bytes === 'ipc' && kind !== 'pdf') fail(`${ext} serves bytes by ipc but is not a pdf`);
    if (row.ingest === 'capture' && kind !== 'markdown' && kind !== 'text') {
      fail(`${ext} is captured but is not markdown or text`);
    }
    if (row.ingest === 'extract' && row.extractor === null) {
      fail(`${ext} is extracted but names no extractor`);
    }
    if (
      row.extractor !== null &&
      !['pdf', 'document', 'presentation', 'spreadsheet'].includes(kind)
    ) {
      fail(`${ext} names an extractor but is not a pdf, document, presentation or spreadsheet`);
    }
  });

  if (!Array.isArray(top.names)) fail('names must be a list');
  let prevName: string | null = null;
  (top.names as unknown[]).forEach((value, i) => {
    const row = object(value, `names[${i}]`);
    const where = typeof row.name === 'string' ? row.name : `names[${i}]`;
    keys(row, where, ['name'], NAME_KEYS);
    strings(row, where, NAME_KEYS);
    const name = row.name as string;
    if (name === '' || name !== asciiLower(name) || name.includes('/')) {
      fail(`name ${name} must be lowercase with no slash`);
    }
    if (prevName !== null && name === prevName) fail(`name ${name} is listed twice`);
    if (prevName !== null && !before(prevName, name)) fail(`name ${name} is out of order`);
    prevName = name;
    if (
      !Object.hasOwn(row, 'icon') &&
      !Object.hasOwn(row, 'color') &&
      !Object.hasOwn(row, 'shiki')
    ) {
      fail(`name ${name} overrides nothing`);
    }
    vocab(row, name);
    notEmpty(row, name);
  });

  return top as unknown as KindTable;
}

/** The compiled-in table. */
export const KINDS: KindTable = parseKinds(RAW);

const BY_EXT = new Map(KINDS.kinds.map((row) => [row.ext, row]));
const BY_NAME = new Map(KINDS.names.map((row) => [row.name, row]));

/** The last path segment, ASCII-lowercased. */
function baseName(path: string): string {
  return asciiLower(path.slice(path.lastIndexOf('/') + 1));
}

/**
 * The extension: the last segment's tail after its last dot, ASCII-lowercased.
 * None when there is no dot, or the dot is the first or last character
 * (`.env`, `notes.`). Rust's `ext_of` says the same.
 */
export function extOf(path: string): string | null {
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1);
}

/** The row for a path's extension, or the unknown row. */
export function kindFor(path: string): Omit<KindRow, 'ext'> & { ext: string | null } {
  const ext = extOf(path);
  const row = ext === null ? undefined : BY_EXT.get(ext);
  return row ?? { ...KINDS.unknown, ext: null };
}

/** How a file is drawn: the filename override first, then its row, then unknown. */
export function fileLook(name: string): { icon: string; color: KindColor | null } {
  const row = kindFor(name);
  const named = BY_NAME.get(baseName(name));
  return {
    icon: named?.icon ?? row.icon,
    color: named !== undefined && 'color' in named ? (named.color ?? null) : row.color,
  };
}

/** The Shiki language id, or null to render as plain text. */
export function shikiFor(path: string): string | null {
  const named = BY_NAME.get(baseName(path));
  if (named !== undefined && 'shiki' in named) return named.shiki ?? null;
  return kindFor(path).shiki;
}

/** The extensions the Inbox captures as text, sorted. */
export function captureExtensions(): string[] {
  return KINDS.kinds.filter((row) => row.ingest === 'capture').map((row) => row.ext);
}

/** Whether the Inbox captures this file as text. */
export function isCapturable(name: string): boolean {
  return kindFor(name).ingest === 'capture';
}

/** The largest file the Inbox captures. */
export const CAPTURE_MAX_BYTES: number = KINDS.limits.capture_max_bytes;
