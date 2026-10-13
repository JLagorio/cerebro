import { describe, expect, it } from 'vitest';
import { planFor, type Layout, type Plan } from './ConceptTable';

/**
 * Which columns a width holds (M52.5). The title is the one thing never cut;
 * the summary takes whatever room the columns leave, and once it is gone the
 * concept takes it — a column that steps aside hands its width to the one
 * that squeezes, never to an empty strip at the row's end.
 *
 * The widths: a 46px gutter, Status as measured (180 here, the default),
 * Sources 104, Written by 170, Updated 104, Folder 130. So a 380px title
 * leaves the summary `width - 984` with every filed column drawn.
 */

/** The row's drawn width: the gutter and every column, the filling one at
 * what the plan gives it. */
const drawn = (plan: Plan) =>
  46 + plan.columns.reduce((sum, column) => sum + (plan.widths[column] ?? NaN), 0);

describe('planFor', () => {
  it('draws every column before anything is laid out, and sets no floor', () => {
    const plan = planFor('filed', null, 400);
    expect(plan.columns).toEqual(['concept', 'summary', 'status', 'sources', 'author', 'updated']);
    expect(plan.fill).toBe('summary');
    expect(plan.wrap).toBe(false);
    expect(plan.minWidth).toBeNull();
  });

  it('gives the concept its longest title, never under 320px', () => {
    expect(planFor('filed', 2000, 380).widths.concept).toBe(380);
    expect(planFor('filed', 2000, 200).widths.concept).toBe(320);
    // No ceiling while the summary has room to give: a 520px cap wrapped a
    // long title beside a summary with 380px of blank room.
    expect(planFor('filed', 2000, 900).widths.concept).toBe(900);
  });

  it('wraps a long title only once Summary and Updated are both gone', () => {
    // The summary gives up its room to a long title…
    const wide = planFor('filed', 2000, 900);
    expect(wide.columns).toEqual(['concept', 'summary', 'status', 'sources', 'author', 'updated']);
    expect(wide.widths.summary).toBe(2000 - 46 - 900 - 180 - 104 - 170 - 104);
    expect(wide.wrap).toBe(false);
    // …then Sources and Written by step aside so it keeps 200px beside it…
    const mid = planFor('filed', 1430, 900);
    expect(mid.columns).toEqual(['concept', 'summary', 'status', 'updated']);
    expect(mid.wrap).toBe(false);
    // …then the summary goes, and the concept keeps its width beside Updated…
    const noSummary = planFor('filed', 1300, 900);
    expect(noSummary.columns).toEqual(['concept', 'status', 'updated']);
    expect(noSummary.wrap).toBe(false);
    // …and only with Updated gone too does it wrap, rather than being cut.
    const wrapping = planFor('filed', 1100, 900);
    expect(wrapping.columns).toEqual(['concept', 'status']);
    expect(wrapping.widths.concept).toBe(1100 - 46 - 180);
    expect(wrapping.wrap).toBe(true);
  });

  it('sizes Status to its widest word, never below a floor', () => {
    expect(planFor('filed', 2000, 380, 150).widths.status).toBe(150);
    expect(planFor('filed', 2000, 380, 60).widths.status).toBe(110);
  });

  it('keeps every column while the summary gets 200px', () => {
    const plan = planFor('filed', 1184, 380);
    expect(plan.columns).toEqual(['concept', 'summary', 'status', 'sources', 'author', 'updated']);
    expect(plan.widths.summary).toBe(200);
    expect(plan.minWidth).toBe(984);
  });

  it('sets Sources aside, then Written by, and hands their width to the summary', () => {
    // 1183 would leave the summary 199px: Sources goes, and it gets 303.
    const one = planFor('filed', 1183, 380);
    expect(one.columns).toEqual(['concept', 'summary', 'status', 'author', 'updated']);
    expect(one.widths.summary).toBe(303);
    expect(planFor('filed', 1079, 380).columns).toEqual([
      'concept',
      'summary',
      'status',
      'updated',
    ]);
  });

  it('drops the summary only when it would get less than 200px, and the concept takes its room', () => {
    expect(planFor('filed', 910, 380).columns).toContain('summary');
    const narrow = planFor('filed', 909, 380);
    expect(narrow.columns).toEqual(['concept', 'status', 'updated']);
    // The 199px the summary would have had goes to the titles, not to an
    // empty strip after Updated.
    expect(narrow.fill).toBe('concept');
    expect(narrow.widths.concept).toBe(909 - 46 - 180 - 104);
    expect(narrow.wrap).toBe(false);
  });

  it('drops Updated before a title wraps, and wraps only once it is gone', () => {
    // The titles' width beside Updated: still there, and nothing wraps…
    const fits = planFor('filed', 710, 380);
    expect(fits.columns).toEqual(['concept', 'status', 'updated']);
    expect(fits.widths.concept).toBe(380);
    expect(fits.wrap).toBe(false);
    // …and a pixel under it, Updated goes and the concept has its width back
    // — rows of one, two and three lines were never a view's.
    const dropped = planFor('filed', 709, 380);
    expect(dropped.columns).toEqual(['concept', 'status']);
    expect(dropped.widths.concept).toBe(709 - 46 - 180);
    expect(dropped.wrap).toBe(false);
    // Only narrower than the titles with Updated gone do they wrap.
    const wrapping = planFor('filed', 600, 380);
    expect(wrapping.columns).toEqual(['concept', 'status']);
    expect(wrapping.widths.concept).toBe(600 - 46 - 180);
    expect(wrapping.wrap).toBe(true);
  });

  it('never draws Summary or Updated beside wrapping titles, nor Updated beside a concept under 320px', () => {
    for (const layout of ['filed', 'queue'] as Layout[]) {
      for (const title of [200, 320, 380, 520, 600, 900]) {
        for (let width = 300; width <= 2400; width += 3) {
          const plan = planFor(layout, width, title);
          const at = `${layout} ${title} at ${width}`;
          // Titles wrap beside the status alone: every other column has gone.
          if (plan.wrap) expect(plan.columns, at).toEqual(['concept', 'status']);
          if (!plan.columns.includes('updated')) continue;
          expect(plan.widths.concept ?? NaN, at).toBeGreaterThanOrEqual(320);
          expect(plan.wrap, at).toBe(false);
        }
      }
    }
  });

  it('keeps the status on screen beside wrapped titles, and scrolls below that', () => {
    const cramped = planFor('filed', 400, 380);
    expect(cramped.columns).toEqual(['concept', 'status']);
    // The concept wraps down to 200px so the status keeps its place…
    expect(cramped.widths.concept).toBe(200);
    expect(cramped.wrap).toBe(true);
    // …and the table's floor is that: narrower, its box scrolls sideways.
    expect(cramped.minWidth).toBe(46 + 200 + 180);
  });

  it('never leaves empty room at the row end while the table fits its box', () => {
    for (const layout of ['filed', 'queue'] as Layout[]) {
      for (const title of [250, 380, 600]) {
        for (let width = 300; width <= 2400; width += 7) {
          const plan = planFor(layout, width, title);
          if (plan.minWidth !== null && width >= plan.minWidth) {
            expect(drawn(plan), `${layout} ${title} at ${width}`).toBe(width);
          }
        }
      }
    }
  });

  it('keeps the queue folder longest of the columns that step aside for the summary', () => {
    expect(planFor('queue', 1314, 380).columns).toContain('sources');
    expect(planFor('queue', 1313, 380).columns).toEqual([
      'concept',
      'summary',
      'status',
      'folder',
      'author',
      'updated',
    ]);
    expect(planFor('queue', 1209, 380).columns).toEqual([
      'concept',
      'summary',
      'status',
      'folder',
      'updated',
    ]);
    expect(planFor('queue', 1039, 380).columns).toEqual([
      'concept',
      'summary',
      'status',
      'updated',
    ]);
    expect(planFor('queue', 909, 380).columns).toEqual(['concept', 'status', 'updated']);
  });
});
