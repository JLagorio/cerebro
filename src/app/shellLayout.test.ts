import { describe, expect, it } from 'vitest';
import {
  dragCeiling,
  fitWidth,
  mainColumnFloor,
  mainColumnFloorPx,
  nextRailLatch,
  pageAsides,
  PARKED_TAB_WIDTH,
  panelRooms,
  roomAt,
  SHELL_BARE_TWO_PANEL_MIN,
  SHELL_CLASSES,
  SHELL_PARKED_COLUMN_MIN,
  SHELL_RAIL_TWO_PANEL_MIN,
  SHELL_TWO_PANEL_MIN,
  shellBands,
  shellPlan,
  SIDEBAR_RAIL_WIDTH,
  sidebarCeiling,
} from '@/app/shellLayout';
import {
  AI_WIDTH_DEFAULT,
  CANVAS_MIN_WIDTH,
  DETAIL_WIDTH_DEFAULT,
  DETAIL_WIDTH_MAX,
  DETAIL_WIDTH_MIN,
  DOC_COLUMN_MIN_WIDTH,
  DOC_PAGES_MIN_WIDTH,
  DOC_PANEL_MIN_WIDTH,
  DOC_PANEL_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '@/stores/uiStore';

/**
 * How the record and the assistant share the canvas row (M52).
 *
 * The owner's report: widen a record's peek with the assistant open and the
 * assistant is shoved off the right edge, 70px of it left showing with its
 * text cut mid-word. Measured before the fix at 1440px: the peek's « control
 * set it to 1000px and the assistant started AT the window's right edge.
 */

/** The canvas row at 1440px beside a default-width sidebar. */
const ROW_1440 = 1440 - SIDEBAR_WIDTH_DEFAULT;

describe('fitWidth', () => {
  it('draws a stored width that fits as it is', () => {
    expect(fitWidth(560, 900)).toBe(560);
  });

  it('caps a stored width at the room, so it can never cause overflow', () => {
    expect(fitWidth(DETAIL_WIDTH_MAX, 396)).toBe(396);
  });

  it('never draws below the panel floor', () => {
    expect(fitWidth(560, 100)).toBe(RIGHT_PANEL_MIN_WIDTH);
  });
});

describe('panelRooms', () => {
  it('gives the record what is left beside the assistant — the reported case', () => {
    const rooms = panelRooms({
      row: ROW_1440,
      detail: true,
      assistant: true,
      assistantWidth: AI_WIDTH_DEFAULT,
    });
    // 1176 − 400 canvas − 380 assistant.
    expect(rooms.detail).toBe(ROW_1440 - CANVAS_MIN_WIDTH - AI_WIDTH_DEFAULT);
    // The widened record is drawn in that room, not at its stored 1000 …
    const record = fitWidth(DETAIL_WIDTH_MAX, rooms.detail);
    expect(record).toBeLessThan(DETAIL_WIDTH_DEFAULT);
    // … and the assistant keeps its own width, so the three add up to the row.
    const assistant = fitWidth(AI_WIDTH_DEFAULT, rooms.assistant);
    expect(assistant).toBe(AI_WIDTH_DEFAULT);
    expect(CANVAS_MIN_WIDTH + record + assistant).toBe(ROW_1440);
  });

  it('lets the canvas give first: a roomy row draws the stored record width', () => {
    const rooms = panelRooms({ row: 1736, detail: true, assistant: true, assistantWidth: 380 });
    expect(fitWidth(DETAIL_WIDTH_DEFAULT, rooms.detail)).toBe(DETAIL_WIDTH_DEFAULT);
  });

  it('shrinks the assistant only once the record is at its floor', () => {
    // A 720px assistant in a 1100px row: the record is squeezed to its floor
    // first, and the assistant gives only what that floor still needs.
    const rooms = panelRooms({ row: 1100, detail: true, assistant: true, assistantWidth: 720 });
    const assistant = fitWidth(720, rooms.assistant);
    const record = fitWidth(DETAIL_WIDTH_DEFAULT, rooms.detail);
    expect(record).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(assistant).toBe(1100 - CANVAS_MIN_WIDTH - RIGHT_PANEL_MIN_WIDTH);
    expect(CANVAS_MIN_WIDTH + record + assistant).toBe(1100);
  });

  it('hands a lone panel the whole room beside the canvas', () => {
    expect(
      panelRooms({ row: ROW_1440, detail: true, assistant: false, assistantWidth: 380 }).detail,
    ).toBe(ROW_1440 - CANVAS_MIN_WIDTH);
    expect(
      panelRooms({ row: ROW_1440, detail: false, assistant: true, assistantWidth: 380 }).assistant,
    ).toBe(ROW_1440 - CANVAS_MIN_WIDTH);
  });

  it('takes nothing for a parked assistant', () => {
    // Parked is open but not drawn — it must not hold room it does not use.
    const rooms = panelRooms({ row: 900, detail: true, assistant: false, assistantWidth: 720 });
    expect(rooms.detail).toBe(900 - CANVAS_MIN_WIDTH);
  });

  it("but keeps its tab's strip, so the record never slides under it", () => {
    const rooms = panelRooms({
      row: 900,
      detail: true,
      assistant: false,
      assistantWidth: 720,
      parked: true,
    });
    expect(rooms.detail).toBe(900 - CANVAS_MIN_WIDTH - PARKED_TAB_WIDTH);
  });
});

/**
 * Below 1220 a record beside the assistant used to park the assistant with
 * nothing on screen to say so — the zap stayed pressed — and the sidebar then
 * leapt 180→264 as the window shrank, because parking handed it the room.
 */
describe('shellPlan', () => {
  const plan = (
    width: number,
    over: { detail?: boolean; assistant?: boolean; collapsed?: boolean; railLatched?: boolean },
  ) =>
    shellPlan({
      detail: over.detail ?? true,
      assistant: over.assistant ?? true,
      collapsed: over.collapsed ?? false,
      railLatched: over.railLatched ?? false,
      room: roomAt(width),
    });

  it('derives its thresholds from the floors', () => {
    expect(SHELL_TWO_PANEL_MIN).toBe(
      SIDEBAR_WIDTH_MIN + CANVAS_MIN_WIDTH + 2 * RIGHT_PANEL_MIN_WIDTH,
    );
    expect(SHELL_TWO_PANEL_MIN).toBe(1220);
    expect(SHELL_RAIL_TWO_PANEL_MIN).toBe(SIDEBAR_RAIL_WIDTH + 1040);
    expect(SHELL_BARE_TWO_PANEL_MIN).toBe(1040);
    expect(SHELL_PARKED_COLUMN_MIN).toBe(
      SIDEBAR_WIDTH_MIN + CANVAS_MIN_WIDTH + RIGHT_PANEL_MIN_WIDTH + PARKED_TAB_WIDTH,
    );
    expect(SHELL_PARKED_COLUMN_MIN).toBe(932);
  });

  it('draws both beside a sidebar column when the column fits', () => {
    expect(plan(1220, {})).toEqual({ sidebar: 'column', assistant: 'drawn' });
  });

  it('steps the sidebar down to its rail before it parks the assistant', () => {
    expect(plan(1219, {})).toEqual({ sidebar: 'rail', assistant: 'drawn' });
    expect(plan(SHELL_RAIL_TWO_PANEL_MIN, {})).toEqual({ sidebar: 'rail', assistant: 'drawn' });
  });

  it('parks the assistant only when the rail is not enough — the record still wins (M17.2)', () => {
    expect(plan(SHELL_RAIL_TWO_PANEL_MIN - 1, {}).assistant).toBe('parked');
  });

  // Verified at 1050: pressing the Assistant beside a record took the sidebar
  // from 264 to its 44px rail AND parked the assistant, so the user lost the
  // sidebar and got a 32px tab for it. The rail is for keeping both panels.
  it('keeps the sidebar column where the rail would not keep the assistant', () => {
    for (const width of [1083, 1000, SHELL_PARKED_COLUMN_MIN]) {
      expect(plan(width, {})).toEqual({ sidebar: 'column', assistant: 'parked' });
    }
  });

  // Verified between 900 (Tauri's minWidth) and 931: the column, the record's
  // floor and the canvas's left the parked tab a 20px sliver at 920 and
  // nothing at 900, so the assistant was parked behind a tab nobody could see.
  it('takes the rail where the column would push the parked tab off the window', () => {
    for (const width of [SHELL_PARKED_COLUMN_MIN - 1, 915, 900]) {
      expect(plan(width, {})).toEqual({ sidebar: 'rail', assistant: 'parked' });
    }
    // A sidebar the user collapsed is not the shell's to rail.
    expect(plan(900, { collapsed: true }).sidebar).toBe('collapsed');
    // With no tab there is nothing to make room for.
    expect(plan(900, { assistant: false }).sidebar).toBe('column');
  });

  it('keeps a rail that was already showing, so the sidebar never grows as the window shrinks', () => {
    for (const width of [1083, 1000, 800]) {
      expect(plan(width, { railLatched: true })).toEqual({ sidebar: 'rail', assistant: 'parked' });
    }
    // Where there is room the latch is moot: the window decides.
    expect(plan(1300, { railLatched: true }).sidebar).toBe('column');
  });

  it("uses the room a user-collapsed sidebar gives back, and never writes over the user's word", () => {
    expect(plan(1100, { collapsed: true })).toEqual({ sidebar: 'collapsed', assistant: 'drawn' });
    expect(plan(SHELL_BARE_TWO_PANEL_MIN - 1, { collapsed: true })).toEqual({
      sidebar: 'collapsed',
      assistant: 'parked',
    });
  });

  it('has nothing to give way for with one panel or none', () => {
    expect(plan(900, { detail: false })).toEqual({ sidebar: 'column', assistant: 'drawn' });
    expect(plan(900, { assistant: false })).toEqual({ sidebar: 'column', assistant: 'closed' });
    expect(plan(900, { assistant: false, collapsed: true })).toEqual({
      sidebar: 'collapsed',
      assistant: 'closed',
    });
  });
});

describe('nextRailLatch', () => {
  const latch = (
    was: boolean,
    width: number,
    over: { detail?: boolean; collapsed?: boolean } = {},
  ) =>
    nextRailLatch(was, {
      detail: over.detail ?? true,
      assistant: true,
      collapsed: over.collapsed ?? false,
      room: roomAt(width),
    });

  it('sets while the rail is what keeps both panels', () => {
    expect(latch(false, SHELL_RAIL_TWO_PANEL_MIN)).toBe(true);
    expect(latch(false, SHELL_TWO_PANEL_MIN - 1)).toBe(true);
  });

  it('holds below the rail, where the window no longer says', () => {
    expect(latch(true, 1000)).toBe(true);
    // Arriving from a column, or opening the assistant down here: no rail.
    expect(latch(false, 1000)).toBe(false);
  });

  it('is not set by the rail that makes room for the parked tab', () => {
    // The window says there, so the column comes back as soon as it fits.
    expect(latch(false, SHELL_PARKED_COLUMN_MIN - 1)).toBe(false);
  });

  it('clears with the room, the record, or the user collapsing the sidebar', () => {
    expect(latch(true, SHELL_TWO_PANEL_MIN)).toBe(false);
    expect(latch(true, 1000, { detail: false })).toBe(false);
    expect(latch(true, 1000, { collapsed: true })).toBe(false);
  });
});

/**
 * The plan is drawn by CSS (M52). Decided in React it arrived a frame after
 * the window: at 1300→1000 that frame drew the assistant 80px wide with Send
 * past the edge, and WebKit drew the old plan at every threshold crossing.
 */
describe('shellBands', () => {
  const bands = (over: { detail?: boolean; collapsed?: boolean; railLatched?: boolean } = {}) =>
    shellBands({
      detail: over.detail ?? true,
      assistant: true,
      collapsed: over.collapsed ?? false,
      railLatched: over.railLatched ?? false,
    });

  it('has nothing to choose between with one panel', () => {
    expect(bands({ detail: false })).toEqual({ rail: 'none', park: 'never' });
  });

  it('rails in the band, or below it once latched, and parks under the rail', () => {
    expect(bands()).toEqual({ rail: 'band', park: 'rail' });
    expect(bands({ railLatched: true })).toEqual({ rail: 'below', park: 'rail' });
  });

  it('never rails a sidebar the user collapsed, and parks it at the bare width', () => {
    expect(bands({ collapsed: true, railLatched: true })).toEqual({ rail: 'none', park: 'bare' });
  });

  /** Every `min-[N]` / `max-[N]` in a class list. */
  const edges = (classes: string) =>
    [...classes.matchAll(/(min|max)-\[(\d+)px\]/g)].map(([, side, n]) => `${side}${n}`);

  it('spells the thresholds out as the same numbers the plan uses', () => {
    // Literal, because Tailwind reads source text; held to the constants here.
    const column = `min${SHELL_RAIL_TWO_PANEL_MIN}`;
    const under = (n: number) => `max${n}`;
    const band = [column, under(SHELL_TWO_PANEL_MIN), under(SHELL_PARKED_COLUMN_MIN)];
    expect(edges(SHELL_CLASSES.rail.band.column)).toEqual(band);
    expect(edges(SHELL_CLASSES.rail.band.rail)).toEqual(band);
    expect(edges(SHELL_CLASSES.rail.below.column)).toEqual([under(SHELL_TWO_PANEL_MIN)]);
    expect(edges(SHELL_CLASSES.rail.below.rail)).toEqual([under(SHELL_TWO_PANEL_MIN)]);
    for (const part of Object.values(SHELL_CLASSES.park.rail)) {
      expect(new Set(edges(part))).toEqual(new Set([under(SHELL_RAIL_TWO_PANEL_MIN)]));
    }
    for (const part of Object.values(SHELL_CLASSES.park.bare)) {
      expect(new Set(edges(part))).toEqual(new Set([under(SHELL_BARE_TWO_PANEL_MIN)]));
    }
  });

  it('shows exactly one of the column and the rail', () => {
    for (const band of ['band', 'below'] as const) {
      const { column, rail } = SHELL_CLASSES.rail[band];
      expect(rail.split(' ')[0]).toBe('hidden');
      expect(rail.replace(/:flex/g, ':hidden').split(' ').slice(1).join(' ')).toBe(column);
    }
  });
});

describe('dragCeiling', () => {
  it('stops a drag at the room left beside the assistant', () => {
    expect(dragCeiling(396, DETAIL_WIDTH_MAX)).toBe(396);
  });

  it('is the drawn floor when the room is under it — never a width that was not drawn', () => {
    // Verified at 1440 with the assistant dragged widest: the record drawn at
    // 320 while a 360 ceiling let its drag store 360.
    expect(dragCeiling(300, DETAIL_WIDTH_MAX)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(dragCeiling(300, DETAIL_WIDTH_MAX)).toBe(fitWidth(DETAIL_WIDTH_DEFAULT, 300));
  });

  it('keeps the panel maximum when there is more room than that', () => {
    expect(dragCeiling(1400, DETAIL_WIDTH_MAX)).toBe(DETAIL_WIDTH_MAX);
  });

  it('keeps the panel maximum before the row has been measured', () => {
    expect(dragCeiling(null, DETAIL_WIDTH_MAX)).toBe(DETAIL_WIDTH_MAX);
  });

  it('never sits under the drag minimum, so the handle range never inverts', () => {
    expect(DETAIL_WIDTH_MIN).toBeLessThanOrEqual(dragCeiling(0, DETAIL_WIDTH_MAX));
  });
});

describe('mainColumnFloor', () => {
  it('is the canvas floor alone when no panel is drawn', () => {
    expect(mainColumnFloor({ detail: false, assistant: false, assistantWidth: 380 })).toBe(
      'min(400px, 100vw - 180px)',
    );
  });

  it('counts the record at its floor and the assistant at its whole width', () => {
    // So the sidebar gives before the assistant does.
    expect(mainColumnFloor({ detail: true, assistant: true, assistantWidth: 380 })).toBe(
      'min(1100px, 100vw - 180px)',
    );
  });

  it("counts a page's own side panel, so the sidebar gives before the reading column", () => {
    // 400 canvas + 272 side panel + 380 assistant.
    expect(
      mainColumnFloor({ detail: false, assistant: true, assistantWidth: 380, pageAside: true }),
    ).toBe(`min(${CANVAS_MIN_WIDTH + DOC_PANEL_WIDTH + 380}px, 100vw - 180px)`);
  });

  it('is capped at what the window holds beside a minimum sidebar', () => {
    // A floor wider than that pushes the whole right edge out of the window.
    expect(mainColumnFloor({ detail: false, assistant: true, assistantWidth: 720 })).toBe(
      'min(1120px, 100vw - 180px)',
    );
  });
});

describe('mainColumnFloorPx', () => {
  it("counts a parked assistant's tab", () => {
    expect(
      mainColumnFloorPx({ detail: true, assistant: false, assistantWidth: 380, parked: true }),
    ).toBe(CANVAS_MIN_WIDTH + RIGHT_PANEL_MIN_WIDTH + PARKED_TAB_WIDTH);
  });
});

/**
 * Verified at 1440 beside a record and the assistant: the sidebar's drag
 * stored 460, the row drew 340, and the sidebar leapt to 460 the moment the
 * record closed.
 */
describe('sidebarCeiling', () => {
  const floor = mainColumnFloorPx({ detail: true, assistant: true, assistantWidth: 380 });

  it('stops the drag at what can be drawn beside the main column floor', () => {
    expect(sidebarCeiling(1440, floor)).toBe(1440 - floor);
    expect(sidebarCeiling(1440, floor)).toBe(340);
  });

  it('keeps the sidebar maximum when the window has more room than that', () => {
    expect(sidebarCeiling(2400, floor)).toBe(SIDEBAR_WIDTH_MAX);
  });

  it('never goes under the sidebar floor, so the handle range never inverts', () => {
    expect(sidebarCeiling(1100, floor)).toBe(SIDEBAR_WIDTH_MIN);
  });

  it('keeps the sidebar maximum before the shell has been measured', () => {
    expect(sidebarCeiling(null, floor)).toBe(SIDEBAR_WIDTH_MAX);
  });
});

describe('pageAsides', () => {
  const floors = DOC_COLUMN_MIN_WIDTH + DOC_PANEL_MIN_WIDTH;

  it('draws what is stored before the page has been measured', () => {
    expect(pageAsides({ row: null, pages: true, side: true })).toEqual({
      pages: true,
      sideFits: true,
    });
  });

  it('keeps the side panel beside the column while both floors fit', () => {
    expect(pageAsides({ row: floors, pages: false, side: true }).sideFits).toBe(true);
  });

  it('folds the side panel once they do not — the verified 1100px case', () => {
    // The column fell to 200px beside it and the concept title broke mid-word.
    expect(pageAsides({ row: floors - 1, pages: false, side: true }).sideFits).toBe(false);
    expect(pageAsides({ row: CANVAS_MIN_WIDTH, pages: false, side: true }).sideFits).toBe(false);
  });

  it('folds the Pages panel before the side panel', () => {
    const withPages = floors + DOC_PAGES_MIN_WIDTH;
    expect(pageAsides({ row: withPages, pages: true, side: true })).toEqual({
      pages: true,
      sideFits: true,
    });
    // One pixel short: the Pages panel folds and the side panel still fits.
    expect(pageAsides({ row: withPages - 1, pages: true, side: true })).toEqual({
      pages: false,
      sideFits: true,
    });
  });

  it("gives a folded side panel's room back to the Pages panel", () => {
    // Too narrow for the side panel at all: it folds, and the column beside
    // the Pages panel no longer has to share with it.
    const row = DOC_COLUMN_MIN_WIDTH + DOC_PAGES_MIN_WIDTH;
    expect(row).toBeLessThan(floors);
    expect(pageAsides({ row, pages: true, side: true })).toEqual({
      pages: true,
      sideFits: false,
    });
  });

  it('keeps the Pages panel on a page with no side panel while the column fits', () => {
    const row = DOC_COLUMN_MIN_WIDTH + DOC_PAGES_MIN_WIDTH;
    expect(pageAsides({ row, pages: true, side: false }).pages).toBe(true);
    expect(pageAsides({ row: row - 1, pages: true, side: false }).pages).toBe(false);
  });

  it('never draws a Pages panel that is not open', () => {
    expect(pageAsides({ row: 2000, pages: false, side: false }).pages).toBe(false);
  });
});
