// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabDef } from '@/engine/types';
import { RecordTabs } from '@/detail/RecordTabs';

const TABS: TabDef[] = [
  { id: 'overview', name: 'Overview', icon: null, content: 'overview' },
  { id: 'spec', name: 'Spec', icon: null, content: 'sections' },
];

function setup(overrides: Partial<React.ComponentProps<typeof RecordTabs>> = {}) {
  // The mocks stay named so their `.mock` records keep their type through the
  // spread below — no test overrides the handlers, only tabs/activeId.
  const onSelect = vi.fn();
  const onChange = vi.fn();
  const props = { tabs: TABS, activeId: 'overview', onSelect, onChange, ...overrides };
  render(<RecordTabs {...props} />);
  return { ...props, onSelect, onChange };
}

afterEach(cleanup);

describe('RecordTabs (M44.5)', () => {
  it('renders a tablist and selects on press', () => {
    const props = setup();
    expect(screen.getByTestId('record-tabs')).toBeTruthy();
    expect(screen.getByTestId('record-tab-overview').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByTestId('record-tab-spec'));
    expect(props.onSelect).toHaveBeenCalledWith('spec');
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it('pressing the active tab opens its menu instead of reselecting', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
  });

  it('rename commits the trimmed name through onChange', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByLabelText('Tab name');
    fireEvent.change(input, { target: { value: '  Summary ' } });
    fireEvent.blur(input);
    expect(props.onChange).toHaveBeenCalledWith([{ ...TABS[0], name: 'Summary' }, TABS[1]]);
  });

  it('the add popover mints a sections tab with a unique id', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('new-record-tab'));
    fireEvent.change(screen.getByLabelText('Tab name'), { target: { value: 'Notes' } });
    fireEvent.click(screen.getByTestId('create-record-tab'));
    const next = props.onChange.mock.calls.at(-1)?.[0] as TabDef[];
    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({ name: 'Notes', content: 'sections' });
    expect(new Set(next.map((t) => t.id)).size).toBe(3);
  });

  it('the add popover suggests a free name and takes a picked content kind', () => {
    const props = setup({ tabs: [TABS[0], { ...TABS[1], name: 'Tab' }] });
    fireEvent.click(screen.getByTestId('new-record-tab'));
    fireEvent.click(screen.getByRole('button', { name: 'Properties' }));
    fireEvent.click(screen.getByTestId('create-record-tab'));
    const next = props.onChange.mock.calls.at(-1)?.[0] as TabDef[];
    // "Tab" is taken by a sibling, so the suggestion moves along.
    expect(next[2]).toMatchObject({ name: 'Tab 2', content: 'properties' });
  });

  it('the last tab cannot be deleted', () => {
    setup({ tabs: [TABS[0]] });
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    expect(screen.queryByRole('menuitem', { name: 'Delete tab' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeTruthy();
  });

  it('delete asks first, then commits the removal', () => {
    const props = setup();
    // Right-click reaches a non-active tab's menu without selecting it first.
    fireEvent.contextMenu(screen.getByTestId('record-tab-spec'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete tab' }));
    expect(props.onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Delete "Spec"?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete tab' }));
    expect(props.onChange).toHaveBeenCalledWith([TABS[0]]);
    // The dying tab was not the open one — selection has nothing to do.
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('deleting the ACTIVE tab hands selection to a survivor', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete tab' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete tab' }));
    expect(props.onSelect).toHaveBeenCalledWith('spec');
    expect(props.onChange).toHaveBeenCalledWith([TABS[1]]);
  });

  it('Move right reorders through onChange', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move right' }));
    expect(props.onChange).toHaveBeenCalledWith([TABS[1], TABS[0]]);
  });

  it('Move left is not offered at the head of the strip', () => {
    setup();
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    expect(screen.queryByRole('menuitem', { name: 'Move left' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Move right' })).toBeTruthy();
  });

  it('Duplicate copies the tab beside itself with fresh id and name', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('record-tab-overview'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    const next = props.onChange.mock.calls.at(-1)?.[0] as TabDef[];
    expect(next.map((t) => t.name)).toEqual(['Overview', 'Overview 2', 'Spec']);
    expect(new Set(next.map((t) => t.id)).size).toBe(3);
    expect(next[1].content).toBe('overview');
  });
});

describe('RecordTabs keyboard contract (M44.5)', () => {
  it('is one tab stop: only the open tab is tabbable, and arrows rove', () => {
    const props = setup();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1]);
    fireEvent.keyDown(screen.getByTestId('record-tab-overview'), { key: 'ArrowRight' });
    expect(props.onSelect).toHaveBeenCalledWith('spec');
    expect(document.activeElement).toBe(screen.getByTestId('record-tab-spec'));
  });

  it('reorders from the grip without switching tabs', () => {
    const props = setup();
    fireEvent.keyDown(screen.getByLabelText(/^Reorder Overview/), { key: 'ArrowRight' });
    expect(props.onChange).toHaveBeenCalledWith([TABS[1], TABS[0]]);
    expect(props.onSelect).not.toHaveBeenCalled();
  });
});
