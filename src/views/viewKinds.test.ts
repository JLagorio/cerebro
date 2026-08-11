import { describe, expect, it } from 'vitest';
import { VIEW_TYPES, type Presentation } from '@/engine/types';
import { layoutLabel } from '@/engine/views';
import {
  VIEW_KINDS,
  VIEW_SEGMENTS,
  axesFor,
  carryOver,
  hasBlocks,
  hasDependencies,
  hasGroupColumns,
  isCanvas,
  isCharted,
  isDayGrid,
  isTabular,
  isZoomable,
  needsDate,
  showsCards,
  showsChips,
  showsCovers,
  showsPreview,
  viewKind,
} from '@/views/viewKinds';
import { parseListYaml, serializeList } from '@/engine/views';

/**
 * The registration contract for a view kind (M16.3).
 *
 * Adding one used to be four silent traps: the ViewCanvas switch had no
 * default and no return type, LAYOUTS was a hand-written set whose omission
 * downgraded saved files to `list`, and two plain Set<string> in the settings
 * panel decided which config pages a kind got. Three of those are now
 * compile-time errors; this file pins the parts a compiler cannot see.
 */
describe('view kind registration', () => {
  it('describes every declared type exactly once', () => {
    expect(VIEW_KINDS.map((k) => k.value)).toEqual([...VIEW_TYPES]);
  });

  it('gives each kind a distinct icon, so pickers can tell them apart', () => {
    // Gantt and Timeline both shipped as `chart-gantt`, which made them
    // indistinguishable everywhere they were offered side by side.
    const icons = VIEW_KINDS.map((k) => k.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('gives each kind a distinct label and test id', () => {
    expect(new Set(VIEW_KINDS.map((k) => k.label)).size).toBe(VIEW_KINDS.length);
    expect(new Set(VIEW_SEGMENTS.map((s) => s.testId)).size).toBe(VIEW_KINDS.length);
  });

  // The trap this replaced: a kind missing from LAYOUTS parsed as `list`, so
  // opening a saved view silently changed its layout and the next write
  // persisted the downgrade.
  it('round-trips every declared kind through the parser', () => {
    for (const type of VIEW_TYPES) {
      const list = parseListYaml(
        't',
        `name: T\nviews:\n  - id: v\n    name: V\n    presentation:\n      type: ${type}\n`,
      );
      expect(list.definition.views[0]?.presentation.type).toBe(type);
    }
  });

  it('reads capabilities off the kind rather than comparing strings', () => {
    for (const kind of VIEW_KINDS) {
      expect(needsDate(kind.value)).toBe(kind.dated === true);
      expect(isZoomable(kind.value)).toBe(kind.zoomable === true);
      expect(hasDependencies(kind.value)).toBe(kind.dependencies === true);
      expect(showsChips(kind.value)).toBe(kind.chips === true);
      expect(showsCards(kind.value)).toBe(kind.cards === true);
      expect(isCharted(kind.value)).toBe(kind.charted === true);
      expect(hasBlocks(kind.value)).toBe(kind.blocks === true);
      expect(axesFor(kind.value).group).toBe(kind.groupable === true);
      expect(showsPreview(kind.value)).toBe(kind.preview === true);
      expect(showsCovers(kind.value)).toBe(kind.covers === true);
      expect(hasGroupColumns(kind.value)).toBe(kind.groupColumns === true);
      expect(isDayGrid(kind.value)).toBe(kind.dayGrid === true);
      expect(isTabular(kind.value)).toBe(kind.tabular === true);
      expect(isCanvas(kind.value)).toBe(kind.canvas === true);
    }
  });

  /**
   * `cards` was too coarse a gate for the card settings (M16.29). The gallery
   * drew cards, so it was offered "Color columns" — which needs COLUMNS, not
   * cards — and wrote `colorColumns: true` to its view file for nothing. The
   * three narrower flags only make sense on a kind that draws cards at all.
   */
  it('only lets a card-drawing kind declare a card detail', () => {
    for (const kind of VIEW_KINDS) {
      if (kind.preview === true || kind.covers === true) expect(kind.cards).toBe(true);
    }
  });

  /** A tinted column is a GROUP drawn as a column, so the kind must group. */
  it('only lets a grouping kind draw its groups as columns', () => {
    for (const kind of VIEW_KINDS) {
      if (kind.groupColumns === true) expect(kind.groupable).toBe(true);
    }
  });

  /** A day grid is one way of placing records on a date; a kind with no date
   * axis has no days to grid. */
  it('only lets a dated kind draw a day grid', () => {
    for (const kind of VIEW_KINDS) {
      if (kind.dayGrid === true) expect(kind.dated).toBe(true);
    }
  });

  /** Row height, freezing and the footer calc all live on the name column's
   * row, so a tabular kind necessarily has one. */
  it('only lets a tabular kind exist if it has a name column', () => {
    for (const kind of VIEW_KINDS) {
      if (kind.tabular === true) expect(kind.nameColumn).toBe(true);
    }
  });

  // The dashboard embeds saved views (M16.28), and `hasBlocks` is what stops
  // one embedding another. A kind that is both composed of blocks AND
  // something a block can show is an infinite nest.
  it('keeps a block-composed kind out of the settings a record layout owns', () => {
    for (const kind of VIEW_KINDS) {
      if (kind.blocks !== true) continue;
      expect(kind.groupable).toBeUndefined();
      expect(kind.dated).toBeUndefined();
      expect(kind.cards).toBeUndefined();
      expect(kind.charted).toBeUndefined();
    }
  });

  // A chart's X axis IS its grouping chain (M16.27) — a charted kind that
  // could not group would have no axis and would render an empty state
  // nobody could clear.
  it('only lets a charted kind exist if it can group', () => {
    for (const kind of VIEW_KINDS) {
      if (kind.charted === true) expect(kind.groupable).toBe(true);
    }
  });

  it('only lets a dated kind zoom or draw dependencies', () => {
    for (const kind of VIEW_KINDS) {
      if (kind.zoomable === true || kind.dependencies === true) {
        expect(kind.dated).toBe(true);
      }
    }
  });

  it('falls back to the first kind for an unknown type', () => {
    expect(viewKind('nope' as never)).toBe(VIEW_KINDS[0]);
  });

  // --- M29.45: the tenth kind -----------------------------------------------

  it('whiteboard is registered, labeled, and offered', () => {
    const wb = viewKind('whiteboard');
    expect(wb.value).toBe('whiteboard');
    expect(wb.label).toBe('Whiteboard');
    expect(isCanvas('whiteboard')).toBe(true);
    expect(VIEW_SEGMENTS.some((s) => s.testId === 'view-switch-whiteboard')).toBe(true);
  });

  /**
   * A canvas kind draws a file, not records. Every record-layout capability
   * would be a control that changes nothing on its canvas — the calendar's
   * M16.3 bug, avoided by declaring nothing.
   */
  it('a canvas kind declares no record-layout capability', () => {
    for (const kind of VIEW_KINDS) {
      if (kind.canvas !== true) continue;
      expect(kind.groupable).toBeUndefined();
      expect(kind.dated).toBeUndefined();
      expect(kind.cards).toBeUndefined();
      expect(kind.charted).toBeUndefined();
      expect(kind.blocks).toBeUndefined();
      expect(kind.tabular).toBeUndefined();
      expect(kind.chips).toBeUndefined();
    }
  });
});

/**
 * What a NEW view inherits from the tab you created it on (M16.29).
 *
 * "Add a view" seeds from the open tab, which is right — but it copied the
 * whole presentation and only swapped `type`. A Table created while standing
 * on the Gallery inherited `colorColumns`; one created off the Gantt inherited
 * `dateField`, `zoom` and `dependencyField`. Nothing on screen mentions those
 * again, no control in the new view can clear them, and the first save writes
 * them to the user's YAML permanently.
 */
describe('carrying a presentation to a new kind (M16.29)', () => {
  /** Every layout-specific key set at once, so a carry-over that forgets to
   * drop one is caught whichever kind is asked for. */
  const everything: Presentation = {
    type: 'gantt',
    group: [{ field: 'status' }],
    sort: [{ field: 'due', dir: 'asc' }],
    columns: [{ field: 'status' }, { field: 'due' }],
    limit: 25,
    rowHeight: 'tall',
    titleWidth: 320,
    frozenColumns: 2,
    titlePosition: 1,
    titleCalc: 'count_all',
    chips: 'type-icon',
    cardSize: 'large',
    cardPreview: 'content',
    colorColumns: true,
    dateField: 'due',
    zoom: 'week',
    showTable: false,
    dependencyField: 'blocked_by',
    gallery: { cover: 'artwork', fit: true },
    chart: { kind: 'donut' },
    dashboard: { blocks: [{ id: 'b1', kind: 'number', agg: 'count' }] },
    calendarSpan: 'week',
    showWeekends: false,
    weekStart: 'monday',
    whiteboard: { file: 'delivery/whiteboards/map.mmd' },
  };

  it('keeps the query — the reason you asked for another view of this data', () => {
    for (const type of VIEW_TYPES) {
      const next = carryOver(everything, type);
      expect(next.type).toBe(type);
      expect(next.group).toEqual(everything.group);
      expect(next.sort).toEqual(everything.sort);
      expect(next.columns).toEqual(everything.columns);
      expect(next.limit).toBe(25);
    }
  });

  /**
   * The invariant, stated over every kind: a view must round-trip through
   * YAML carrying no key its own layout cannot read. `serializePresentation`
   * is what actually reaches disk, so the assertion is made against that
   * rather than against the object.
   */
  it('writes no key the new kind cannot read', () => {
    for (const type of VIEW_TYPES) {
      const yaml = serializeList({
        name: 'T',
        icon: null,
        color: null,
        order: null,
        source: { type: 'Work item', project: null },
        views: [
          {
            id: 'v',
            name: 'V',
            icon: null,
            filters: null,
            presentation: carryOver(everything, type),
          },
        ],
      });
      const kind = viewKind(type);
      const forbidden: [string, boolean][] = [
        ['rowHeight', kind.tabular === true],
        ['frozenColumns', kind.tabular === true],
        ['titlePosition', kind.tabular === true],
        ['titleCalc', kind.tabular === true],
        ['titleWidth', kind.nameColumn === true],
        ['chips', kind.chips === true],
        ['cardSize', kind.cards === true],
        ['cardPreview', kind.preview === true],
        ['colorColumns', kind.groupColumns === true],
        ['gallery', kind.covers === true],
        ['dateField', kind.dated === true],
        ['calendarSpan', kind.dayGrid === true],
        ['showWeekends', kind.dayGrid === true],
        ['weekStart', kind.dayGrid === true],
        ['zoom', kind.zoomable === true],
        ['showTable', kind.zoomable === true],
        ['dependencyField', kind.dependencies === true],
        ['chart', kind.charted === true],
        ['dashboard', kind.blocks === true],
        // NEVER carried — not even whiteboard→whiteboard. The file is the
        // tab's identity (M29.45); see NEVER_SEEDED in viewKinds.ts.
        ['whiteboard', false],
      ];
      for (const [key, allowed] of forbidden) {
        // `^\s+key:` and not a bare substring — `chart` is also a `type:`
        // value, and `zoom` appears inside no other word but might one day.
        const present = new RegExp(`^\\s+${key}:`, 'm').test(yaml);
        expect({ type, key, present }).toEqual({ type, key, present: allowed });
      }
    }
  });

  /** The three reported by the live pass, named explicitly so the commit and
   * the test say the same thing. */
  it('a table born on the gantt inherits no date axis, zoom or dependencies', () => {
    const table = carryOver(everything, 'table');
    expect(table.dateField).toBeUndefined();
    expect(table.zoom).toBeUndefined();
    expect(table.dependencyField).toBeUndefined();
  });

  it('a table born on the gallery inherits no colorColumns', () => {
    expect(carryOver(everything, 'table').colorColumns).toBeUndefined();
  });

  /**
   * The file pointer never seeds a new tab (M29.45). A whiteboard born from a
   * whiteboard must get its OWN canvas: carrying the pointer would aim two
   * tabs at one .mmd, and "new whiteboard" would silently mean "second door
   * to the first one". (Duplicate is different on purpose — it copies the
   * whole view, pointer included, the way a duplicated dashboard keeps its
   * blocks.)
   */
  it('never carries the whiteboard file pointer, even whiteboard-to-whiteboard', () => {
    const board: Presentation = {
      type: 'whiteboard',
      group: [],
      sort: [{ field: 'modifiedAt', dir: 'desc' }],
      columns: [],
      whiteboard: { file: 'delivery/whiteboards/map.mmd' },
    };
    expect(carryOver(board, 'whiteboard').whiteboard).toBeUndefined();
    expect(carryOver(board, 'table').whiteboard).toBeUndefined();
  });
});

/**
 * `layoutLabel` (engine/views.ts) is a SECOND label table, and the two are
 * read side by side: the picker tile shows `ViewKind.label` while the tab it
 * creates is NAMED by `layoutLabel` (ViewTabs.tsx:512), and the delete
 * confirmation quotes it back. Nothing asserted they agreed, so a kind could
 * be offered as "Whiteboard" and create a tab called something else — and
 * both tables are hand-maintained, so the tenth kind had to be added twice.
 */
describe('the two label tables agree (M29.46)', () => {
  it('names every kind the same way in the picker and on the tab it creates', () => {
    for (const kind of VIEW_KINDS) {
      expect(layoutLabel(kind.value)).toBe(kind.label);
    }
  });
});
