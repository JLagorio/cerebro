import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CalendarView } from '@/views/CalendarView';
import { columnUniverse } from '@/engine/columns';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import type { Entry, Presentation } from '@/engine/types';

const TODAY = '2026-08-12';

const presentation: Presentation = {
  type: 'calendar',
  group: [],
  sort: [],
  columns: [],
  dateField: 'window',
};

/** A Type doc declaring one daterange property, plus the records under it. */
function vault(records: Entry[]): Entry[] {
  return [
    makeEntry({
      path: 'types/campaign.md',
      title: 'Campaign',
      type: 'Type',
      properties: {
        icon: 'megaphone',
        fields: { window: { kind: 'daterange' } },
      } as unknown as Entry['properties'],
    }),
    ...records,
  ];
}

function setup(records: Entry[]) {
  const entries = vault(records);
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.type === 'Campaign');
  render(
    <CalendarView
      entries={items}
      presentation={presentation}
      schema={schema}
      fields={columnUniverse({ type: 'Campaign', project: null }, items, schema)}
      today={TODAY}
    />,
  );
}

const spanning = (slug: string, start: string, end: string) =>
  makeEntry({
    path: `records/campaigns/${slug}.md`,
    title: slug,
    type: 'Campaign',
    properties: { window: { start, end } } as unknown as Entry['properties'],
  });

afterEach(cleanup);

/**
 * The month grid (M15 fix).
 *
 * Every entry used to be re-rendered as its own chip in EVERY day its span
 * covered, so a two-week item was drawn fourteen times and all 42 cells showed
 * the same three truncated titles plus a "+N more". A month grid exists to
 * answer "what is happening when", and that made it unanswerable.
 */
describe('CalendarView continuous spans', () => {
  it('draws a multi-day span as one bar per week, not a chip per day', () => {
    // Aug 3 (Mon) → Aug 7 (Fri) sits inside a single week row.
    setup([spanning('launch', '2026-08-03', '2026-08-07')]);
    expect(screen.getAllByTestId('calendar-bar')).toHaveLength(1);
    // And it is NOT repeated as a per-day chip.
    expect(screen.queryAllByTestId('calendar-chip')).toHaveLength(0);
  });

  it('splits a span that crosses a week boundary into one bar per week row', () => {
    // Aug 3 → Aug 18 covers three week rows of the August grid.
    setup([spanning('long-haul', '2026-08-03', '2026-08-18')]);
    expect(screen.getAllByTestId('calendar-bar')).toHaveLength(3);
  });

  it('still keeps 42 day cells', () => {
    setup([spanning('launch', '2026-08-03', '2026-08-07')]);
    expect(screen.getAllByTestId('calendar-day')).toHaveLength(42);
  });

  it('renders a single-day record as a chip in its own cell only', () => {
    setup([spanning('standup', '2026-08-05', '2026-08-05')]);
    const chips = screen.getAllByTestId('calendar-chip');
    expect(chips).toHaveLength(1);
    expect(screen.queryAllByTestId('calendar-bar')).toHaveLength(0);
  });

  it('packs overlapping spans into separate lanes rather than stacking them', () => {
    setup([
      spanning('alpha', '2026-08-03', '2026-08-07'),
      spanning('beta', '2026-08-04', '2026-08-06'),
    ]);
    const bars = screen.getAllByTestId('calendar-bar');
    expect(bars).toHaveLength(2);
    // Different lanes means different vertical offsets.
    const tops = bars.map((b) => (b as HTMLElement).style.top);
    expect(new Set(tops).size).toBe(2);
  });
});
