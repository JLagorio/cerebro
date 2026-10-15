/** Root-relative bytes contract shared with Rust; this module never reads a file. */
import RAW from '../../shared/files/bytes.v1.json';
import type { BytesDoor, FileKind, OpenPolicy } from './fileKinds';

const CODES = [
  'bad_address',
  'folder',
  'no_such_root',
  'not_found',
  'outside',
  'too_large',
  'wrong_door',
] as const;
export type FileRefusalCode = (typeof CODES)[number];
export interface FileRefusal {
  code: FileRefusalCode;
  message: string;
}
export interface FileProbe {
  size: number;
  mime: string;
  kind: FileKind;
  door: BytesDoor;
  sniff: 'text' | 'binary';
  open: OpenPolicy;
}
export interface BytesRules {
  format: number;
  scheme: string;
  host: string;
  vault_root: string;
  revision_key: string;
  limits: {
    body_bytes: number;
    range_bytes: number;
    rel_bytes: number;
    root_bytes: number;
    link_hops: number;
    revision_bytes: number;
  };
  refusals: Record<FileRefusalCode, string>;
  cases: readonly unknown[];
  files: readonly unknown[];
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...names].sort().join(',');
}
/** Refuse an incomplete artifact at import, rather than widening a reader. */
export function parseBytesRules(value: unknown): BytesRules {
  if (
    !record(value) ||
    !keys(value, [
      'format',
      'scheme',
      'host',
      'vault_root',
      'revision_key',
      'limits',
      'refusals',
      'cases',
      'files',
    ]) ||
    value.format !== 1 ||
    value.scheme !== 'cerebro-file' ||
    value.host !== 'localhost' ||
    value.vault_root !== '0' ||
    value.revision_key !== 'v' ||
    !record(value.limits) ||
    !keys(value.limits, [
      'body_bytes',
      'range_bytes',
      'rel_bytes',
      'root_bytes',
      'link_hops',
      'revision_bytes',
    ]) ||
    !Object.values(value.limits).every(
      (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0,
    ) ||
    Number(value.limits.range_bytes) > Number(value.limits.body_bytes) ||
    !record(value.refusals) ||
    !keys(value.refusals, CODES) ||
    !Object.values(value.refusals).every((v) => typeof v === 'string' && v.length > 0) ||
    !Array.isArray(value.cases) ||
    !Array.isArray(value.files)
  )
    throw new Error('Invalid shared file bytes rules');
  return value as unknown as BytesRules;
}
export const FILE_BYTES = parseBytesRules(RAW);
export const VAULT_ROOT = FILE_BYTES.vault_root;
export function fileRefusal(code: FileRefusalCode): FileRefusal {
  return { code, message: FILE_BYTES.refusals[code] };
}
export function isFileRefusal(value: unknown): value is FileRefusal {
  return (
    record(value) &&
    CODES.includes(value.code as FileRefusalCode) &&
    typeof value.message === 'string'
  );
}
/** UTF-8 length without DOM TextEncoder; unpaired UTF-16 has no valid file address. */
function utf8Length(value: string): number | null {
  let bytes = 0;
  for (const c of value) {
    const n = c.codePointAt(0)!;
    if (n >= 0xd800 && n <= 0xdfff) return null;
    bytes += n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4;
  }
  return bytes;
}
export function relRefusal(root: string, rel: string): FileRefusal | null {
  const length = utf8Length(rel);
  if (
    !/^[A-Za-z0-9_-]+$/.test(root) ||
    root.length > FILE_BYTES.limits.root_bytes ||
    length === null ||
    length === 0 ||
    length > FILE_BYTES.limits.rel_bytes ||
    rel.includes('\\') ||
    [...rel].some(
      (c) => c.charCodeAt(0) <= 31 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
    ) ||
    /^[a-z]:/i.test(rel) ||
    rel.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    return fileRefusal('bad_address');
  return null;
}
function segment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
/** Revision changes only WebKit's resource cache key; it grants no file access. */
export function fileUrlFor(root: string, rel: string, revision?: string): string | FileRefusal {
  const refusal = relRefusal(root, rel);
  if (refusal !== null) return refusal;
  if (
    revision !== undefined &&
    (!/^[A-Za-z0-9_-]+$/.test(revision) || revision.length > FILE_BYTES.limits.revision_bytes)
  )
    return fileRefusal('bad_address');
  const address = `${FILE_BYTES.scheme}://${FILE_BYTES.host}/${segment(root)}/${rel.split('/').map(segment).join('/')}`;
  return revision === undefined ? address : `${address}?${FILE_BYTES.revision_key}=${revision}`;
}
