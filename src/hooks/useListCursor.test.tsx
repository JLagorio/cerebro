import { openBesideIntent } from '@/app/openIntent';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { pushLayer, popLayer } from '@/components/ui/layers';
import { useUiStore } from '@/stores/uiStore';
import { useListCursor } from './useListCursor';
const opened = vi.fn();
const nested = vi.fn();
function List({
  keys = ['a', 'b', 'c'],
  selectable = true,
  peek = false,
  controlled = false,
}: {
  keys?: string[];
  selectable?: boolean;
  peek?: boolean;
  controlled?: boolean;
}) {
  const [focus, setFocus] = useState<string | null>('b');
  const cursor = useListCursor({
    keys,
    onOpen: opened,
    selectable,
    peek,
    ...(controlled ? { focus, onFocusChange: setFocus } : {}),
  });
  return (
    <>
      <input aria-label="Text" />
      <button onClick={nested}>Elsewhere</button>
      <div {...cursor.containerProps} role="listbox" aria-label="Rows">
        {keys.map((key) => (
          <div role="option" key={key} {...cursor.itemProps(key)}>
            {key}
            <button
              onClick={(event) => {
                event.stopPropagation();
                nested();
              }}
            >
              Action {key}
            </button>
          </div>
        ))}
      </div>
      <output data-testid="selected">{[...cursor.state.selected].join(',')}</output>
      <output data-testid="focus">{cursor.state.focus ?? ''}</output>
    </>
  );
}
const press = (key: string, extras = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...extras });
beforeEach(() => {
  opened.mockReset();
  nested.mockReset();
  useUiStore.setState({ detailPath: null, detailSiblings: [] });
});
afterEach(cleanup);
describe('useListCursor', () => {
  it('lands the first j from body, roves, scrolls and respects edges', () => {
    render(<List />);
    press('j');
    expect(document.activeElement?.textContent).toBe('aAction a');
    press('j');
    expect(screen.getByTestId('focus').textContent).toBe('b');
    press('k');
    expect(screen.getByTestId('focus').textContent).toBe('a');
    press('k');
    expect(screen.getByTestId('focus').textContent).toBe('a');
    press('ArrowDown');
    expect(screen.getByTestId('focus').textContent).toBe('b');
    press('End');
    expect(screen.getByTestId('focus').textContent).toBe('c');
    press('Home');
    expect(screen.getByTestId('focus').textContent).toBe('a');
  });
  it('selects and extends only when selectable, and leaves field typing alone', () => {
    const { rerender } = render(<List />);
    press('j');
    press('x');
    press('J', { shiftKey: true });
    expect(screen.getByTestId('selected').textContent).toBe('a,b');
    press('a', { metaKey: true });
    expect(screen.getByTestId('selected').textContent).toBe('a,b,c');
    const input = screen.getByRole('textbox');
    input.focus();
    expect(press('a', { metaKey: true })).toBe(true);
    expect(press('j')).toBe(true);
    rerender(<List selectable={false} />);
    screen.getByRole('listbox').focus();
    expect(press('x')).toBe(true);
    expect(press('J', { shiftKey: true })).toBe(true);
  });
  it('runs gg and G without inserting a letter', () => {
    render(<List />);
    press('G', { shiftKey: true });
    expect(screen.getByTestId('focus').textContent).toBe('c');
    press('g');
    press('g');
    expect(screen.getByTestId('focus').textContent).toBe('a');
  });
  it('opens from row, container and body while a child button keeps Enter', async () => {
    const user = userEvent.setup();
    render(<List />);
    press('j');
    press('Enter');
    expect(opened).toHaveBeenLastCalledWith('a');
    screen.getByRole('listbox').focus();
    press('Enter');
    expect(opened).toHaveBeenCalledTimes(2);
    (document.activeElement as HTMLElement).blur();
    press('Enter');
    expect(opened).toHaveBeenCalledTimes(3);
    screen.getByRole('button', { name: 'Action a' }).focus();
    await user.keyboard('{Enter}');
    expect(nested).toHaveBeenCalledOnce();
    expect(opened).toHaveBeenCalledTimes(3);
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    expect(press('Enter')).toBe(true);
  });
  it('Escape clears selection then cursor, and stands down under a layer', () => {
    render(<List />);
    press('j');
    press('x');
    pushLayer('dialog');
    expect(press('Escape')).toBe(true);
    expect(screen.getByTestId('selected').textContent).toBe('a');
    popLayer('dialog');
    press('Escape');
    expect(screen.getByTestId('selected').textContent).toBe('');
    expect(screen.getByTestId('focus').textContent).toBe('a');
    press('Escape');
    expect(screen.getByTestId('focus').textContent).toBe('');
    expect(document.activeElement).toBe(screen.getByRole('listbox'));
  });
  it('publishes peek siblings, follows external peek changes without focus, and reopens on move', () => {
    const { unmount } = render(<List peek />);
    expect(useUiStore.getState().detailSiblings).toEqual(['a', 'b', 'c']);
    const input = screen.getByRole('textbox');
    input.focus();
    act(() => useUiStore.getState().openDetail('b'));
    expect(document.activeElement).toBe(input);
    expect(screen.getByTestId('focus').textContent).toBe('b');
    input.blur();
    press('j');
    expect(opened).toHaveBeenLastCalledWith('c');
    unmount();
    expect(useUiStore.getState().detailSiblings).toEqual([]);
  });
  it('returns focus from a closed peek so the next Escape clears only the selection', () => {
    render(<List peek />);
    press('j');
    press('x');
    act(() => useUiStore.getState().openDetail('a'));
    const peek = document.createElement('div');
    peek.dataset.testid = 'detail-panel';
    const input = document.createElement('input');
    peek.append(input);
    document.body.append(peek);
    input.focus();
    act(() => useUiStore.getState().closeDetail());
    expect(document.activeElement).toBe(screen.getAllByRole('option')[0]);
    expect(screen.getByTestId('selected').textContent).toBe('a');
    press('Escape');
    expect(screen.getByTestId('selected').textContent).toBe('');
    peek.remove();
  });
  it('does not clear or steal siblings a newer list owns', () => {
    const { rerender, unmount } = render(<List peek />);
    act(() => useUiStore.getState().setDetailSiblings(['other']));
    rerender(<List peek />);
    expect(useUiStore.getState().detailSiblings).toEqual(['other']);
    unmount();
    expect(useUiStore.getState().detailSiblings).toEqual(['other']);
  });
  it('reconciles removed rows and supports controlled focus', () => {
    const { rerender } = render(<List controlled />);
    expect(screen.getByTestId('focus').textContent).toBe('b');
    press('j');
    expect(screen.getByTestId('focus').textContent).toBe('c');
    press('x');
    rerender(<List controlled keys={['a', 'b']} />);
    expect(screen.getByTestId('focus').textContent).toBe('b');
    expect(screen.getByTestId('selected').textContent).toBe('');
  });
});

it('Shift+Enter opens the cursor row with beside intent, then clears it', () => {
  opened.mockImplementation(() => expect(openBesideIntent()).toBe(true));
  render(<List />);
  press('j');
  press('Enter', { shiftKey: true });
  expect(opened).toHaveBeenCalledWith('a');
  expect(openBesideIntent()).toBe(false);
});
