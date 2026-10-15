import { parse, stringify } from 'yaml';

/** A whiteboard fence carries a pointer; the scene remains in its own file. */
export const WHITEBOARD_FENCE = 'cerebro-whiteboard';
export interface WhiteboardRef {
  board: string;
  height?: number;
}

/** Invalid and empty fences stay code. The editor may use an empty fence as
 * an unset picker, but a reader never guesses the missing target. */
export function parseWhiteboardRef(body: string): WhiteboardRef | null {
  let raw: unknown;
  try {
    raw = parse(body);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { board, height } = raw as Record<string, unknown>;
  if (
    typeof board !== 'string' ||
    !board.endsWith('.canvas') ||
    board.startsWith('/') ||
    board.includes('\\') ||
    board.split('/').some((part) => part === '..' || part === '' || part === '.') ||
    [...board].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return null;
  if (
    height !== undefined &&
    (typeof height !== 'number' || !Number.isInteger(height) || height < 160 || height > 1200)
  )
    return null;
  return height === undefined ? { board } : { board, height };
}

export function serializeWhiteboardRef(ref: WhiteboardRef): string {
  return stringify(
    ref.height === undefined ? { board: ref.board } : { board: ref.board, height: ref.height },
    { lineWidth: 0 },
  ).trimEnd();
}
