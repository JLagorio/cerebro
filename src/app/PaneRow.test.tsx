import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { PaneRow } from './PaneRow';
const measurement = vi.hoisted(() => ({ width: 1280 }));
vi.mock('@/hooks/useMeasuredWidth', () => ({
  useMeasuredWidth: () => [() => {}, measurement.width],
}));
vi.mock('@/pages/HomePage', () => ({ HomePage: () => <div>Home content</div> }));
const fault = vi.hoisted(() => ({ settings: false }));
vi.mock('@/pages/SettingsPage', () => ({
  SettingsPage: () => {
    if (fault.settings) throw new Error('settings broke');
    return <div>Settings content</div>;
  },
}));
vi.mock('@/pages/DocPage', () => ({ DocPage: () => <textarea aria-label="Page editor" /> }));
beforeEach(() => {
  fault.settings = false;
  useNavStore.getState().reset();
  useNavStore.getState().setPaneCapacity(4);
  useVaultStore.setState({ entries: [], views: [], collections: [] });
  measurement.width = 1280;
});
afterEach(cleanup);
const panes = () => screen.getAllByTestId('pane');
describe('PaneRow', () => {
  it('a page that throws takes only its own pane: the other keeps its draft (M93.12)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useNavStore.getState().navigate({ kind: 'doc', path: 'notes/plan.md' });
    useNavStore.getState().openPane({ kind: 'settings' });
    fault.settings = true;
    render(<PaneRow />);
    const editor = screen.getByLabelText<HTMLTextAreaElement>('Page editor');
    fireEvent.change(editor, { target: { value: 'unsaved words' } });
    expect(within(panes()[1]).getByTestId('section-unavailable').textContent).toContain(
      'This page stopped drawing',
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('Page editor')).toBe(editor);
    expect(editor.value).toBe('unsaved words');
    vi.restoreAllMocks();
  });
  it('one pane has no bar and keeps the enclosing canvas container', () => {
    render(<PaneRow />);
    expect(panes()).toHaveLength(1);
    expect(screen.queryByTestId('pane-bar')).toBeNull();
    expect(panes()[0].className).not.toContain('@container/canvas');
    expect(useNavStore.getState().paneCapacity).toBe(3);
  });
  it('pointer and focus select their own frame; Close leaves the other mounted', () => {
    const first = useNavStore.getState().active;
    useNavStore.getState().openPane({ kind: 'settings' });
    render(<PaneRow />);
    expect(panes().map((el) => el.dataset.active)).toEqual(['false', 'true']);
    fireEvent.pointerDown(panes()[0]);
    expect(useNavStore.getState().active).toBe(first);
    fireEvent.focus(panes()[1]);
    expect(panes().map((el) => el.dataset.active)).toEqual(['false', 'true']);
    fireEvent.click(screen.getAllByTestId('pane-close')[1]);
    expect(panes()).toHaveLength(1);
    expect(screen.getByText('Home content')).toBeTruthy();
  });
  it('parks least recently focused panes while preserving their mounted editor', () => {
    const first = useNavStore.getState().active;
    useNavStore.getState().navigate({ kind: 'doc', path: 'first.md' });
    useNavStore.getState().openPane({ kind: 'settings' });
    const { rerender } = render(<PaneRow />);
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'unsaved local state' } });
    measurement.width = 800;
    rerender(<PaneRow />);
    expect(panes()[0].dataset.parked).toBe('true');
    expect(panes()[0].hasAttribute('inert')).toBe(true);
    expect(useNavStore.getState().paneCapacity).toBe(1);
    fireEvent.click(screen.getByTestId('pane-parked-tab'));
    expect(useNavStore.getState().active).toBe(first);
    expect(panes()[0].dataset.parked).toBe('false');
    expect(panes()[1].dataset.parked).toBe('true');
    expect(screen.getByRole('textbox')).toBe(editor);
    expect((editor as HTMLTextAreaElement).value).toBe('unsaved local state');
  });
  it('pane commands cycle from an editor, keep plain Cmd-W, and close the final pane to Home', () => {
    useNavStore.getState().navigate({ kind: 'doc', path: 'first.md' });
    const first = useNavStore.getState().active;
    useNavStore.getState().openPane({ kind: 'settings' });
    render(<PaneRow />);
    const second = useNavStore.getState().active;
    const editor = screen.getByRole('textbox');
    act(() => editor.focus());
    expect(useNavStore.getState().active).toBe(first);
    fireEvent.keyDown(editor, { key: ']', metaKey: true, altKey: true });
    expect(useNavStore.getState().active).toBe(second);
    fireEvent.keyDown(editor, { key: '[', metaKey: true, altKey: true });
    expect(useNavStore.getState().active).toBe(first);
    fireEvent.keyDown(editor, { key: 'w', metaKey: true });
    expect(panes()).toHaveLength(2);
    fireEvent.keyDown(editor, { key: 'w', metaKey: true, altKey: true });
    expect(panes()).toHaveLength(1);
    fireEvent.keyDown(document.body, { key: 'w', metaKey: true, altKey: true });
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
  });
});
