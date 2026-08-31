// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gripClass } from '@/components/ui/Grip';
import type { ViewDefinition } from '@/engine/types';
import { ViewTabs } from '@/views/ViewTabs';

const view = (
  id: string,
  name: string,
  type: ViewDefinition['presentation']['type'],
): ViewDefinition => ({
  id,
  name,
  icon: null,
  filters: null,
  presentation: { type, group: [], sort: [], columns: [] },
});

const VIEWS = [view('grid', 'All work', 'table'), view('risk', 'At risk', 'board')];

function setup(overrides: Partial<React.ComponentProps<typeof ViewTabs>> = {}) {
  const props = {
    views: VIEWS,
    activeId: 'grid',
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onChangeLayout: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onConfigure: vi.fn(),
    ...overrides,
  };
  render(<ViewTabs {...props} />);
  return props;
}

afterEach(cleanup);

describe('ViewTabs (M11)', () => {
  it('renders one tab per view and marks the open one', () => {
    setup();
    expect(screen.getByTestId('view-tab-grid').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('view-tab-risk').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByText('At risk')).toBeTruthy();
  });

  it('switching tabs selects rather than reconfigures', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('view-tab-risk'));
    expect(props.onSelect).toHaveBeenCalledWith('risk');
    // The regression this whole change exists to prevent: pressing another
    // way of looking must not rewrite the one you were on.
    expect(props.onChangeLayout).not.toHaveBeenCalled();
  });

  it('pressing the OPEN tab opens its menu instead of re-selecting it', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('view-tab-grid'));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('creates a view with the layout picked in the form', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('new-view'));
    fireEvent.click(screen.getByTestId('new-view-calendar'));
    fireEvent.click(screen.getByTestId('create-view'));
    // The layout is chosen when the view is made — not switched afterwards.
    expect(props.onCreate).toHaveBeenCalledWith('Calendar', 'calendar');
  });

  it('suggests a name from the layout, and defers to one you type', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('new-view'));
    fireEvent.change(screen.getByLabelText('View name'), { target: { value: 'Ship plan' } });
    fireEvent.click(screen.getByTestId('new-view-gantt'));
    fireEvent.click(screen.getByTestId('create-view'));
    expect(props.onCreate).toHaveBeenCalledWith('Ship plan', 'gantt');
  });

  it('suggests a non-colliding name when the layout name is taken', () => {
    const props = setup({ views: [view('table', 'Table', 'table')] });
    fireEvent.click(screen.getByTestId('new-view'));
    fireEvent.click(screen.getByTestId('create-view'));
    expect(props.onCreate).toHaveBeenCalledWith('Table 2', 'table');
  });

  it('changes layout from the open tab’s menu', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('view-tab-grid'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Change layout/ }));
    fireEvent.click(screen.getByTestId('view-switch-timeline'));
    expect(props.onChangeLayout).toHaveBeenCalledWith('grid', 'timeline');
  });

  it('renames a tab in place', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('view-tab-grid'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByLabelText('View name');
    fireEvent.change(input, { target: { value: 'Everything' } });
    fireEvent.blur(input);
    expect(props.onRename).toHaveBeenCalledWith('grid', 'Everything');
  });

  it('offers no delete when the view is the only one', () => {
    setup({ views: [VIEWS[0]] });
    fireEvent.click(screen.getByTestId('view-tab-grid'));
    // A List with no views is not representable, so the last tab is not
    // something the tab row can remove.
    expect(screen.queryByRole('menuitem', { name: 'Delete view' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeTruthy();
  });

  it('confirms before deleting a tab, naming what goes with it', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('view-tab-grid'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete view' }));
    // A view carries filters, columns, sort and grouping, and there is no undo
    // in the app — the menu item alone used to destroy all of it.
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Delete "All work"?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete view' }));
    expect(props.onDelete).toHaveBeenCalledWith('grid');
  });

  it('cancelling the delete confirmation keeps the view', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('view-tab-grid'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onDelete).not.toHaveBeenCalled();
  });
});

/**
 * Tab order is the order of the `views:` array on disk, and nothing could
 * write a different one (M16.26): no drag handler, no Move left/right item,
 * no action. A List that grew a fifth view had it pinned last forever.
 */
describe('reordering tabs (M16.26)', () => {
  const grip = (name: string) => screen.getByLabelText(new RegExp(`^Reorder ${name}`));

  it('the grip names the tab and its place in the strip', () => {
    setup({ onReorder: vi.fn() });
    expect(grip('All work').getAttribute('aria-label')).toBe('Reorder All work, position 1 of 2');
  });

  /**
   * Horizontal, so the primitive's arrow keys follow the axis. A keyboard
   * user reordering a ROW with Up/Down would be the tell that the grip was
   * bolted on rather than built for it.
   */
  it('Right moves a tab one place along, from the keyboard', () => {
    const props = setup({ onReorder: vi.fn() });
    fireEvent.keyDown(grip('All work'), { key: 'ArrowRight' });
    expect(props.onReorder).toHaveBeenCalledWith('grid', 1);
  });

  it('Left at the head of the strip does nothing', () => {
    const props = setup({ onReorder: vi.fn() });
    fireEvent.keyDown(grip('All work'), { key: 'ArrowLeft' });
    expect(props.onReorder).not.toHaveBeenCalled();
  });

  it('takes the row grip TRANSPOSED, inside the tab padding it lives in (M46.2 Task 6)', () => {
    setup({ onReorder: vi.fn() });
    const el = grip('All work');
    // Same glyph, same ink, same cursor, same reveal as a list row's grip —
    // the one thing it gives up is the 18px slot, because the tab's leading
    // padding is 10px and a wider handle would shove every tab sideways the
    // moment the pointer arrived (§B1's one prohibition).
    expect(el.className).toContain(gripClass('tab'));
    expect(el.className).toContain('cursor-grab');
    expect(el.className).not.toContain('w-[18px]');
  });

  it('no grip at all on a surface that cannot persist the order', () => {
    setup();
    expect(screen.queryByLabelText(/^Reorder/)).toBeNull();
  });

  /**
   * `useSortableList` measures `container.children` for its drop slots, so the
   * "+ View" button had to stay OUT of the measured set — it would otherwise
   * be a slot you could drop into and never mean.
   */
  it('the add-view button is not one of the reorderable slots', () => {
    setup({ onReorder: vi.fn() });
    // The measured set is its own box now. It was `display: contents` until
    // M46.2, which a drag cannot freeze — it has no box to freeze.
    const measured = [...screen.getByTestId('view-tab-slots').children];
    expect(measured).toHaveLength(2);
    expect(screen.getByTestId('new-view')).toBeTruthy();
  });
});

/**
 * The strip declared `role="tablist"` while leaving every tab its own tab stop
 * and ignoring arrow keys entirely (M16.34) — the contract announced to a
 * screen reader, none of it honoured. It is now the same roving tabindex the
 * SegmentedControl primitive already used.
 */
describe('tablist keyboard contract (M16.34)', () => {
  const tabs = () => screen.getAllByRole('tab');

  it('is one tab stop: only the open tab is tabbable', () => {
    setup({ activeId: 'risk' });
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0]);
  });

  it('stays reachable when the active id matches no tab', () => {
    setup({ activeId: 'gone' });
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1]);
  });

  it('Right activates the next view and moves focus onto it', () => {
    const props = setup();
    fireEvent.keyDown(screen.getByTestId('view-tab-grid'), { key: 'ArrowRight' });
    expect(props.onSelect).toHaveBeenCalledWith('risk');
    // Selection follows focus, so the tab that just became active is where the
    // keyboard is standing — otherwise the next press comes from nowhere.
    expect(document.activeElement).toBe(screen.getByTestId('view-tab-risk'));
  });

  it('Left wraps back round the strip', () => {
    const props = setup();
    fireEvent.keyDown(screen.getByTestId('view-tab-grid'), { key: 'ArrowLeft' });
    expect(props.onSelect).toHaveBeenCalledWith('risk');
  });

  it('Home jumps to the first tab and End to the last', () => {
    const props = setup({ activeId: 'risk' });
    fireEvent.keyDown(screen.getByTestId('view-tab-risk'), { key: 'Home' });
    expect(props.onSelect).toHaveBeenLastCalledWith('grid');
    fireEvent.keyDown(screen.getByTestId('view-tab-risk'), { key: 'End' });
    // Already last: nothing to select, and the strip must not thrash.
    expect(props.onSelect).toHaveBeenCalledTimes(1);
  });

  /**
   * The grip beside each tab takes the SAME keys to reorder. One keydown
   * cannot both move a tab and switch to another one, so the tablist handler
   * only listens to the tabs themselves.
   */
  it('reordering from the grip does not also switch tabs', () => {
    const props = setup({ onReorder: vi.fn() });
    fireEvent.keyDown(screen.getByLabelText(/^Reorder All work/), { key: 'ArrowRight' });
    expect(props.onReorder).toHaveBeenCalledWith('grid', 1);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('arrowing inside the new-view form does not switch tabs', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('new-view'));
    fireEvent.keyDown(screen.getByLabelText('View name'), { key: 'ArrowRight' });
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});

/**
 * `ViewDefinition.icon` has been parsed, serialized and rendered since M11 —
 * `ViewTabs` reads `view.icon ?? kind.icon` — but `newView` hardcodes null and
 * nothing in the app could write one, so every tab of the same layout wore the
 * same glyph and the key was dead weight in the YAML (M16.26).
 */
describe('per-view icon (M16.26)', () => {
  it('picks an icon for the open tab', () => {
    const props = setup({ onChangeIcon: vi.fn() });
    fireEvent.click(screen.getByTestId('view-tab-grid'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Change icon/ }));
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'rocket' } });
    fireEvent.click(screen.getByLabelText('Icon rocket'));
    expect(props.onChangeIcon).toHaveBeenCalledWith('grid', 'rocket');
  });

  /**
   * Clearing is a real choice, not an absence: the tab falls back to its
   * LAYOUT's icon, and the tile says so rather than showing an empty square.
   */
  it('clearing falls back to the layout icon, and says which', () => {
    const props = setup({ onChangeIcon: vi.fn(), views: [{ ...VIEWS[0], icon: 'rocket' }] });
    fireEvent.click(screen.getByTestId('view-tab-grid'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Change icon/ }));
    fireEvent.click(screen.getByLabelText('Use the table icon'));
    expect(props.onChangeIcon).toHaveBeenCalledWith('grid', null);
  });

  it('no menu item on a surface that cannot persist an icon', () => {
    setup();
    fireEvent.click(screen.getByTestId('view-tab-grid'));
    expect(screen.queryByRole('menuitem', { name: /Change icon/ })).toBeNull();
  });
});
