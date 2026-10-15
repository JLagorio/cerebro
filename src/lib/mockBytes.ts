/** Browser-only bytes backend. It mirrors the root resolver and byte doors. */
import {
  FILE_BYTES,
  fileRefusal,
  isFileRefusal,
  relRefusal,
  type FileProbe,
  type FileRefusal,
} from '@/engine/fileBytes';
import { kindFor } from '@/engine/fileKinds';
import type { FileText } from '@/engine/roots';
import { filesIn, rootPathFor, MAX_BYTES } from './mockRoots';

interface SeedBytes {
  base64?: string;
  bytes?: readonly number[] | Uint8Array;
  text?: string;
  size?: number;
  executable?: boolean;
  folder?: boolean;
}
interface File {
  bytes: Uint8Array;
  size: number;
  executable: boolean;
  folder: boolean;
}
const roots = new Map<string, Map<string, File | { target: string }>>();
const encoder = new TextEncoder();
export function reset(): void {
  roots.clear();
}
export function resetRootBytes(root: string): void {
  roots.delete(root);
}
function set(root: string, rel: string, file: File | { target: string }): void {
  let map = roots.get(root);
  if (map === undefined) {
    map = new Map();
    roots.set(root, map);
  }
  map.set(rel, file);
}
export function seedBytes(root: string, rel: string, seed: SeedBytes): void {
  const bytes =
    seed.base64 !== undefined
      ? Uint8Array.from(atob(seed.base64), (c) => c.charCodeAt(0))
      : seed.bytes !== undefined
        ? Uint8Array.from(seed.bytes)
        : encoder.encode(seed.text ?? '');
  set(root, rel, {
    bytes,
    size: seed.size ?? bytes.length,
    executable: seed.executable ?? false,
    folder: seed.folder ?? false,
  });
}
/** Targets are root-relative, like the canonical target of a contained symlink. */
export function seedLink(root: string, rel: string, target: string): void {
  set(root, rel, { target });
}
export function byteEntries(root: string): [string, number][] {
  return [...(roots.get(root) ?? [])].map(([path, file]) => [
    path,
    'target' in file ? 0 : file.size,
  ]);
}
/** Placement reads existing raw bytes, never follows a candidate symlink. */
export function storedBytes(root: string, rel: string): Uint8Array | null {
  const file = roots.get(root)?.get(rel);
  return file === undefined || 'target' in file || file.folder ? null : file.bytes.slice();
}
export function isLinkedOrFile(root: string, rel: string): boolean {
  const file = roots.get(root)?.get(rel);
  return file !== undefined && ('target' in file || !file.folder);
}
function locate(root: string, rel: string): { file: File; path: string } | FileRefusal {
  const invalid = relRefusal(root, rel);
  if (invalid !== null) return invalid;
  const rootPath = rootPathFor(root);
  if (rootPath === null) return fileRefusal('no_such_root');
  let path = rel;
  let hops = 0;
  while (true) {
    const parts = path.split('/');
    let linked = false;
    for (let i = 1; i <= parts.length; i++) {
      const candidate = roots.get(root)?.get(parts.slice(0, i).join('/'));
      if (candidate !== undefined && 'target' in candidate) {
        if (++hops > FILE_BYTES.limits.link_hops) return fileRefusal('not_found');
        if (relRefusal(root, candidate.target) !== null) return fileRefusal('outside');
        path = [...candidate.target.split('/'), ...parts.slice(i)].join('/');
        linked = true;
        break;
      }
    }
    if (!linked) break;
  }
  const seeded = roots.get(root)?.get(path);
  if (seeded !== undefined && !('target' in seeded)) {
    return seeded.folder ? fileRefusal('folder') : { file: seeded, path };
  }
  const text = filesIn(rootPath).find(([p]) => p === path)?.[1];
  if (text !== undefined) {
    const bytes = encoder.encode(text);
    return { file: { bytes, size: bytes.length, executable: false, folder: false }, path };
  }
  if (
    [...filesIn(rootPath).map(([p]) => p), ...byteEntries(root).map(([p]) => p)].some((p) =>
      p.startsWith(`${path}/`),
    )
  )
    return fileRefusal('folder');
  return fileRefusal('not_found');
}
/** Browser extraction uses the same contained resolver before its own hidden
 * path/format checks. Borrowed bytes stay read-only at this call boundary. */
export function resolveBytes(
  root: string,
  rel: string,
): { path: string; bytes: Uint8Array; size: number } | FileRefusal {
  const found = locate(root, rel);
  return isFileRefusal(found)
    ? found
    : { path: found.path, bytes: found.file.bytes, size: found.file.size };
}

/** Match Rust's bounded sniff, including a valid UTF-8 code point cut at 8 KiB. */
function sniff(bytes: Uint8Array): 'text' | 'binary' {
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) return 'binary';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return 'text';
  } catch {
    return 'binary';
  }
}
const SIGNS = [
  [35, 33],
  [127, 69, 76, 70],
  [254, 237, 250, 206],
  [254, 237, 250, 207],
  [206, 250, 237, 254],
  [207, 250, 237, 254],
  [202, 254, 186, 190],
  [77, 90],
];
export async function probeFile(root: string, rel: string): Promise<FileProbe | FileRefusal> {
  const found = locate(root, rel);
  if (isFileRefusal(found)) return found;
  const { file, path } = found;
  const row = kindFor(path);
  const deny =
    SIGNS.some((sign) => sign.every((byte, index) => file.bytes[index] === byte)) ||
    (row.ext === null && file.executable);
  return {
    size: file.size,
    mime: row.mime,
    kind: row.kind,
    door: row.bytes,
    sniff: sniff(file.bytes),
    open: deny ? 'deny' : row.open,
  };
}
export async function readFileBytes(root: string, rel: string): Promise<Uint8Array | FileRefusal> {
  const found = locate(root, rel);
  if (isFileRefusal(found)) return found;
  if (kindFor(found.path).bytes !== 'ipc') return fileRefusal('wrong_door');
  if (found.file.size > FILE_BYTES.limits.body_bytes) return fileRefusal('too_large');
  return found.file.bytes.slice();
}
export async function fileUrl(root: string, rel: string): Promise<string | FileRefusal> {
  const found = locate(root, rel);
  if (isFileRefusal(found)) return found;
  const row = kindFor(found.path);
  if (row.bytes !== 'scheme') return fileRefusal('wrong_door');
  if (found.file.size > FILE_BYTES.limits.body_bytes) return fileRefusal('too_large');
  let binary = '';
  for (let offset = 0; offset < found.file.bytes.length; offset += 8192)
    binary += String.fromCharCode(...found.file.bytes.subarray(offset, offset + 8192));
  return `data:${row.mime};base64,${btoa(binary)}`;
}
export async function readText(root: string, rel: string): Promise<FileText> {
  const found = locate(root, rel);
  if (isFileRefusal(found)) return { kind: 'notFound' };
  if (found.file.size > MAX_BYTES)
    return { kind: 'tooLarge', size: found.file.size, limit: MAX_BYTES };
  if (sniff(found.file.bytes) === 'binary') return { kind: 'binary' };
  try {
    return {
      kind: 'text',
      content: new TextDecoder('utf-8', { fatal: true }).decode(found.file.bytes),
    };
  } catch {
    return { kind: 'binary' };
  }
}
if (typeof window !== 'undefined')
  (window as unknown as Record<string, unknown>).__cerebroMockBytes = {
    seedBytes,
    seedLink,
    reset,
  };
