import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { columnUniverse } from '@/engine/columns';
import { buildSchema } from '@/engine/schema';
import { PX_PER_DAY } from '@/engine/schedule';
import { makeEntry } from '@/test/factories';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { TimelineView } from '@/views/TimelineView';
import type { Entry, Presentation } from '@/engine/types';

/**
 * The timeline (M16.24). Before this it had no table half, no drag handlers of
 * any kind, and a zoom whose default disagreed with the settings panel's.
 *
 * jsdom has no PointerEvent and no layout — every rectangle is 0×0 — so these
 * drive the handlers with explicit client coordinates rather than measuring
 * anything. A test that measured would pass no matter what the code did.
 */

const TODAY = '2026-08-12';

const base: Presentation = {
  type: 'timeline',
  group: [],
  sort: [],
  columns: [{ field: 'status' }],
  dateField: 'window',
};

function vault(records: Entry[]): Entry[] {
  return [
    makeEntry({
      path: 'types/campaign.md',
      title: 'Campaign',
      type: 'Type',
      properties: {
        icon: 'megaphone',
        fields: { window: { kind: 'daterange' }, due: { kind: 'date' }, status: { kind: 'text' } },
      } as unknown as Entry['properties'],
    }),
    ...records,
  ];
}

function setup(records: Entry[], patch: Partial<Presentation> = {}) {
  const entries = vault(records);
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.type === 'Campaign');
  useVaultStore.setState({ entries });
  render(
    <TimelineView
      filtered={false}
      entries={items}
      presentation={{ ...base, ...patch }}
      schema={schema}
      fields={columnUniverse({ type: 'Campaign', project: null }, items, schema)}
      today={TODAY}
    />,
  );
}

const ranged = (slug: string, start: string, end: string, status = 'Live') =>
  makeEntry({
    path: `records/campaigns/${slug}.md`,
    title: slug,
    type: 'Campaign',
    properties: { window: { start, end }, status } as unknown as Entry['properties'],
  });

const patched = () => {
  const patchFrontmatter = vi.fn(async () => {});
  useVaultStore.setState({ patchFrontmatter });
  return patchFrontmatter;
};

/** Days at the current scale, as a pointer x-delta. */
const px = (days: number, zoom: 'day' | 'week' | 'month' | 'quarter') => days * PX_PER_DAY[zoom];

// Real MouseEvents throughout. jsdom implements no PointerEvent, so
// testing-library's synthetic one carries no coordinates and every drag would
// compute a NaN day count — passing or failing for reasons unrelated to the
// code. MouseEvent carries clientX, which is all these handlers read.
const grab = (el: HTMLElement) => {
  act(() => {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 0 }));
  });
};
const move = (dx: number) => {
  act(() => {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: dx }));
  });
};
const release = (dx: number) => {
  act(() => {
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: dx }));
  });
};

afterEach(cleanup);

describe('TimelineView table half', () => {
  it('has no table until it is asked for one', () => {
    setup([ranged('launch', '2026-08-03', '2026-08-07')]);
    expect(screen.queryByTestId('time-table')).toBeNull();
  });

  it('shows the record names and the view’s properties beside the axis', () => {
    setup([ranged('launch', '2026-08-03', '2026-08-07')], { showTable: true });
    expect(screen.getByTestId('time-table')).toBeTruthy();
    expect(screen.getAllByTestId('time-table-name')).toHaveLength(1);
    // The `status` column from `presentation.columns`, which no time view read.
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByTestId('time-table-cell').textContent).toBe('Live');
  });

  it('toggles the table from the view chrome', async () => {
    const user = userEvent.setup();
    setup([ranged('launch', '2026-08-03', '2026-08-07')]);
    await user.click(screen.getByRole('switch', { name: 'Show table' }));
    expect(screen.getByTestId('time-table')).toBeTruthy();
  });

  it('keeps a slot on the chart side for an undated row so the halves do not shear', () => {
    setup(
      [
        ranged('launch', '2026-08-03', '2026-08-07'),
        makeEntry({
          path: 'records/campaigns/someday.md',
          title: 'someday',
          type: 'Campaign',
        }),
      ],
      { showTable: true },
    );
    // Two names on the left; one bar and one empty lane on the right.
    expect(screen.getAllByTestId('time-table-name')).toHaveLength(2);
    expect(screen.getAllByTestId('timeline-bar')).toHaveLength(1);
  });
});

describe('TimelineView drag', () => {
  it('moves a bar by the days the pointer travelled', () => {
    const write = patched();
    setup([ranged('launch', '2026-08-03', '2026-08-07')], { zoom: 'day' });

    grab(screen.getByTestId('timeline-bar'));
    move(px(4, 'day'));
    release(px(4, 'day'));

    expect(write).toHaveBeenCalledWith('records/campaigns/launch.md', {
      window: { start: '2026-08-07', end: '2026-08-11' },
    });
  });

  it('previews the move before anything is written', () => {
    patched();
    setup([ranged('launch', '2026-08-03', '2026-08-07')], { zoom: 'day' });

    grab(screen.getByTestId('timeline-bar'));
    move(px(4, 'day'));
    // A drag you cannot see is a blind commit: you release and find out after.
    expect(screen.getByTestId('timeline-bar').getAttribute('data-start')).toBe('2026-08-07');
    release(px(4, 'day'));
  });

  it('resizes from the end grip, holding the start', () => {
    const write = patched();
    setup([ranged('launch', '2026-08-03', '2026-08-07')], { zoom: 'day' });

    grab(screen.getByTestId('bar-grip-end'));
    move(px(3, 'day'));
    release(px(3, 'day'));

    expect(write).toHaveBeenCalledWith('records/campaigns/launch.md', {
      window: { start: '2026-08-03', end: '2026-08-10' },
    });
  });

  it('resizes from the start grip, holding the end', () => {
    const write = patched();
    setup([ranged('launch', '2026-08-03', '2026-08-07')], { zoom: 'day' });

    grab(screen.getByTestId('bar-grip-start'));
    move(-px(2, 'day'));
    release(-px(2, 'day'));

    expect(write).toHaveBeenCalledWith('records/campaigns/launch.md', {
      window: { start: '2026-08-01', end: '2026-08-07' },
    });
  });

  it('offers no edge grips on a plain date field — there is no end to drag', () => {
    setup(
      [
        makeEntry({
          path: 'records/campaigns/ship.md',
          title: 'ship',
          type: 'Campaign',
          properties: { due: '2026-08-05' },
        }),
      ],
      { dateField: 'due' },
    );
    expect(screen.getByTestId('timeline-bar')).toBeTruthy();
    expect(screen.queryByTestId('bar-grip-end')).toBeNull();
  });

  it('converts pixels to days at the CURRENT zoom, not a fixed scale', () => {
    const write = patched();
    setup([ranged('launch', '2026-08-03', '2026-08-07')], { zoom: 'week' });

    // The same 136px is four days at Day zoom and ten at Week zoom.
    grab(screen.getByTestId('timeline-bar'));
    move(136);
    release(136);

    expect(write).toHaveBeenCalledWith('records/campaigns/launch.md', {
      window: { start: '2026-08-13', end: '2026-08-17' },
    });
  });

  it('does not open the record it just dragged', () => {
    patched();
    const openDetail = vi.fn();
    useUiStore.setState({ openDetail });
    setup([ranged('launch', '2026-08-03', '2026-08-07')], { zoom: 'day' });
    const bar = screen.getByTestId('timeline-bar');

    grab(bar);
    move(px(4, 'day'));
    release(px(4, 'day'));
    fireEvent.click(bar);

    expect(openDetail).not.toHaveBeenCalled();
  });

  it('moves with the arrow keys, and changes the end with Shift', async () => {
    const user = userEvent.setup();
    const write = patched();
    setup([ranged('launch', '2026-08-03', '2026-08-07')]);
    screen.getByTestId('timeline-bar').focus();

    await user.keyboard('{ArrowRight}');
    expect(write).toHaveBeenLastCalledWith('records/campaigns/launch.md', {
      window: { start: '2026-08-04', end: '2026-08-08' },
    });

    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(write).toHaveBeenLastCalledWith('records/campaigns/launch.md', {
      window: { start: '2026-08-03', end: '2026-08-08' },
    });
  });
});

describe('TimelineView zoom', () => {
  it('opens at the one shared default rather than its own', () => {
    setup([ranged('launch', '2026-08-03', '2026-08-07')]);
    expect(screen.getByTestId('timeline-view').getAttribute('data-zoom')).toBe('week');
  });

  it('changes scale even when the view file already carries a zoom', async () => {
    // `presentation.zoom ?? localZoom` made the control inert on any surface
    // that passes no onZoomChange — the stored value beat the click forever.
    const user = userEvent.setup();
    setup([ranged('launch', '2026-08-03', '2026-08-07')], { zoom: 'month' });
    expect(screen.getByTestId('timeline-view').getAttribute('data-zoom')).toBe('month');

    await user.click(screen.getByTestId('zoom-day'));
    expect(screen.getByTestId('timeline-view').getAttribute('data-zoom')).toBe('day');
  });

  it('redraws the axis at the new scale', async () => {
    const user = userEvent.setup();
    setup([ranged('launch', '2026-08-03', '2026-08-07')], { zoom: 'quarter' });
    // Quarters, not months with two labels in three blanked out.
    expect(screen.getAllByTestId('axis-tick')[0].textContent).toMatch(/^Q[1-4] \d{4}$/);

    await user.click(screen.getByTestId('zoom-day'));
    expect(screen.getAllByTestId('axis-tick')[0].textContent).toMatch(/^\d{1,2}$/);
  });
});
