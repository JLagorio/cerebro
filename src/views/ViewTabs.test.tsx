// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('deletes a tab once there is more than one', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('view-tab-grid'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete view' }));
    expect(props.onDelete).toHaveBeenCalledWith('grid');
  });
});
