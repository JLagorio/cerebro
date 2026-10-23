import { MAX_PANES } from '@/engine/panes';
import {
  CANVAS_MIN_WIDTH,
  DOC_COLUMN_MIN_WIDTH,
  DOC_PAGES_MIN_WIDTH,
  DOC_PANEL_MIN_WIDTH,
  DOC_PANEL_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '@/stores/uiStore';

/**
 * How the right-hand panels share the canvas row (M52).
 *
 * The record panel's stored width used to be drawn verbatim. The record and
 * the assistant were both `flex-none` inside a slot capped at
 * `100% - CANVAS_MIN_WIDTH`, so whenever the two came to more than that cap
 * the slot's `overflow-hidden` cut off whichever was drawn last — the
 * assistant, outboard of the record. Widening the record did it every time:
 * at 1440px its « control left the assistant entirely off-screen, and at
 * 1280px the default widths already clipped 300px of it.
 *
 * When the row runs short, things give way in this order:
 *   1. the canvas, down to CANVAS_MIN_WIDTH (it is `flex-1`, so flex does it);
 *   2. the record, down to RIGHT_PANEL_MIN_WIDTH;
 *   3. the sidebar, down to SIDEBAR_WIDTH_MIN (`mainColumnFloor`);
 *   4. panes beyond the focused one park, least recently focused first;
 *   5. the assistant, down to RIGHT_PANEL_MIN_WIDTH;
 *   6. below SHELL_TWO_PANEL_MIN the sidebar steps down to its rail;
 *   7. below SHELL_RAIL_TWO_PANEL_MIN the assistant is parked (`shellPlan`),
 *      and the sidebar has its column back;
 *   8. below SHELL_PARKED_COLUMN_MIN the sidebar takes its rail again, or
 *      the parked assistant's tab is pushed off the window's edge.
 *
 * These steps are CSS, so a window drag settles in one layout pass: the record
 * is the one panel in the slot that shrinks, the assistant is capped at the
 * slot less the record's floor, and steps 6 to 8 are media queries
 * (`SHELL_CLASSES`). Anything React decides from a measurement or a
 * `matchMedia` listener lands a frame after the window has been drawn at its
 * new size, and for that frame the slot clipped the assistant — at 1300→1000
 * it was drawn 80px wide with Send past the window's edge, and WebKit, the
 * engine the app ships on, drew the old plan at every threshold crossing.
 * The arithmetic below is the same rule, measured, for what CSS cannot say —
 * a drag handle's range, the widen control's label, `inert`.
 *
 * A page with its own side panel open (a doc, a concept, a record's full
 * page) asks the sidebar for that panel's width too, so the sidebar gives
 * before the page's reading column does. Inside the page `pageAsides`
 * decides the rest.
 */

/** M71's persistent application rail, beside the contextual sidebar. */
export const SIDEBAR_RAIL_WIDTH = 54;

/** The flush shell has no outside gutter or horizontal border. Keep the
 * frame budget explicit: every available pixel belongs to navigation or content. */
export const SHELL_FRAME_GUTTER = 0;
export const SHELL_FRAME_BORDER = 0;
const SHELL_FRAME_CHROME = SHELL_FRAME_GUTTER + SHELL_FRAME_BORDER;

/** The parked assistant's tab on the canvas row's right edge (M52). */
export const PARKED_TAB_WIDTH = 32;

/** The focused pane, record and assistant, each at its floor. */
const TWO_PANEL_ROW = CANVAS_MIN_WIDTH + 2 * RIGHT_PANEL_MIN_WIDTH;

/**
 * Window widths at which a record and the assistant are both drawn (M17.2),
 * one per way the sidebar can be drawn beside them: at its floor, as its
 * rail, and collapsed by the user (rail only).
 *
 * 54 + 180 + 400 + 2 × 320 = 1274 for a sidebar column. The flush shell
 * reserves no outside frame, so all remaining width belongs to content.
 *
 * `SHELL_CLASSES` spells these out as literal Tailwind classes, because the
 * class scanner reads source text and cannot see an interpolated number;
 * shellLayout.test.ts holds the two to the same values.
 */
export const SHELL_TWO_PANEL_MIN =
  SIDEBAR_RAIL_WIDTH + SIDEBAR_WIDTH_MIN + TWO_PANEL_ROW + SHELL_FRAME_CHROME;
export const SHELL_RAIL_TWO_PANEL_MIN = SIDEBAR_RAIL_WIDTH + TWO_PANEL_ROW + SHELL_FRAME_CHROME;
export const SHELL_BARE_TWO_PANEL_MIN = SIDEBAR_RAIL_WIDTH + TWO_PANEL_ROW + SHELL_FRAME_CHROME;

/**
 * The window width at which a sidebar column still fits beside a record and
 * the parked assistant's tab: 54 + 180 + 400 + 320 + 32 = 986. Tauri lets
 * the window go to 900, and in between the tab was the one thing left to
 * give — a 20px sliver of it at 920, nothing at 900 — so under this the
 * sidebar takes its rail instead.
 */
export const SHELL_PARKED_COLUMN_MIN =
  SIDEBAR_RAIL_WIDTH +
  SIDEBAR_WIDTH_MIN +
  CANVAS_MIN_WIDTH +
  RIGHT_PANEL_MIN_WIDTH +
  PARKED_TAB_WIDTH +
  SHELL_FRAME_CHROME;

/** Which of those widths the window clears. */
export interface ShellRoom {
  column: boolean;
  rail: boolean;
  bare: boolean;
  /** A sidebar column, a record and the parked tab (SHELL_PARKED_COLUMN_MIN). */
  parkedColumn: boolean;
}

/** The room a window `width` px wide has — App asks the same of media queries. */
export function roomAt(width: number): ShellRoom {
  return {
    column: width >= SHELL_TWO_PANEL_MIN,
    rail: width >= SHELL_RAIL_TWO_PANEL_MIN,
    bare: width >= SHELL_BARE_TWO_PANEL_MIN,
    parkedColumn: width >= SHELL_PARKED_COLUMN_MIN,
  };
}

/** How the shell draws the sidebar and the assistant. */
export interface ShellPlan {
  /** `collapsed` hides the context panel by choice; `rail` hides it for space. */
  sidebar: 'column' | 'rail' | 'collapsed';
  /** `parked` is open but not drawn: still mounted, still streaming. */
  assistant: 'drawn' | 'parked' | 'closed';
}

/** What the shell's plan is asked of. */
export interface ShellState {
  /** A record is open in the peek. */
  detail: boolean;
  /** The assistant is open (drawn or not). */
  assistant: boolean;
  /** The user collapsed the sidebar. */
  collapsed: boolean;
  /**
   * The rail was showing when the window went under SHELL_RAIL_TWO_PANEL_MIN
   * (`nextRailLatch`), so it stays rather than growing back into a column.
   */
  railLatched: boolean;
}

/**
 * Whether a record and the assistant both fit, and what gives so they do (M52).
 *
 * M17.2's rule stands: when only one fits the RECORD wins — something just
 * asked for it to be seen, and that is the newer intent. What changed is how
 * soon it comes to that. The assistant used to park the moment the window
 * was under its two-panel floor, silently. Now the sidebar steps down to its rail first,
 * which keeps both panels down to 1094, and below that the assistant parks
 * behind a tab that says so.
 *
 * The rail is taken only when it keeps something on screen. Below 1094 it
 * no longer keeps the assistant, so the sidebar keeps its column at the
 * largest width that fits beside the parked tab, without changing the
 * stored preference — unless the rail was already showing as the window shrank past 1094
 * (`railLatched`), when growing it back into a column would be a jump the
 * other way. Under 986 the column does not leave room for the parked tab,
 * and the rail is what keeps THAT on screen, so it is taken again. Like a
 * parked assistant, the rail is derived: the stored collapsed flag is never
 * written, and the sidebar comes back the moment there is room or no record.
 */
export function shellPlan({
  detail,
  assistant,
  collapsed,
  railLatched,
  room,
}: ShellState & { room: ShellRoom }): ShellPlan {
  const sidebar = collapsed ? 'collapsed' : 'column';
  if (!assistant) return { sidebar, assistant: 'closed' };
  if (!detail) return { sidebar, assistant: 'drawn' };
  if (collapsed) return { sidebar, assistant: room.bare ? 'drawn' : 'parked' };
  if (room.column) return { sidebar: 'column', assistant: 'drawn' };
  if (room.rail) return { sidebar: 'rail', assistant: 'drawn' };
  const rail = railLatched || !room.parkedColumn;
  return { sidebar: rail ? 'rail' : 'column', assistant: 'parked' };
}

/**
 * The latch `shellPlan` reads, one render on: set while the rail is what
 * keeps both panels (1094–1273), cleared by anything that does away with the
 * rail, and held below 1094, where the window no longer says. The rail under
 * 986 sets nothing: the window says there, and the column is back the moment
 * it fits beside the tab.
 */
export function nextRailLatch(
  latched: boolean,
  { detail, assistant, collapsed, room }: Omit<ShellState, 'railLatched'> & { room: ShellRoom },
): boolean {
  if (!detail || !assistant || collapsed || room.column) return false;
  return room.rail ? true : latched;
}

/**
 * The media-query half of `shellPlan`: which way the window's width goes,
 * left to CSS so it is decided in the same layout pass as the width itself.
 *
 * - `rail` — `band`: the rail in 1094–1273, where it keeps both panels, and
 *   under 986, where it keeps the parked tab (the column between, the
 *   assistant parked); `below`: the rail anywhere under 1274 (latched);
 *   `none`: no rail at all.
 * - `park` — the width under which the assistant parks: 1094 beside a sidebar
 *   (column or rail), 1094 beside a user-collapsed one; `never` with no
 *   record or no assistant, when there is nothing to choose between.
 */
export interface ShellBands {
  rail: 'none' | 'band' | 'below';
  park: 'never' | 'rail' | 'bare';
}

export function shellBands({ detail, assistant, collapsed, railLatched }: ShellState): ShellBands {
  if (!detail || !assistant) return { rail: 'none', park: 'never' };
  if (collapsed) return { rail: 'none', park: 'bare' };
  return { rail: railLatched ? 'below' : 'band', park: 'rail' };
}

/**
 * `shellBands` as classes, with the thresholds written out (see
 * SHELL_TWO_PANEL_MIN for why they are literals). Tailwind's `max-[N]` is
 * `width < N` and `min-[N]` is `width >= N`, the same edges as `roomAt`.
 *
 * Parked is a strip of zero width that clips the panel, never `display:
 * none`, and `max-w-none` on the panel keeps it at its own width inside the
 * strip: the transcript keeps its line breaks and its scroll position, and
 * comes back where the user left it. `invisible` takes it out of the tab
 * order and the accessibility tree in the same pass; App adds `inert` once
 * React has caught up.
 */
export const SHELL_CLASSES = {
  rail: {
    none: { column: '', rail: 'hidden' },
    band: {
      column: 'min-[1094px]:max-[1274px]:hidden max-[986px]:hidden',
      rail: 'hidden min-[1094px]:max-[1274px]:flex max-[986px]:flex',
    },
    below: { column: 'max-[1274px]:hidden', rail: 'hidden max-[1274px]:flex' },
  },
  park: {
    never: { frame: '', tab: 'hidden', floor: '' },
    rail: {
      frame:
        'max-[1094px]:invisible max-[1094px]:w-0 max-[1094px]:overflow-hidden max-[1094px]:*:max-w-none',
      tab: 'hidden max-[1094px]:flex',
      floor: 'max-[1094px]:min-w-[var(--shell-floor-parked)]',
    },
    bare: {
      frame:
        'max-[1094px]:invisible max-[1094px]:w-0 max-[1094px]:overflow-hidden max-[1094px]:*:max-w-none',
      tab: 'hidden max-[1094px]:flex',
      floor: 'max-[1094px]:min-w-[var(--shell-floor-parked)]',
    },
  },
} as const;

/** The widest each right-hand panel may be drawn, in px. */
export interface PanelRooms {
  detail: number;
  assistant: number;
}

/**
 * A stored panel width is a preference: drawn at most `room`, and never
 * under the panel floor — below that the layout has run out, and parking the
 * assistant (not squeezing a panel to nothing) is how the shell says so.
 */
export function fitWidth(preferred: number, room: number): number {
  return Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(preferred, room));
}

/**
 * The room each panel has in a canvas row `row` px wide.
 *
 * The assistant is sized first because it keeps its own width: beside a
 * record it gives up only what the record's floor needs. The record gets the
 * rest, which is what makes a wide record shrink instead of shoving the
 * assistant past the window's edge.
 */
export function panelRooms({
  row,
  detail,
  assistant,
  assistantWidth,
  parked = false,
}: {
  /** The canvas row's measured width. */
  row: number;
  /** Whether each panel is DRAWN — a parked assistant takes no room. */
  detail: boolean;
  assistant: boolean;
  /** The assistant's stored width. */
  assistantWidth: number;
  /** The assistant is parked: only its tab takes room. */
  parked?: boolean;
}): PanelRooms {
  const beside = row - CANVAS_MIN_WIDTH - (parked ? PARKED_TAB_WIDTH : 0);
  const assistantRoom = beside - (detail ? RIGHT_PANEL_MIN_WIDTH : 0);
  const assistantDrawn = assistant ? fitWidth(assistantWidth, assistantRoom) : 0;
  return { detail: beside - assistantDrawn, assistant: assistantRoom };
}

/**
 * The ceiling a panel's drag handle clamps to: the widest the panel can be
 * DRAWN — its own maximum, fitted to the room it has. So a drag can never
 * widen a panel past the room left beside the assistant, and the width it
 * stores is one it was drawn at. Its floor is the drawn floor
 * (RIGHT_PANEL_MIN_WIDTH), not the panel's drag minimum: a ceiling above the
 * drawn width stored a width nobody had seen (drawn 320, stored 360).
 * Unmeasured (`null`) leaves the panel's own maximum.
 */
export function dragCeiling(room: number | null, max: number): number {
  return room === null ? max : fitWidth(max, room);
}

/**
 * The main column's floor, as CSS: every pane's floor, the focused page's side
 * panel, the record's floor, and the assistant's whole width — flex takes any
 * shortfall out of the sidebar, so the sidebar gives before the assistant
 * does, and before a page's reading column does. Capped at what the window
 * can hold beside a minimum sidebar, because a floor wider than that would
 * push the whole right edge out of the window. The flush frame reserves no
 * extra width outside the content; the viewport cap counts navigation once.
 */
export function mainColumnFloor(panels: FloorPanels): string {
  return `min(${mainColumnFloorPx(panels) + SHELL_FRAME_BORDER}px, 100vw - ${SIDEBAR_WIDTH_MIN + SIDEBAR_RAIL_WIDTH + SHELL_FRAME_GUTTER}px)`;
}

/** What the main column's floor counts. */
export interface FloorPanels {
  detail: boolean;
  /** The assistant is DRAWN. */
  assistant: boolean;
  assistantWidth: number;
  /** Whether the page on the canvas has its own side panel open. */
  pageAside?: boolean;
  /** The assistant is parked, and its tab takes a strip of the row. */
  parked?: boolean;
  panes?: number;
}

/** The uncapped content floor. */
export function mainColumnFloorPx({
  detail,
  assistant,
  assistantWidth,
  pageAside = false,
  parked = false,
  panes = 1,
}: FloorPanels): number {
  return (
    paneRowFloor(panes) +
    (pageAside ? DOC_PANEL_WIDTH : 0) +
    (detail ? RIGHT_PANEL_MIN_WIDTH : 0) +
    (assistant ? assistantWidth : 0) +
    (parked ? PARKED_TAB_WIDTH : 0)
  );
}

/**
 * The widest the sidebar can be DRAWN, and so the ceiling its drag handle
 * clamps to (M52) — `dragCeiling`'s rule for the left edge. The main column
 * keeps its floor and the sidebar has what is left. A drag past that stored
 * a width nobody saw: at 1440 beside a record and the assistant it stored
 * 460 and drew 340, then leapt to 460 when the record closed. `window` is the
 * shell's measured width; unmeasured (`null`) leaves the sidebar's own
 * maximum.
 */
export function sidebarCeiling(window: number | null, floor: number): number {
  if (window === null) return SIDEBAR_WIDTH_MAX;
  return Math.max(
    SIDEBAR_WIDTH_MIN,
    Math.min(SIDEBAR_WIDTH_MAX, window - SIDEBAR_RAIL_WIDTH - floor - SHELL_FRAME_CHROME),
  );
}

/** How a page draws its own panels in the width it was given. */
export interface PageAsides {
  /** The left Pages panel is drawn as a column (else it folds to its button). */
  pages: boolean;
  /**
   * The side panel fits beside the reading column. When it does not, an open
   * one folds away, and a panel's toolbar button opens it as a drawer over
   * the column instead.
   */
  sideFits: boolean;
}

/**
 * A page's own panels, fitted to the canvas it has (M52).
 *
 * Inside a page, when the canvas runs short, things give way in this order:
 *   1. the reading column, down to DOC_COLUMN_MIN_WIDTH (flex does it);
 *   2. the side panel and the Pages panel, down to their floors (the page's
 *      frame and flex);
 *   3. the Pages panel folds to its floating button;
 *   4. the side panel folds, and opens on request as a drawer over the column.
 *
 * Folded, not floated: the doc panel opens by default, so a drawer drawn
 * whenever it did not fit would cover most of every page on a narrow window.
 * A fold is DERIVED, like the parked assistant — it never writes the stored
 * open flags, so the panels come back as they were the moment there is room.
 * `row` is the page frame's measured width, its side panel's column
 * included; `null` (unmeasured) draws what is stored.
 */
export function pageAsides({
  row,
  pages,
  side,
  sideFloor = DOC_PANEL_MIN_WIDTH,
}: {
  row: number | null;
  /** The Pages panel is open (and the doc has pages). */
  pages: boolean;
  /** The side panel is open. */
  side: boolean;
  /** The side panel's floor: DOC_PANEL_MIN_WIDTH, or wider when the toolbar
   *  actions it opens under need more (components/pageFrame.css). */
  sideFloor?: number;
}): PageAsides {
  if (row === null) return { pages, sideFits: true };
  const fits = (withPages: boolean, withSide: boolean) =>
    row - (withPages ? DOC_PAGES_MIN_WIDTH : 0) - (withSide ? sideFloor : 0) >=
    DOC_COLUMN_MIN_WIDTH;
  // Whether the side panel fits is asked with the Pages panel folded, because
  // the Pages panel folds first to make it so.
  const sideFits = fits(false, true);
  return { pages: pages && fits(true, side && sideFits), sideFits };
}

/**
 * The canvas conversation's details (M92.1): a rail of a fixed 300px beside
 * its transcript. It docks while the canvas frame holds a 600px reading
 * column, the rail and a 30px gutter either side of the column, so a 1440 or
 * 1280 window docks it beside a default sidebar; under that it folds away,
 * and opens on request as a drawer over the transcript — `pageAsides`' fold,
 * for the conversation. CSS draws which (agent/chat.css, the `chat-canvas`
 * container), in the same layout pass as the frame's width; the panel asks
 * `chatRailDocks` of the width it measured, for what CSS cannot say: that a
 * folded rail is inert, what its toggle does, and where focus goes.
 */
export const CHAT_RAIL_WIDTH = 300;
const CHAT_READING_MIN = 600;
const CHAT_RAIL_GUTTER = 30;
export const CHAT_RAIL_DOCK_MIN = CHAT_READING_MIN + CHAT_RAIL_WIDTH + 2 * CHAT_RAIL_GUTTER;

/** Whether the rail docks in a canvas frame `width` px wide; null while the
 *  frame is unmeasured, or has no box to measure. */
export function chatRailDocks(width: number | null): boolean | null {
  return width === null || width <= 0 ? null : width >= CHAT_RAIL_DOCK_MIN;
}

/** One reading column never yields; extra panes reserve a tab strip. */
export function paneRowFloor(count: number): number {
  return count <= 1 ? CANVAS_MIN_WIDTH : count * CANVAS_MIN_WIDTH + PARKED_TAB_WIDTH;
}
export function paneCapacity(row: number): number {
  return Math.max(1, Math.min(MAX_PANES, Math.floor((row - PARKED_TAB_WIDTH) / CANVAS_MIN_WIDTH)));
}
/** Literal classes so CSS parks in the same layout pass as a resize. */
export const PANE_PARK = [
  '',
  '@max-[832px]/panes:w-0 @max-[832px]/panes:min-w-0 @max-[832px]/panes:flex-none @max-[832px]/panes:border-0',
  '@max-[1232px]/panes:w-0 @max-[1232px]/panes:min-w-0 @max-[1232px]/panes:flex-none @max-[1232px]/panes:border-0',
  '@max-[1632px]/panes:w-0 @max-[1632px]/panes:min-w-0 @max-[1632px]/panes:flex-none @max-[1632px]/panes:border-0',
] as const;
export const PANE_TAB = [
  'hidden',
  'hidden @max-[832px]/panes:flex',
  'hidden @max-[1232px]/panes:flex',
  'hidden @max-[1632px]/panes:flex',
] as const;
export function paneParked(rank: number, row: number): boolean {
  return rank > 0 && row < paneRowFloor(rank + 1);
}
