import { kindFor } from './fileKinds';
import type { Entry } from './types';
import type { Board, FileCard, LinkCard, Box } from './scene/model';
import type { Point } from './scene/figure';

export const CARD_SIZES = {
  page: { width: 320, height: 120 },
  file: { width: 320, height: 120 },
  link: { width: 320, height: 120 },
  missing: { width: 320, height: 120 },
  diagram: { width: 320, height: 240 },
  whiteboard: { width: 320, height: 240 },
  image: { width: 320, height: 240 },
} as const;
export type CardFace =
  | { kind: 'link'; pointer: string }
  | { kind: 'page' | 'diagram' | 'whiteboard'; pointer: string; section?: string; entry: Entry }
  | { kind: 'missing' | 'image' | 'file'; pointer: string; section?: string };
export type CardTarget =
  { kind: 'file'; file: string; subpath?: string } | { kind: 'link'; url: string };

/** A file card is an exact path, never a wikilink search or a normalized path.
 * Missing indexed files stay missing until a scan sees that same pointer. */
export function resolveCard(
  node: FileCard | LinkCard,
  index: ReadonlyMap<string, Entry>,
): CardFace {
  if (node.type === 'link') return { kind: 'link', pointer: node.url };
  const pointer = node.file,
    section = node.subpath;
  const entry = index.get(pointer);
  if (entry) {
    const kind = /\.mmd$/i.test(pointer)
      ? 'diagram'
      : /\.canvas$/i.test(pointer)
        ? 'whiteboard'
        : 'page';
    return { kind, pointer, section, entry };
  }
  const kind = /\.(md|mmd|canvas)$/i.test(pointer)
    ? 'missing'
    : kindFor(pointer).kind === 'image'
      ? 'image'
      : 'file';
  return { kind, pointer, section };
}
export function placedPaths(board: Board): Set<string> {
  return new Set(
    [...board.nodes.values()].flatMap((node) => (node.type === 'file' ? [node.file] : [])),
  );
}
/** Centre once, then cascade by 24 until that exact top-left is unoccupied. */
export function placeCard(board: Board, centre: Point, size: Pick<Box, 'width' | 'height'>): Box {
  let x = Math.round(centre.x - size.width / 2),
    y = Math.round(centre.y - size.height / 2);
  const occupied = new Set([...board.nodes.values()].map((node) => `${node.x},${node.y}`));
  while (occupied.has(`${x},${y}`)) {
    x += 24;
    y += 24;
  }
  return { x, y, ...size };
}
