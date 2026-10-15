import { CAPTURE_MAX_BYTES, isCapturable } from './fileKinds';
export interface DroppedFile {
  path: string;
  name: string;
  kind: 'file' | 'folder' | 'missing';
  size: number | null;
  hidden: boolean;
}
export type DroppedText =
  | { kind: 'text'; content: string }
  | { kind: 'tooLarge'; size: number; limit: number }
  | { kind: 'notText' | 'notFound' | 'folder' };
export type OsDropEvent =
  | { type: 'enter' | 'drop'; paths: readonly string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'leave' };
export type OsDropKind = 'inbox' | 'files-field' | 'editor';
export const NO_DROP_ZONE = 'Drop files on the Inbox, a Files property, or a page.';
export function droppedReason(file: DroppedFile, capture = false): string | null {
  if (file.hidden) return 'a hidden file';
  if (file.kind === 'folder') return 'a folder';
  if (file.kind === 'missing') return 'could not be read';
  if (capture && !isCapturable(file.name)) return 'not a text file';
  if (capture && file.size !== null && file.size > CAPTURE_MAX_BYTES) return 'too large';
  return null;
}
export function droppedTextReason(read: Exclude<DroppedText, { kind: 'text' }>): string {
  if (read.kind === 'folder') return 'a folder';
  if (read.kind === 'tooLarge') return 'too large';
  if (read.kind === 'notText') return 'not a text file';
  return 'could not be read';
}
