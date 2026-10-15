import { CAPTURE_MAX_BYTES, IMPORT_MAX_BYTES, kindFor } from '@/engine/fileKinds';
import type { DroppedFile, DroppedText, OsDropEvent } from '@/engine/osDrop';
import { isHiddenName } from '@/engine/trash';

export interface DroppedSeed {
  path: string;
  content?: string;
  base64?: string;
  folder?: boolean;
  size?: number;
}
const outside = new Map<string, DroppedSeed>();
const listeners = new Set<(event: OsDropEvent) => void>();
export function stageDropped(files: readonly DroppedSeed[]): void {
  for (const file of files) outside.set(file.path, { ...file });
}
export function resetDropped(): void {
  outside.clear();
}
export function droppedSeed(path: string): DroppedSeed | undefined {
  return outside.get(path);
}
function bytes(seed: DroppedSeed): Uint8Array {
  return seed.base64 === undefined
    ? new TextEncoder().encode(seed.content ?? '')
    : Uint8Array.from(atob(seed.base64), (c) => c.charCodeAt(0));
}
export async function inspectDropped(paths: readonly string[]): Promise<DroppedFile[]> {
  return paths.map((path) => {
    const seed = path.startsWith('/') ? outside.get(path) : undefined;
    const name = path.split('/').filter(Boolean).at(-1) ?? path;
    return {
      path,
      name,
      kind: seed === undefined ? 'missing' : seed.folder ? 'folder' : 'file',
      size: seed === undefined || seed.folder ? null : (seed.size ?? bytes(seed).length),
      hidden: isHiddenName(name),
    };
  });
}
export async function readDroppedText(path: string): Promise<DroppedText> {
  const seed = path.startsWith('/') ? outside.get(path) : undefined;
  if (seed === undefined) return { kind: 'notFound' };
  if (seed.folder) return { kind: 'folder' };
  const ingest = kindFor(path).ingest;
  if (ingest !== 'capture' && ingest !== 'import') return { kind: 'notText' };
  const limit = ingest === 'import' ? IMPORT_MAX_BYTES : CAPTURE_MAX_BYTES;
  const data = bytes(seed);
  const size = seed.size ?? data.length;
  if (size > limit) return { kind: 'tooLarge', size, limit };
  if (data.includes(0)) return { kind: 'notText' };
  try {
    return { kind: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(data) };
  } catch {
    return { kind: 'notText' };
  }
}
export async function listenOsFileDrop(handler: (event: OsDropEvent) => void): Promise<() => void> {
  // Each subscription has its own identity, as Tauri's event listener does.
  // StrictMode can release an older async registration after a new one starts.
  const receive = (event: OsDropEvent) => handler(event);
  listeners.add(receive);
  return () => {
    listeners.delete(receive);
  };
}
export function emitOsDrop(event: OsDropEvent): void {
  for (const listener of listeners) listener(event);
}
export function mockDrop({
  at,
  files,
  hold = false,
}: {
  at: { x: number; y: number };
  files: readonly DroppedSeed[];
  hold?: boolean;
}): void {
  stageDropped(files);
  const paths = files.map((file) => file.path);
  emitOsDrop({ type: 'enter', paths, position: at });
  emitOsDrop({ type: 'over', position: at });
  if (!hold) emitOsDrop({ type: 'drop', paths, position: at });
}
if (typeof window !== 'undefined') {
  Object.assign(window, {
    __cerebroMockDrop: mockDrop,
    __cerebroMockDragLeave: () => emitOsDrop({ type: 'leave' }),
  });
}

declare global {
  interface Window {
    __cerebroMockDrop: typeof mockDrop;
    __cerebroMockDragLeave: () => void;
  }
}
