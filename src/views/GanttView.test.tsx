import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ownsEscape, pushLayer, resetLayers } from '@/components/ui/layers';
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

/**
 * Abandoning a bar drag (M46.2).
 *
 * `useTimeDrag` was the only pointer loop in the app that already cancelled on
 * Escape — but it listened on `window` in the BUBBLE phase with no
 * `stopPropagation` and no layer, so the keystroke abandoned the bar AND
 * closed the record panel or dialog behind it. One press, two dismissals.
 *
 * Driven through the gantt because that is where the baseline measured the
 * gesture; the hook is shared with the timeline and the calendar.
 */
describe('GanttView bar drag Escape (M46.2)', () => {
  beforeEach(() => resetLayers());
  afterEach(() => resetLayers());

  const grab = (clientX = 0) =>
    act(() => {
      screen
        .getByTestId('gantt-bar')
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX }));
    });
  const moveTo = (days: number) =>
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: days * PX_PER_DAY.day }));
    });
  const release = (days: number) =>
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: days * PX_PER_DAY.day }));
    });
  const escape = () =>
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

  function bars() {
    const write = vi.fn(async () => true);
    useVaultStore.setState({ patchFrontmatter: write });
    setup([task('spec', '2026-08-03', '2026-08-07')], { zoom: 'day' });
    return write;
  }

  it('cancels the drag, so the release writes nothing', () => {
    const write = bars();
    grab();
    moveTo(2);
    escape();
    release(2);
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps the keystroke away from the surface behind while the bar drag is live', () => {
    bars();
    const onWindow = vi.fn();
    grab();
    moveTo(2);
    window.addEventListener('keydown', onWindow);
    try {
      escape();
      // The measured leak: one Escape abandoned the bar AND closed the panel.
      expect(onWindow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });

  it('takes Escape off the surface underneath for the length of the gesture', () => {
    bars();
    // What DetailPanel and Dialog both register; their handlers ask the stack
    // who owns the keystroke.
    pushLayer('panel');
    grab();
    moveTo(2);
    expect(ownsEscape('panel')).toBe(false);
    escape();
    expect(ownsEscape('panel')).toBe(true);
  });

  it('hands the layer back on a normal release too', () => {
    bars();
    pushLayer('panel');
    grab();
    moveTo(2);
    release(2);
    expect(ownsEscape('panel')).toBe(true);
  });

  it('leaves a later drag able to commit', () => {
    const write = bars();
    grab();
    moveTo(2);
    escape();
    release(2);

    // A DIFFERENT distance, so the assertion can tell the two worlds apart: a
    // cancelled two-day move followed by another two-day move lands exactly
    // where an uncancelled first drag would have.
    grab();
    moveTo(3);
    release(3);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('work/spec.md', {
      window: { start: '2026-08-06', end: '2026-08-10' },
    });
  });

  it('writes nothing when the view unmounts mid-drag', () => {
    const write = bars();
    pushLayer('panel');
    grab();
    moveTo(2);

    cleanup();
    release(2);

    // The gesture's listeners outlived the component that owned them, and its
    // release still reached `patchFrontmatter` — a write from a view that is
    // no longer on screen.
    expect(write).not.toHaveBeenCalled();
    expect(ownsEscape('panel')).toBe(true);
  });
});
