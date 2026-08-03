// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLayers } from '@/components/ui/layers';
import type { ColumnDef } from '@/engine/columns';
import type { Presentation } from '@/engine/types';
import { ViewControlIcons } from './ViewControlIcons';
import { ViewLimitNotice } from './ViewLimitNotice';

afterEach(cleanup);

const presentation: Presentation = {
  type: 'table',
  group: [],
  sort: [],
  columns: [{ field: 'status' }],
};

const fields: ColumnDef[] = [
  { name: 'status', kind: 'status' },
  { name: 'shipped', kind: 'checkbox' },
];

function setup(overrides: Partial<React.ComponentProps<typeof ViewControlIcons>> = {}) {
  const props = {
    presentation,
    fields,
    onChange: vi.fn(),
    barOpen: false,
    onBarOpenChange: vi.fn(),
    ...overrides,
  };
  render(<ViewControlIcons {...props} />);
  return props;
}

/**
 * There was no search within a view at all (M16.26). Notion's sits in the
 * toolbar, and the alternative here was authoring a `title contains` filter —
 * which persists into the saved view, so looking something up permanently
 * changed what the view was for everyone who opened it next.
 */
describe('search within the view (M16.26)', () => {
  it('is a glyph until pressed, then an input', () => {
    setup({ search: '', onSearchChange: vi.fn() });
    expect(screen.queryByTestId('view-search-input')).toBeNull();
    fireEvent.click(screen.getByTestId('view-control-search'));
    expect(screen.getByTestId('view-search-input')).toBeTruthy();
  });

  it('reports what was typed', () => {
    const props = setup({ search: '', onSearchChange: vi.fn() });
    fireEvent.click(screen.getByTestId('view-control-search'));
    fireEvent.change(screen.getByTestId('view-search-input'), { target: { value: 'sensor' } });
    expect(props.onSearchChange).toHaveBeenCalledWith('sensor');
  });

  /**
   * A live query keeps the box open. Collapsing it would leave the canvas
   * narrowed by something no longer on screen — the same class of failure as
   * a filter you cannot see.
   */
  it('stays open while it holds a query, even unfocused', () => {
    setup({ search: 'sensor', onSearchChange: vi.fn() });
    expect(screen.getByTestId('view-search-input')).toBeTruthy();
    fireEvent.blur(screen.getByTestId('view-search-input'));
    expect(screen.getByTestId('view-search-input')).toBeTruthy();
  });

  it('Escape clears it', () => {
    const props = setup({ search: 'sensor', onSearchChange: vi.fn() });
    fireEvent.keyDown(screen.getByTestId('view-search-input'), { key: 'Escape' });
    expect(props.onSearchChange).toHaveBeenCalledWith('');
  });

  it('absent on a surface that cannot hold the query', () => {
    setup();
    expect(screen.queryByTestId('view-control-search')).toBeNull();
  });
});

/**
 * The quick-pick behind an empty axis icon could be typed into but not arrowed
 * (M16.34): Enter always committed the FIRST match, so a field further down
 * the list was reachable by pointer only.
 */
describe('axis quick-pick keyboard (M16.34)', () => {
  function openFilterPick() {
    const onFiltersChange = vi.fn();
    setup({ onFiltersChange });
    fireEvent.click(screen.getByTestId('view-control-filter'));
    return { onFiltersChange, input: screen.getByLabelText('Filter by…') };
  }

  const picked = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[0][0].all[0].field;

  it('Enter still takes the top match when nothing has been arrowed', () => {
    const { onFiltersChange, input } = openFilterPick();
    fireEvent.change(input, { target: { value: 's' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(picked(onFiltersChange)).toBe('status');
  });

  it('ArrowDown then Enter commits the highlighted row, not the first', () => {
    const { onFiltersChange, input } = openFilterPick();
    fireEvent.change(input, { target: { value: 's' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(picked(onFiltersChange)).toBe('shipped');
  });

  it('the highlight is visible, and moves with the arrow', () => {
    const { input } = openFilterPick();
    fireEvent.change(input, { target: { value: 's' } });
    const rows = () => screen.getAllByRole('button').filter((b) => b.dataset.highlighted === '');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toBe('Status');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(rows()[0].textContent).toBe('Shipped');
  });

  it('ArrowUp wraps to the bottom of the list', () => {
    const { onFiltersChange, input } = openFilterPick();
    fireEvent.change(input, { target: { value: 's' } });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(picked(onFiltersChange)).toBe('shipped');
  });

  /**
   * Every keystroke re-cuts the list, so a held index would point at a
   * different field than the one that was under the highlight a moment ago.
   */
  it('re-typing resets the highlight to the top', () => {
    const { onFiltersChange, input } = openFilterPick();
    fireEvent.change(input, { target: { value: 's' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(picked(onFiltersChange)).toBe('title');
  });

  it('Enter on a query that matches nothing does nothing', () => {
    const { onFiltersChange, input } = openFilterPick();
    fireEvent.change(input, { target: { value: 'zzz' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onFiltersChange).not.toHaveBeenCalled();
    expect(screen.getByText('Nothing matches.')).toBeTruthy();
  });
});

/**
 * The View settings popover had a click-away scrim and no keyboard exit at
 * all (M16.29). It mounts through `FixedBelowAnchor`, which registered no
 * layer, so Escape fell past it to the record panel's handler behind it: the
 * record closed and this popover was left floating over an empty canvas.
 */
describe('View settings dismissal', () => {
  // Layers are module state; a case that leaves one pushed would make the
  // isTopLayer check here pass or fail for the wrong reason.
  beforeEach(() => resetLayers());

  function openSettings() {
    const onSettingsOpenChange = vi.fn();
    setup({
      settingsOpen: true,
      onSettingsOpenChange,
      settingsPanel: <div data-testid="settings-panel">settings</div>,
    });
    return onSettingsOpenChange;
  }

  it('closes on Escape', () => {
    const onSettingsOpenChange = openSettings();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onSettingsOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the keystroke away from whatever is behind it', () => {
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    try {
      openSettings();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(behind).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', behind);
    }
  });
});

/**
 * A load limit that truncated in silence would be indistinguishable from a
 * filter that is wrong — records missing from a view with nothing on screen
 * to say so (M16.26).
 */
describe('ViewLimitNotice', () => {
  it('says how many of how many', () => {
    render(<ViewLimitNotice shown={25} total={120} />);
    expect(screen.getByTestId('view-limit-notice').textContent).toContain('25');
    expect(screen.getByTestId('view-limit-notice').textContent).toContain('120');
  });

  it('renders nothing when nothing is being hidden', () => {
    render(<ViewLimitNotice shown={12} total={12} />);
    expect(screen.queryByTestId('view-limit-notice')).toBeNull();
  });

  it('offers a way out of the truncation it is reporting', () => {
    const onShowAll = vi.fn();
    render(<ViewLimitNotice shown={25} total={120} onShowAll={onShowAll} />);
    fireEvent.click(screen.getByTestId('view-show-all'));
    expect(onShowAll).toHaveBeenCalled();
  });
});
