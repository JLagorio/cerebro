import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ownsEscape, pushLayer, resetLayers } from '@/components/ui/layers';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  BoardView,
  handleDragEnd,
  resolveBoardColumn,
  type BoardColumnNode,
  type BoardTarget,
} from '@/views/BoardView';
import { bandKind } from '@/engine/grouping';
import { buildSchema } from '@/engine/schema';
import { groupEntries } from '@/engine/grouping';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault, makeEntry } from '@/test/factories';
import type { Entry, Presentation, Schema } from '@/engine/types';

const presentation: Presentation = {
  type: 'board',
  group: [{ field: 'status' }],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [{ field: 'status' }, { field: 'priority' }, { field: 'assignee' }],
};

/** Every column on the board, in render order, as its header reads. */
const columnLabels = () =>
  screen.getAllByTestId('board-column').map((c) => c.querySelector('span + span')?.textContent);

/** groupEntries → the drop targets handleDragEnd matches on. */
function dropTargets(
  entries: Entry[],
  field: string,
  schema: Schema,
  lane: BoardColumnNode['lane'] = null,
): BoardColumnNode[] {
  return groupEntries(entries, field, schema).map((g) => ({
    path: lane === null ? g.key : `${lane.key}/${g.key}`,
    key: g.key,
    label: g.label,
    color: g.color,
    ghost: g.ghost,
    entries: g.entries,
    lane,
  }));
}

afterEach(cleanup);

describe('BoardView', () => {
  it('renders one column per group and a muted footer counting unparseable entries', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const items = entries.filter((e) => e.path.startsWith('projects/onboarding/items/'));
    render(
      <BoardView filtered={false} entries={items} presentation={presentation} schema={schema} />,
    );
    expect(screen.getByText('Todo')).toBeTruthy();
    expect(screen.getByText('Doing')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy(); // empty column still renders
    expect(screen.getByText('1 unparseable item hidden')).toBeTruthy();
    expect(screen.queryByText('broken.md')).toBeNull();
  });

  // Fix test (execution-log note 17a): an empty project rendered a blank
  // canvas — groupEntries([], …) returns [] so the board had no columns and
  // no empty state.
  it('renders an empty state instead of a blank canvas for an empty project', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(<BoardView filtered={false} entries={[]} presentation={presentation} schema={schema} />);
    expect(screen.getByTestId('board-view')).toBeTruthy();
    expect(screen.getByText('No items yet')).toBeTruthy();
  });
});

/**
 * Board correctness (M16.19).
 *
 * The board called `groupEntries` directly, so the two ordering rules the
 * engine already implements — `dir` and `hideEmpty` — could not reach it. The
 * Group page's direction toggle wrote the view file and then changed nothing
 * on screen, which is the worst kind of control: one that reports success.
 */
describe('BoardView grouping (M16.19)', () => {
  const items = () =>
    fixtureVault().filter(
      (e) => e.path.startsWith('projects/onboarding/items/') && e.parseError === null,
    );

  it('reverses the column order when the level says desc', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <BoardView
        filtered={false}
        entries={items()}
        presentation={{ ...presentation, group: [{ field: 'status', dir: 'desc' }] }}
        schema={schema}
      />,
    );
    expect(columnLabels()).toEqual(['Done', 'Doing', 'Todo']);
  });

  it('drops declared-but-empty columns when the level says hideEmpty', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <BoardView
        filtered={false}
        entries={items()}
        presentation={{ ...presentation, group: [{ field: 'status', hideEmpty: true }] }}
        schema={schema}
      />,
    );
    // Done is declared on the type and holds nothing here.
    expect(columnLabels()).toEqual(['Todo', 'Doing']);
  });

  // The board read `presentation.group[0]` blindly. A chain that begins with a
  // relation level bands NOTHING at that level — it nests — so the board took
  // the relation's name as its column axis and grouped by a field nobody chose.
  it('takes its column axis from the first BAND level, not the first level', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <BoardView
        filtered={false}
        entries={items()}
        presentation={{
          ...presentation,
          group: [
            { field: 'assignee', descend: { direction: 'forward', field: 'assignee' } },
            { field: 'status' },
          ],
        }}
        schema={schema}
      />,
    );
    expect(columnLabels()).toEqual(['Todo', 'Doing', 'Done']);
  });

  // dnd-kit keys its droppable registry by id, so two columns sharing one id
  // is not "two targets that behave alike" — it is one target and one dead
  // column. Every lane has a "Doing", so a sub-grouped board had exactly that.
  it('gives every column in every lane its own droppable id', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <BoardView
        filtered={false}
        entries={items()}
        presentation={{ ...presentation, group: [{ field: 'status' }, { field: 'assignee' }] }}
        schema={schema}
      />,
    );
    expect(screen.getAllByTestId('board-swimlane').length).toBeGreaterThan(1);
    const paths = screen
      .getAllByTestId('board-column')
      .map((c) => c.getAttribute('data-column-path'));
    // The keys repeat across lanes — which is the whole point — so uniqueness
    // has to come from the path.
    const keys = screen.getAllByTestId('board-column').map((c) => c.getAttribute('data-group-key'));
    expect(new Set(keys).size).toBeLessThan(keys.length);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

/**
 * What a card shows (M16.19).
 *
 * The card resolved `priority` and `assignee` by name. The shared Properties
 * page — the eye toggles every other layout obeys — was therefore a visible
 * no-op on the board, and a vault whose fields are named anything else got a
 * card with a title and nothing more.
 */
describe('BoardView card properties (M16.19)', () => {
  const items = () =>
    fixtureVault().filter(
      (e) => e.path.startsWith('projects/onboarding/items/') && e.parseError === null,
    );

  it('shows a property the view lists and the old card had never heard of', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <BoardView
        filtered={false}
        entries={items()}
        presentation={{ ...presentation, columns: [{ field: 'channel' }] }}
        schema={schema}
      />,
    );
    expect(screen.getByText('field-ops')).toBeTruthy();
    // …and stops showing the two it used to render by name.
    expect(screen.queryByText('High')).toBeNull();
  });

  it('hides a property the view has hidden', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <BoardView
        filtered={false}
        entries={items()}
        presentation={{
          ...presentation,
          columns: [{ field: 'priority', hidden: true }, { field: 'channel' }],
        }}
        schema={schema}
      />,
    );
    expect(screen.getByText('field-ops')).toBeTruthy();
    expect(screen.queryByText('High')).toBeNull();
  });
});

/**
 * Card settings (M16.20).
 *
 * `Presentation` carried no card keys at all, so Notion's whole board panel —
 * card size, card preview, colour columns — had nothing to write to and the
 * board had nothing to read. `Entry.snippet` in particular has been produced
 * by the scanner since v1 and rendered by no surface in the app.
 */
describe('BoardView card settings (M16.20)', () => {
  const items = () =>
    fixtureVault().filter(
      (e) => e.path.startsWith('projects/onboarding/items/') && e.parseError === null,
    );

  const withSnippet = () =>
    items().map((e) =>
      e.path.endsWith('fld-1.md') ? { ...e, snippet: 'A first-run flow nobody has drawn yet.' } : e,
    );

  it('shows no preview until the view asks for one', () => {
    const schema = buildSchema(fixtureVault());
    render(
      <BoardView
        filtered={false}
        entries={withSnippet()}
        presentation={presentation}
        schema={schema}
      />,
    );
    expect(screen.queryByTestId('card-preview')).toBeNull();
  });

  it('previews the body when the view asks for page content', () => {
    const schema = buildSchema(fixtureVault());
    render(
      <BoardView
        filtered={false}
        entries={withSnippet()}
        presentation={{ ...presentation, cardPreview: 'content' }}
        schema={schema}
      />,
    );
    expect(screen.getByTestId('card-preview').textContent).toBe(
      'A first-run flow nobody has drawn yet.',
    );
  });

  it('leaves a card with no body text alone rather than reserving empty space', () => {
    const schema = buildSchema(fixtureVault());
    render(
      <BoardView
        filtered={false}
        entries={items()}
        presentation={{ ...presentation, cardPreview: 'content' }}
        schema={schema}
      />,
    );
    expect(screen.queryByTestId('card-preview')).toBeNull();
  });

  it('narrows the columns for small cards and widens them for large', () => {
    const schema = buildSchema(fixtureVault());
    const widthAt = (cardSize: 'small' | 'medium' | 'large') => {
      cleanup();
      render(
        <BoardView
          filtered={false}
          entries={items()}
          presentation={{ ...presentation, cardSize }}
          schema={schema}
        />,
      );
      return screen.getAllByTestId('board-column')[0].style.width;
    };
    expect(widthAt('small')).toBe('240px');
    expect(widthAt('medium')).toBe('280px');
    expect(widthAt('large')).toBe('320px');
  });

  it('paints a column in its own colour only when the view says to', () => {
    const schema = buildSchema(fixtureVault());
    const { rerender } = render(
      <BoardView filtered={false} entries={items()} presentation={presentation} schema={schema} />,
    );
    expect(screen.getAllByTestId('board-column')[0].querySelector('[data-tinted]')).toBeNull();
    rerender(
      <BoardView
        filtered={false}
        entries={items()}
        presentation={{ ...presentation, colorColumns: true }}
        schema={schema}
      />,
    );
    const body = screen.getAllByTestId('board-column')[0].querySelector('[data-tinted]');
    expect(body).not.toBeNull();
    // The status colours in the fixture are raw hexes, which
    // `resolveOptionColor` mixes rather than concatenating an alpha onto —
    // `#fff22` is a declaration the browser drops (M16.12).
    expect((body as HTMLElement).style.background).toContain('color-mix');
  });
});

/**
 * The filtered empty state (M16.19).
 *
 * A board emptied by its own filters said "No items yet", which reads as "this
 * collection is empty" and sends people looking for the records rather than
 * for the filter that hid them. Every other layout already said which it was.
 */
describe('BoardView empty state (M16.19)', () => {
  it('says the filters are what emptied it', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(<BoardView entries={[]} presentation={presentation} schema={schema} filtered />);
    expect(screen.getByText('Nothing matches these filters')).toBeTruthy();
  });
});

/**
 * Keyboard and create semantics (M15).
 *
 * dnd-kit's `attributes` stamp role="button" and tabIndex=0 on each card, so
 * the board advertised every card as a button and then did nothing on Enter —
 * a dead focus stop. And quick-add passed the raw group key, so a card made in
 * a person column wrote a bare string where a wikilink belongs.
 */
describe('BoardView keyboard and create (M15)', () => {
  const byPerson: Presentation = { ...presentation, group: [{ field: 'assignee' }] };

  it('opens a card on Enter', async () => {
    const user = userEvent.setup();
    const entries = fixtureVault();
    useVaultStore.setState({ entries });
    useUiStore.setState({ detailPath: null });
    const schema = buildSchema(entries);
    const items = entries.filter((e) => e.path === 'projects/onboarding/items/fld-1.md');
    render(
      <BoardView filtered={false} entries={items} presentation={presentation} schema={schema} />,
    );
    const card = screen.getByTestId('board-card');
    card.focus();
    await user.keyboard('{Enter}');
    expect(useUiStore.getState().detailPath).toBe('projects/onboarding/items/fld-1.md');
  });

  it('hands the create path the column’s raw key, not a pre-wrapped one', async () => {
    const user = userEvent.setup();
    const entries = fixtureVault();
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    const items = entries.filter(
      (e) => e.path.startsWith('projects/onboarding/items/') && e.parseError === null,
    );
    const onCreate = vi.fn().mockResolvedValue(true);
    render(
      <BoardView
        filtered={false}
        entries={items}
        presentation={byPerson}
        schema={schema}
        onCreate={onCreate}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'New record in Ana Rios' }));
    await user.type(
      screen.getByRole('textbox', { name: 'New record in Ana Rios' }),
      'Draft{Enter}',
    );
    // M20.1: the board used to wrap this itself, because `createTarget` wrote
    // whatever it was handed verbatim — which is why the TABLE's create path,
    // which never wrapped, produced `epic: Bonsai` and a link that did not
    // exist. The rule now lives in `createTarget` for every surface, so
    // wrapping here as well would write `[[[[ana-rios]]]]`. See
    // createRecord.test.ts for the wrapping itself.
    expect(onCreate).toHaveBeenCalledWith('Draft', {
      groupBy: 'assignee',
      groupValue: 'ana-rios',
    });
  });

  // M16.19: the kind came off `entries[0]`, so one card of a type that does
  // not declare the grouped field — routine on a Collection that holds more
  // than one type — answered "undefined" for the whole board and the wikilink
  // wrapping silently stopped happening. The wrapping moved to `createTarget`
  // in M20.1 and `bandKind` still answers the kind; what is pinned here is
  // that the board's own payload does not vary with card order.
  it('passes the same key whichever card cannot resolve the grouped field', async () => {
    const user = userEvent.setup();
    const entries = fixtureVault();
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    const project = entries.find((e) => e.path === 'projects/onboarding/project.md')!;
    const fld1 = entries.find((e) => e.path === 'projects/onboarding/items/fld-1.md')!;
    const onCreate = vi.fn().mockResolvedValue(true);
    render(
      <BoardView
        filtered={false}
        entries={[project, fld1]}
        presentation={byPerson}
        schema={schema}
        onCreate={onCreate}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'New record in Ana Rios' }));
    await user.type(
      screen.getByRole('textbox', { name: 'New record in Ana Rios' }),
      'Draft{Enter}',
    );
    expect(onCreate).toHaveBeenCalledWith('Draft', {
      groupBy: 'assignee',
      groupValue: 'ana-rios',
    });
  });
});

describe('bandKind', () => {
  it('answers with the first entry that declares the field, not the first entry', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const project = entries.find((e) => e.path === 'projects/onboarding/project.md')!;
    const fld1 = entries.find((e) => e.path === 'projects/onboarding/items/fld-1.md')!;
    expect(schema.resolveField(project, 'assignee').def).toBeNull();
    expect(bandKind([project, fld1], 'assignee', schema)).toBe('person');
  });

  it('is undefined when nothing declares the field, so no write branch is taken on a guess', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    expect(bandKind(entries, 'nonexistent', schema)).toBeUndefined();
  });
});

describe('handleDragEnd', () => {
  const entries = fixtureVault();
  const schema = buildSchema(entries);
  const items = entries.filter(
    (e) =>
      e.path.startsWith('projects/onboarding/items/') &&
      e.path !== 'projects/onboarding/items/broken.md',
  );
  const columns = dropTargets(items, 'status', schema);

  it('patches the dragged entry frontmatter and toasts the target label', () => {
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const event = {
      active: { id: 'projects/onboarding/items/fld-1.md' },
      over: { id: 'doing' },
    } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', columns, schema, patchFrontmatter, toast });
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-1.md', {
      status: 'doing',
    });
    expect(toast).toHaveBeenCalledWith('Moved to Doing');
  });

  it('is a no-op when dropped on the source column', () => {
    const patchFrontmatter = vi.fn();
    const toast = vi.fn();
    const event = {
      active: { id: 'projects/onboarding/items/fld-1.md' },
      over: { id: 'todo' },
    } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', columns, schema, patchFrontmatter, toast });
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('writes null when dropped on the no-value column', () => {
    // The fixture items all carry a status, so groupEntries emits no
    // '__none__' group here; append a hand-built one so the no-value drop
    // target exists (boards render it whenever present).
    const noneColumn: BoardColumnNode = {
      path: '__none__',
      key: '__none__',
      label: 'No status',
      color: null,
      ghost: true,
      entries: [],
      lane: null,
    };
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const event = {
      active: { id: 'projects/onboarding/items/fld-1.md' },
      over: { id: '__none__' },
    } as unknown as DragEndEvent;
    handleDragEnd(event, {
      groupBy: 'status',
      columns: [...columns, noneColumn],
      schema,
      patchFrontmatter,
      toast,
    });
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-1.md', {
      status: null,
    });
  });

  it('is a no-op when dropped outside any column', () => {
    const patchFrontmatter = vi.fn();
    const event = {
      active: { id: 'projects/onboarding/items/fld-1.md' },
      over: null,
    } as unknown as DragEndEvent;
    handleDragEnd(event, { groupBy: 'status', columns, schema, patchFrontmatter, toast: vi.fn() });
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });

  // M1.x interim: a drop on a multi-select-grouped board would overwrite the
  // whole array with one scalar — refuse with a toast until add/remove exists.
  it('refuses drops when grouping by a multi-select field', () => {
    const patchFrontmatter = vi.fn();
    const toast = vi.fn();
    const multiSchema = {
      resolveField: () => ({
        def: { name: 'tags', kind: 'multiselect' },
        raw: ['a'],
        display: 'a',
        color: null,
        ghost: false,
      }),
    } as unknown as Schema;
    const dragged = items[0];
    const msColumns: BoardColumnNode[] = [
      {
        path: 'a',
        key: 'a',
        label: 'A',
        color: null,
        ghost: false,
        entries: [dragged],
        lane: null,
      },
      { path: 'b', key: 'b', label: 'B', color: null, ghost: false, entries: [], lane: null },
    ];
    const event = { active: { id: dragged.path }, over: { id: 'b' } } as unknown as DragEndEvent;
    handleDragEnd(event, {
      groupBy: 'tags',
      columns: msColumns,
      schema: multiSchema,
      patchFrontmatter,
      toast,
    });
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Can't move cards grouped by a multi-select field");
  });

  it('wraps the written value as a wikilink when the grouped field is person/relation-kind', () => {
    // Execution-log note 18: a bare-stem write (`assignee: ana-rios`) destroys
    // the wikilink on disk — relationships.assignee is gone after rescan.
    const personColumns = dropTargets(items, 'assignee', schema);
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const event = {
      active: { id: 'projects/onboarding/items/fld-2.md' },
      over: { id: 'ana-rios' },
    } as unknown as DragEndEvent;
    handleDragEnd(event, {
      groupBy: 'assignee',
      columns: personColumns,
      schema,
      patchFrontmatter,
      toast,
    });
    expect(patchFrontmatter).toHaveBeenCalledWith('projects/onboarding/items/fld-2.md', {
      assignee: '[[ana-rios]]',
    });
    expect(toast).toHaveBeenCalledWith('Moved to Ana Rios');
  });

  // M16.19: a lane is the second band level, so a card dropped in another lane
  // has changed two values. Writing only the column's meant the card visibly
  // snapped back into the lane it came from.
  it('writes the lane field too when the drop crosses a swimlane', () => {
    const withPerson = makeEntry({
      path: 'projects/onboarding/items/fld-9.md',
      type: 'Work item',
      properties: { key: 'FLD-9', status: 'todo' },
      relationships: { assignee: ['ana-rios'] },
    });
    const laneA: BoardColumnNode['lane'] = {
      field: 'assignee',
      key: 'ana-rios',
      label: 'Ana Rios',
    };
    const laneB: BoardColumnNode['lane'] = {
      field: 'assignee',
      key: '__none__',
      label: 'No assignee',
    };
    const laneColumns: BoardColumnNode[] = [
      ...dropTargets([withPerson], 'status', schema, laneA),
      // The unassigned lane holds nothing, so its columns are the declared
      // statuses with no entries — exactly what groupTree emits there.
      {
        path: '__none__/doing',
        key: 'doing',
        label: 'Doing',
        color: null,
        ghost: false,
        entries: [],
        lane: laneB,
      },
    ];
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    const toast = vi.fn();
    const event = {
      active: { id: withPerson.path },
      over: { id: '__none__/doing' },
    } as unknown as DragEndEvent;
    handleDragEnd(event, {
      groupBy: 'status',
      columns: laneColumns,
      schema,
      patchFrontmatter,
      toast,
    });
    expect(patchFrontmatter).toHaveBeenCalledWith(withPerson.path, {
      status: 'doing',
      assignee: null,
    });
  });
});

/**
 * Where a card drag lands (M46.2 Task 5).
 *
 * The geometry is described rather than measured, because jsdom measures
 * nothing: a lane is stated as column boxes at a pitch, and the extents fall
 * out of it — so the same sweep runs over a family of boards rather than over
 * one screenshot.
 */
describe('resolveBoardColumn', () => {
  const WIDTH = 280;
  const GAP = 12;
  const HEIGHT = 400;
  /** `lanes` rows of `n` columns each, laid out the way BoardView lays them. */
  const layout = (lanes: { key: string; columns: number }[]): BoardTarget[] => {
    const targets: BoardTarget[] = [];
    let top = 0;
    for (const lane of lanes) {
      for (let i = 0; i < lane.columns; i += 1) {
        const left = i * (WIDTH + GAP);
        targets.push({
          id: `${lane.key}/c${i}`,
          lane: lane.key,
          rect: { top, bottom: top + HEIGHT, left, right: left + WIDTH },
        });
      }
      top += HEIGHT + 32;
    }
    return targets;
  };

  it('lights a column at EVERY pixel across a lane — no dead band', () => {
    // The rule's whole point, and the defect the baseline measured on the
    // canvas (§D7): with an overlap test, targets are live only where the
    // dragged rect touches them and the indicator blinks out between them.
    // Here the 12px gutters between columns belong to a column too.
    const targets = layout([{ key: '', columns: 3 }]);
    const from = Math.min(...targets.map((t) => t.rect.left));
    const to = Math.max(...targets.map((t) => t.rect.right));
    for (let x = from; x <= to; x += 1) {
      expect(resolveBoardColumn({ x, y: 200 }, targets)).not.toBeNull();
    }
  });

  it('flips between two columns at the middle of the gutter they share', () => {
    // Column 0 spans x 0..280 and column 1 spans 292..572, so their centres
    // are 140 and 432 and the flip is at 286 — Notion's above/below midpoint
    // rule (§C-II.4) read sideways.
    const targets = layout([{ key: '', columns: 2 }]);
    expect(resolveBoardColumn({ x: 285, y: 200 }, targets)).toBe('/c0');
    expect(resolveBoardColumn({ x: 287, y: 200 }, targets)).toBe('/c1');
  });

  it('resolves the SWIMLANE first, so a card can be pointed into another lane', () => {
    // The same x in two lanes is two different columns. An overlap test scored
    // by the dragged card's own box could hand a card straddling both lanes to
    // the wrong one; the pointer says which lane it is in.
    const targets = layout([
      { key: 'alpha', columns: 2 },
      { key: 'beta', columns: 2 },
    ]);
    expect(resolveBoardColumn({ x: 100, y: 200 }, targets)).toBe('alpha/c0');
    expect(resolveBoardColumn({ x: 100, y: 600 }, targets)).toBe('beta/c0');
  });

  it('the vertical gap BETWEEN two lanes belongs to one of them, not to nothing', () => {
    // 32px of swimlane heading and margin separates the lanes and no column
    // occupies it; the midpoint partition still hands every pixel to a lane.
    const targets = layout([
      { key: 'alpha', columns: 1 },
      { key: 'beta', columns: 1 },
    ]);
    for (let y = HEIGHT; y <= HEIGHT + 32; y += 1) {
      expect(resolveBoardColumn({ x: 100, y }, targets)).not.toBeNull();
    }
  });

  it('carrying a card off the board commits nothing', () => {
    // Off the ends is deliberately still no target, as everywhere else this
    // rule is spent: dragging a card out past the last column and letting go
    // is not a drop.
    const targets = layout([{ key: '', columns: 2 }]);
    expect(resolveBoardColumn({ x: 700, y: 200 }, targets)).toBeNull();
    expect(resolveBoardColumn({ x: -40, y: 200 }, targets)).toBeNull();
    expect(resolveBoardColumn({ x: 100, y: -40 }, targets)).toBeNull();
    expect(resolveBoardColumn({ x: 100, y: 900 }, targets)).toBeNull();
  });

  it('a lane key is read from the target, never parsed out of its path', () => {
    // Column paths are `groupTree`'s to shape and a band key is a frontmatter
    // value, so two lanes' columns can share every prefix a parser could take.
    // These two are written so that deriving the lane from the id — the
    // dashboard's rule, which its own slot ids can afford — collapses them
    // into one lane called `g`, and a pointer sitting in the LOWER lane then
    // resolves to a column of the upper one.
    const targets: BoardTarget[] = [
      { id: 'g/c0', lane: 'alpha', rect: { top: 0, bottom: 100, left: 0, right: 280 } },
      { id: 'g/c1', lane: 'beta', rect: { top: 300, bottom: 400, left: 292, right: 572 } },
    ];
    expect(resolveBoardColumn({ x: 100, y: 50 }, targets)).toBe('g/c0');
    expect(resolveBoardColumn({ x: 400, y: 350 }, targets)).toBe('g/c1');
    // The lower lane holds no column at x 100, so pointing there is off the
    // end of that lane — never a reach back up into the lane above.
    expect(resolveBoardColumn({ x: 100, y: 350 }, targets)).toBeNull();
  });

  // GUARD, not a behaviour: a board with no columns renders an empty state
  // and no DndContext, so nothing can reach this. It is here because the two
  // stages both spread rects into `Math.min`/`Math.max`, and an empty spread
  // is `Infinity` — a shape that answers "everywhere" rather than "nowhere".
  it('an empty board offers nothing to hit (guard)', () => {
    expect(resolveBoardColumn({ x: 0, y: 0 }, [])).toBeNull();
  });
});

/**
 * A live card drag owns Escape (M46.2).
 *
 * dnd-kit cancels the drag correctly, but from a `document` bubble listener
 * with no `preventDefault` and no `stopPropagation` — so the same keystroke
 * also reached the record panel or dialog behind the board. The fix is a
 * `'gesture'` layer for the drag's life, never a capture listener: swallowing
 * the key would stop it before dnd-kit's own handler ran, and cancel nothing.
 */
describe('a live board drag owns Escape (M46.2)', () => {
  beforeEach(() => resetLayers());
  afterEach(() => resetLayers());

  const announced = () =>
    [...document.querySelectorAll('[role="status"]')].map((n) => n.textContent).join(' ');

  function board() {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const items = entries.filter((e) => e.path.startsWith('projects/onboarding/items/'));
    render(
      <BoardView filtered={false} entries={items} presentation={presentation} schema={schema} />,
    );
  }

  /**
   * The keyboard sensor's pick-up. The await is not optional:
   * `KeyboardSensor.attach` adds its own keydown listener inside a
   * `setTimeout(0)`, so a synchronous Escape never reaches dnd-kit at all.
   */
  const pickUp = async () => {
    const card = screen.getAllByTestId('board-card')[0];
    card.focus();
    fireEvent.keyDown(card, { key: ' ', code: 'Space' });
    // Vacuity guard: with no drag in flight this case is about nothing.
    // Matched on the ITEM rather than on the pick-up sentence, because since
    // M46.2 Task 5 the board resolves a column from the pointer — or, for this
    // keyboard drag, from the card's own centre — so a drag has a target from
    // its first frame and the pick-up announcement is superseded by the first
    // "moved over" in the same tick. Either sentence proves what the guard is
    // for: a drag is live, and it is this card's.
    expect(announced()).toContain(card.getAttribute('data-path'));
    await new Promise((r) => setTimeout(r, 0));
    return card;
  };

  it('takes Escape off the surface underneath, and hands it back on the cancel', async () => {
    board();
    // What DetailPanel and Dialog both register; their handlers ask the stack
    // who owns the keystroke.
    pushLayer('panel');
    /**
     * And a REAL listener in DetailPanel's own phase, because the two
     * `ownsEscape` assertions around this cannot answer the question that
     * matters: they read the stack BEFORE and AFTER the keystroke, while the
     * defect the review found was a layer released DURING it — dnd-kit cancels
     * from `document` bubble, one phase before the `window` bubble the panel
     * listens on. App.tsx stands the board and the record panel side by side,
     * so this is the shipped arrangement, not a contrived one.
     */
    const panelClosed = vi.fn();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ownsEscape('panel')) panelClosed();
    };
    window.addEventListener('keydown', onKey);

    try {
      const card = await pickUp();
      expect(ownsEscape('panel')).toBe(false);

      fireEvent.keyDown(card, { key: 'Escape', code: 'Escape' });

      // dnd-kit's cancel still ran — the proof that the layer did not swallow.
      expect(announced()).toContain('Dragging was cancelled');
      expect(panelClosed).not.toHaveBeenCalled();
      // Handed back, but only once the dispatch is over.
      await new Promise((r) => setTimeout(r, 0));
      expect(ownsEscape('panel')).toBe(true);
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });

  it('hands the layer back on a drop too', async () => {
    board();
    pushLayer('panel');
    const card = await pickUp();
    // Space again is the keyboard sensor's DROP, not a cancel.
    fireEvent.keyDown(card, { key: ' ', code: 'Space' });
    expect(ownsEscape('panel')).toBe(true);
  });

  it('hands the layer back when the board unmounts mid-drag', async () => {
    board();
    pushLayer('panel');
    await pickUp();

    cleanup();

    // A leaked gesture layer sits on the stack forever, and every later Escape
    // in the app finds it there instead of the surface it was aimed at.
    expect(ownsEscape('panel')).toBe(true);
  });

  it('sends a 40% clone and leaves the card where it was (M46.2)', async () => {
    board();
    const card = screen.getAllByTestId('board-card')[0];
    expect(card.getAttribute('data-drag-id')).toBe(card.getAttribute('data-path'));
    expect(screen.queryByTestId('drag-layer')).toBeNull();

    await pickUp();

    const ghost = screen.getByTestId('drag-ghost');
    expect(ghost.style.opacity).toBe('0.4');
    expect(ghost.children).toHaveLength(1);
    // The third grammar, gone: the card used to BE the ghost — translated at
    // 1:1 pointer delta, dimmed to 0.6 and lifted to z-index 20, leaving a
    // hole behind it (baseline §D2/D3). It stays put, at full strength.
    expect(card.style.opacity).toBe('');
    expect(card.style.zIndex).toBe('');
    expect(card.style.transform).toBe('');
    // A duplicated `data-testid` would make `getAllByTestId('board-card')`
    // count double for the length of every drag.
    expect(ghost.querySelectorAll('[data-testid]')).toHaveLength(0);
  });

  it('the ghost and the lit line go together on Escape (M46.2)', async () => {
    board();
    const card = await pickUp();
    const lit = () =>
      [...document.querySelectorAll('[data-line]')].filter(
        (l) => l.getAttribute('data-lit') === 'true',
      );
    // One pointer, one column — jsdom's rects are all 0x0, so WHICH column is
    // arbitrary here and only the count is the claim.
    expect(lit()).toHaveLength(1);
    // Both halves have to be there for "go together" to mean anything.
    expect(screen.queryByTestId('drag-layer')).not.toBeNull();

    fireEvent.keyDown(card, { key: 'Escape', code: 'Escape' });

    expect(screen.queryByTestId('drag-layer')).toBeNull();
    expect(lit()).toHaveLength(0);
  });
});

/**
 * The board's drop indicator (M46.2 Task 5).
 *
 * It was a whole-column background wash — `--cortex-50` at full opacity over a
 * measured 280 x 2040px area, no transition, and carrying no position at all
 * (baseline §D4). It is the reference's measured COLUMN variant now.
 */
describe('BoardView drop indicator (M46.2)', () => {
  beforeEach(() => resetLayers());
  afterEach(() => resetLayers());

  const boardOf = (extra?: Partial<Presentation>) => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const items = entries.filter((e) => e.path.startsWith('projects/onboarding/items/'));
    render(
      <BoardView
        filtered={false}
        entries={items}
        presentation={{ ...presentation, ...extra }}
        schema={schema}
      />,
    );
  };

  it('every column wears its own line, hugging the column and nothing wider', () => {
    boardOf();
    const columns = screen.getAllByTestId('board-column');
    expect(columns.length).toBeGreaterThan(1);
    for (const column of columns) {
      const path = column.getAttribute('data-column-path');
      const line = document.querySelector(`[data-line="${path}"]`);
      // A child of the TARGET (§C-II.3), so it takes that column's own box
      // rather than a fixed width the container chose.
      expect(line?.closest('[data-testid="board-column"]')).toBe(column);
    }
    // Exactly one line per column — a second host would light one drop point
    // twice.
    expect(document.querySelectorAll('[data-line]')).toHaveLength(columns.length);
  });

  it('a sub-grouped board draws one line per column, in every lane', () => {
    // The lane case is the one a path-parsing shortcut breaks: every lane has
    // a "Doing", so a line keyed on the group KEY would light N columns at
    // once. It is keyed on the column's path, which is unique per node.
    boardOf({ group: [{ field: 'status' }, { field: 'assignee' }] });
    expect(screen.getAllByTestId('board-swimlane').length).toBeGreaterThan(1);
    const columns = screen.getAllByTestId('board-column');
    for (const column of columns) {
      const line = column.querySelector('[data-line]');
      expect(line?.getAttribute('data-line')).toBe(column.getAttribute('data-column-path'));
    }
    expect(document.querySelectorAll('[data-line]')).toHaveLength(columns.length);
  });

  it('the line carries the measured values, and starts unlit', () => {
    boardOf();
    const line = document.querySelector('[data-line]');
    // 4px on the leading edge, full height, accent at 43%, radius 0,
    // z-index 88, pointer-transparent — and `motion-move`, so travel between
    // two columns cross-fades over one declared duration instead of snapping.
    expect(line?.className).toContain('w-1');
    expect(line?.className).toContain('inset-y-0');
    expect(line?.className).toContain('start-0');
    expect(line?.className).toContain('bg-cortex-500/43');
    expect(line?.className).toContain('rounded-none');
    expect(line?.className).toContain('z-[88]');
    expect(line?.className).toContain('pointer-events-none');
    expect(line?.className).toContain('motion-move');
    expect(line?.className).toContain('opacity-0');
    expect(line?.getAttribute('data-side')).toBe('start');
  });

  it('an empty column is a target like any other, with no special case', () => {
    // "Done" holds nothing in the fixture. The line is a child of the COLUMN,
    // so a column with no cards has the same target and the same mark as a
    // full one — which is the reason the indicator is not hung on a card.
    boardOf();
    const done = screen
      .getAllByTestId('board-column')
      .find((c) => c.getAttribute('data-group-key') === 'done');
    expect(done?.querySelectorAll('[data-testid="board-card"]')).toHaveLength(0);
    expect(done?.querySelector('[data-line]')).not.toBeNull();
  });

  it('the column under the pointer paints no wash — the line says it instead', async () => {
    // Asserted with a drag IN FLIGHT and a column actually `isOver`. Read at
    // rest this case could not tell the wash from its own absence: nothing is
    // over anything, so the old `isOver ? 'var(--cortex-50)' : tint` and a
    // plain `tint` render the same bytes.
    boardOf({ colorColumns: true });
    const card = screen.getAllByTestId('board-card')[0];
    card.focus();
    fireEvent.keyDown(card, { key: ' ', code: 'Space' });
    await new Promise((r) => setTimeout(r, 0));
    // Vacuity guard: a column IS the target, so a wash would be painted now.
    const lit = [...document.querySelectorAll('[data-line]')].filter(
      (l) => l.getAttribute('data-lit') === 'true',
    );
    expect(lit).toHaveLength(1);

    for (const column of screen.getAllByTestId('board-column')) {
      const stack = column.querySelector<HTMLElement>('[data-tinted]');
      expect(stack?.style.background).not.toContain('cortex');
    }
    // And the tinted column still shows the colour the user chose for it.
    const tinted = screen
      .getAllByTestId('board-column')
      .map((c) => c.querySelector<HTMLElement>('[data-tinted]')?.style.background)
      .filter((bg) => bg !== undefined && bg !== '' && bg !== 'transparent');
    expect(tinted.length).toBeGreaterThan(0);
    fireEvent.keyDown(card, { key: 'Escape', code: 'Escape' });
  });
});
