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
