import type { OpenTab } from '@/engine/editorGroups';

/**
 * What is currently being dragged, held in a module variable rather than read
 * back out of `DataTransfer` on drop.
 *
 * Not a shortcut: `DataTransfer.getData` is deliberately EMPTY during
 * `dragover` in every browser (the drag data store is in "protected mode"
 * until the drop), so the strip could not decide whether an incoming drag is
 * even a tab — let alone which one — if it had to ask the event. jsdom
 * implements no drag data store at all, so a test could not either.
 *
 * The payload is still written to `DataTransfer` as `text/plain` so that
 * dragging a tab into any other application yields its path.
 */
let payload: TabDrag | null = null;

export interface TabDrag {
  tab: OpenTab;
  fromGroupId: string;
}

export const beginTabDrag = (drag: TabDrag): void => {
  payload = drag;
};

export const currentTabDrag = (): TabDrag | null => payload;

export const endTabDrag = (): void => {
  payload = null;
};

/**
 * Which slot a drop over this tab lands in.
 *
 * Past the midpoint means "after me", which is the convention every tab strip
 * and file manager shares, and the only one where the insertion line you see
 * matches where the tab arrives.
 */
export function dropSlot(index: number, pointerX: number, box: DOMRect): number {
  return pointerX > box.left + box.width / 2 ? index + 1 : index;
}

/** Where in a pane a drop landed. The edges split; the middle just moves. */
export type DropZone = 'left' | 'center' | 'right';

/**
 * How much of a pane's width each edge claims.
 *
 * A quarter is wide enough to hit without aiming and narrow enough that the
 * middle still reads as "into this pane" — the same proportion VS Code uses,
 * for the same reason.
 */
export const EDGE_RATIO = 0.25;

export function zoneFor(pointerX: number, box: DOMRect): DropZone {
  // A pane with no measurable width cannot have edges to aim at.
  if (box.width <= 0) return 'center';
  const across = (pointerX - box.left) / box.width;
  if (across < EDGE_RATIO) return 'left';
  if (across > 1 - EDGE_RATIO) return 'right';
  return 'center';
}
