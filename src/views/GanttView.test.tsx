import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { columnUniverse } from '@/engine/columns';
import { buildSchema } from '@/engine/schema';
import { PX_PER_DAY } from '@/engine/schedule';
import { makeEntry } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';
import { GanttView } from '@/views/GanttView';
import type { Entry, Presentation } from '@/engine/types';

/**
 * The gantt's half of M16.24. It already had a work breakdown, but as a
 * private `const NAME_W = 300` — not state, not a prop, not persisted — and
 * its bars had no drag handlers and a default zoom nothing else agreed with.
 */

const TODAY = '2026-08-12';

const base: Presentation = {
  type: 'gantt',
  group: [],
  sort: [],
  columns: [],
  dateField: 'window',
};

function setup(records: Entry[], patch: Partial<Presentation> = {}) {
  const entries = [
    makeEntry({
      path: 'types/work-item.md',
      title: 'Work item',
      type: 'Type',
      properties: {
        fields: { window: { kind: 'daterange' } },
      } as unknown as Entry['properties'],
    }),
    ...records,
  ];
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.type === 'Work item');
  useVaultStore.setState({ entries });
  render(
    <GanttView
      filtered={false}
      entries={items}
      presentation={{ ...base, ...patch }}
      schema={schema}
      fields={columnUniverse({ type: 'Work item', project: null }, items, schema)}
      today={TODAY}
    />,
  );
}

const task = (slug: string, start: string, end: string) =>
  makeEntry({
    path: `work/${slug}.md`,
    title: slug,
    type: 'Work item',
    properties: { window: { start, end } } as unknown as Entry['properties'],
  });

afterEach(cleanup);

describe('GanttView', () => {
  it('shows its work breakdown by default — that is the point of a gantt', () => {
    setup([task('spec', '2026-08-03', '2026-08-07')]);
    expect(screen.getByTestId('time-table')).toBeTruthy();
    expect(screen.getByTestId('time-table-name').textContent).toContain('spec');
  });

  it('can hide it, which a module constant could not', async () => {
    const user = userEvent.setup();
    setup([task('spec', '2026-08-03', '2026-08-07')]);
    await user.click(screen.getByRole('switch', { name: 'Show table' }));
    expect(screen.queryByTestId('time-table')).toBeNull();
    // The chart survives losing its gutter.
    expect(screen.getByTestId('gantt-bar')).toBeTruthy();
  });

  it('honours a view that has switched the table off', () => {
    setup([task('spec', '2026-08-03', '2026-08-07')], { showTable: false });
    expect(screen.queryByTestId('time-table')).toBeNull();
  });

  it('opens at the same default zoom as the timeline and the settings panel', () => {
    // It opened at 'month' while both of those said 'week'.
    setup([task('spec', '2026-08-03', '2026-08-07')]);
    expect(screen.getByTestId('gantt-view').getAttribute('data-zoom')).toBe('week');
  });

  it('writes the dates when a bar is dragged', () => {
    const write = vi.fn(async () => true);
    useVaultStore.setState({ patchFrontmatter: write });
    setup([task('spec', '2026-08-03', '2026-08-07')], { zoom: 'day' });

    // Real MouseEvents: jsdom has no PointerEvent, so the synthetic one
    // carries no clientX and the day count would come out NaN.
    act(() => {
      screen
        .getByTestId('gantt-bar')
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0 }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 2 * PX_PER_DAY.day }));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 2 * PX_PER_DAY.day }));
    });

    expect(write).toHaveBeenCalledWith('work/spec.md', {
      window: { start: '2026-08-05', end: '2026-08-09' },
    });
  });
});
