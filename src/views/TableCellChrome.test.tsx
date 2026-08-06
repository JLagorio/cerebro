import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TableView } from '@/views/TableView';
import { FieldEditor } from '@/detail/FieldEditor';
import { buildSchema } from '@/engine/schema';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault, makeEntry } from '@/test/factories';
import type { Entry, Presentation } from '@/engine/types';

/**
 * Table cell chrome at rest (M16.35).
 *
 * Measured against Notion's own table: an unset cell is completely blank, no
 * cell anywhere carries a dropdown chevron at rest, and the Due column is
 * plain text with no calendar glyph. Cerebro painted 450 <svg> at full opacity
 * in one viewport of cells, plus a calendar and the word "Empty" on every
 * empty date.
 *
 * These pin the half of the fix that applies to cells that DO hold a value —
 * the chevron and the calendar are still in the DOM there, and it is the
 * stylesheet that keeps them off the screen until the row is live.
 */

/**
 * The real rule set, not a copy of it. A test that pastes in the CSS it is
 * checking proves only that the paste agrees with itself; reading the shipped
 * file means deleting a selector fails here.
 *
 * jsdom computes `visibility` from a stylesheet and matches attribute
 * selectors and `:is()`, which is why the rules use visibility rather than
 * opacity — that, and because a hidden glyph must keep its box so revealing it
 * cannot shift the value beside it.
 */
const CHROME_CSS_PATH = resolve(process.cwd(), 'src/styles/table-chrome.css');

function mountChromeStyles(): void {
  const el = document.createElement('style');
  el.dataset.testStyles = 'table-chrome';
  el.textContent = readFileSync(CHROME_CSS_PATH, 'utf8');
  document.head.append(el);
}

const presentation: Presentation = {
  type: 'table',
  group: [],
  sort: [{ field: 'title', dir: 'asc' }],
  columns: [{ field: 'status' }, { field: 'due' }, { field: 'assignee' }],
};

/** Work items that all three columns actually have a value for — the resting
 * state this is about is a FILLED cell, since an empty one draws nothing at
 * all now (see TableCellEmpty). */
function filledVault(): Entry[] {
  return [
    ...fixtureVault().filter((e) => e.type !== 'Work item'),
    makeEntry({
      path: 'projects/onboarding/items/fld-9.md',
      title: 'Design first-run flow',
      type: 'Work item',
      properties: { status: 'todo', priority: 'high', due: '2025-01-10' },
      relationships: { assignee: ['ana-rios'] },
    }),
    makeEntry({
      path: 'projects/onboarding/items/fld-10.md',
      title: 'Wire field sync banner',
      type: 'Work item',
      properties: { status: 'doing', priority: 'low', due: '2025-02-04' },
      relationships: { assignee: ['ana-rios'] },
    }),
  ];
}

function setup() {
  const entries = filledVault();
  useVaultStore.setState({ entries });
  const schema = buildSchema(entries);
  render(
    <TableView
      entries={entries.filter((e) => e.type === 'Work item')}
      presentation={presentation}
      schema={schema}
      fields={schema.types.get('Work item')?.fields ?? []}
    />,
  );
  return { entries, schema };
}

const rows = () => screen.getAllByTestId('table-row');
const vis = (el: Element) => getComputedStyle(el).visibility;
const chromeIn = (row: HTMLElement, icon: string) =>
  Array.from(row.querySelectorAll(`.cb-cell-chrome [data-icon='${icon}']`));
/** Just the classes that decide the row's box. The fill and the cursor rule
 * change with the cursor by design; a height or a padding must not. */
const boxClasses = (row: HTMLElement) =>
  Array.from(row.classList)
    .filter((c) => /^(min-)?[hp][-yxbtl]?-/.test(c))
    .sort();

afterEach(cleanup);

describe('TableView cell chrome at rest (M16.35)', () => {
  beforeEach(() => {
    document.head.querySelectorAll('[data-test-styles]').forEach((el) => el.remove());
    mountChromeStyles();
  });

  it('paints no dropdown chevron on a filled cell at rest', () => {
    setup();
    const row = rows()[0];
    const chevrons = chromeIn(row, 'chevron-down');
    // Status, person and relation cells each draw one — the point is not that
    // they are absent from the DOM (the popover trigger still needs its
    // affordance) but that none of them is on screen.
    expect(chevrons.length).toBeGreaterThan(0);
    for (const c of chevrons) expect(vis(c)).toBe('hidden');
  });

  it('paints no per-cell calendar glyph on a dated row at rest', () => {
    setup();
    const row = rows()[0];
    const calendars = chromeIn(row, 'calendar');
    expect(calendars.length).toBe(1);
    expect(vis(calendars[0])).toBe('hidden');
    // …while the date itself is exactly what Notion shows: plain text.
    expect(row.textContent).toContain('Jan 10, 2025');
  });

  it('keeps the value glyphs Notion also shows', () => {
    setup();
    const row = rows()[0];
    // The status dot: a coloured span, not chrome, and never hidden.
    const dot = row.querySelector('.cb-cell-chrome span[style*="background"]');
    expect(dot).not.toBeNull();
    expect(vis(dot!)).toBe('visible');
    // The person avatar, likewise — it IS the value.
    const avatar = screen.getAllByTitle('Ana Rios')[0];
    expect(vis(avatar)).toBe('visible');
    // And the row's type icon in the name cell, which sits outside the chrome
    // wrapper and so is untouched by these rules.
    const typeIcon = row.querySelector("[data-icon='circle-check']");
    expect(typeIcon).not.toBeNull();
    expect(vis(typeIcon!)).toBe('visible');
  });

  it('reveals the chrome on the row the keyboard cursor is on', () => {
    setup();
    const grid = screen.getByTestId('table-view');
    // Focus lands the cursor on row 0. It never leaves the container — the
    // grid is aria-activedescendant driven — so the reveal cannot key on
    // :focus-within alone, and this is the case that proves it.
    fireEvent.focus(grid, { target: grid });
    const [first, second] = rows();
    expect(first.getAttribute('data-focused')).toBe('true');
    for (const c of chromeIn(first, 'chevron-down')) expect(vis(c)).toBe('visible');
    expect(vis(chromeIn(first, 'calendar')[0])).toBe('visible');
    // Only that row: the rest of the grid stays quiet.
    for (const c of chromeIn(second, 'chevron-down')) expect(vis(c)).toBe('hidden');

    // …and moves with the cursor.
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    for (const c of chromeIn(rows()[0], 'chevron-down')) expect(vis(c)).toBe('hidden');
    for (const c of chromeIn(rows()[1], 'chevron-down')) expect(vis(c)).toBe('visible');
  });

  it('reserves the space, so revealing the chrome cannot reflow the row', () => {
    setup();
    const grid = screen.getByTestId('table-view');
    const before = rows()[0];
    const restBox = boxClasses(before);
    const restBoxes = chromeIn(before, 'chevron-down').map((c) => getComputedStyle(c).display);

    fireEvent.focus(grid, { target: grid });
    const after = rows()[0];

    // The row's box is untouched by the reveal: the 36px default (`h-9`) is
    // the same in both states. Only the fill and the cursor rule change, and
    // neither of those is a size.
    expect(restBox).toContain('h-9');
    expect(boxClasses(after)).toEqual(restBox);
    // `visibility`, never `display: none` — the hidden glyph still occupies
    // its box, so the value beside it does not slide sideways on hover.
    const liveBoxes = chromeIn(after, 'chevron-down').map((c) => getComputedStyle(c).display);
    expect(restBoxes).toEqual(liveBoxes);
    for (const d of restBoxes) expect(d).not.toBe('none');
  });

  it('reveals on the pointer and on real focus too, not on the cursor alone', () => {
    // jsdom matches neither :hover nor :focus-within, so the two selectors a
    // browser needs are asserted against the stylesheet itself. A hover-only
    // reveal is the bug this whole change is about; losing either of these
    // silently would reintroduce half of it.
    const css = readFileSync(CHROME_CSS_PATH, 'utf8');
    expect(css).toContain('.cb-row:hover');
    expect(css).toContain('.cb-row:focus-within');
    expect(css).toContain(".cb-row[data-focused='true']");
  });
});

/**
 * The other half of the ground truth, and the one that is easy to break while
 * fixing the first: Notion's RECORD PAGE does render an unset property as grey
 * "Empty", and Cerebro already matched it. The rules above are scoped under
 * `.cb-row`, which only a table row carries, so nothing here should move.
 */
describe('detail panel chrome is deliberately untouched (M16.35)', () => {
  beforeEach(() => {
    document.head.querySelectorAll('[data-test-styles]').forEach((el) => el.remove());
    mountChromeStyles();
  });

  it('keeps the ghost "Empty" and the chevron outside a table row', () => {
    const entries = fixtureVault();
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    const item = entries.find((e) => e.path.endsWith('fld-2.md'))!;
    const fields = schema.types.get('Work item')?.fields ?? [];
    const def = fields.find((f) => f.name === 'due')!;

    const { container } = render(<FieldEditor entry={item} def={def} schema={schema} />);

    expect(screen.getByText('Empty')).toBeTruthy();
    const calendar = container.querySelector("[data-icon='calendar']")!;
    expect(calendar).not.toBeNull();
    expect(vis(calendar)).toBe('visible');
  });

  /**
   * Mechanical, rather than a comment asking the next author to remember.
   *
   * `FieldEditor` is shared by the table, the record panel and the doc info
   * panel, so a rule in this file that forgets `.cb-row` silently restyles two
   * surfaces it was never about. The prose above has said so since M16.35; a
   * grep says it every time the suite runs.
   */
  it('every rule in table-chrome.css is scoped to a table row', () => {
    const css = readFileSync(CHROME_CSS_PATH, 'utf8');
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, '') // comments mention .cb-cell-chrome in prose
      .split('}')
      .map((block) => block.split('{')[0].trim())
      .filter((sel) => sel !== '');

    // Split on the commas that separate whole selectors, NOT the ones inside
    // `:is(…)` — the rules above are written as `:is(.cb-row:hover, …) :is(…)`,
    // and a naive split would tear a scoped selector into unscoped halves.
    const branches = (selector: string): string[] => {
      const out: string[] = [];
      let depth = 0;
      let current = '';
      for (const ch of selector) {
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) {
          out.push(current);
          current = '';
          continue;
        }
        current += ch;
      }
      out.push(current);
      return out;
    };

    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      // Every alternative, not just the first: a rule is only as scoped as its
      // loosest branch.
      for (const branch of branches(selector)) {
        expect(branch).toContain('.cb-row');
      }
    }
  });
});
