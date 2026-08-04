import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { PRESETS, SelectionToolbar, useSelectionAnchor } from './SelectionToolbar';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * M18 — the AI controls you can see.
 *
 * The feature this replaces worked and was invisible: it was bound to Cmd-K and
 * nothing on screen said so. So the tests are about VISIBILITY conditions —
 * when the bar appears, when it must not, and that a preset carries a real
 * instruction rather than a label.
 */
const anchor = { text: 'the selected passage', left: 100, top: 300, bottom: 320 };

describe('SelectionToolbar', () => {
  it('offers Ask AI and the two most common rewrites without opening a menu', () => {
    render(<SelectionToolbar anchor={anchor} onAsk={() => undefined} onPreset={() => undefined} />);
    expect(screen.getByTestId('selection-ask-ai')).toBeTruthy();
    expect(screen.getAllByTestId('selection-preset')).toHaveLength(2);
  });

  it('hands back a real instruction, not the label on the button', () => {
    // The preset IS the prompt. A button whose behaviour lives somewhere other
    // than the string it sends is one nobody can predict or change.
    const onPreset = vi.fn();
    render(<SelectionToolbar anchor={anchor} onAsk={() => undefined} onPreset={onPreset} />);
    fireEvent.click(screen.getAllByTestId('selection-preset')[0]);
    expect(onPreset).toHaveBeenCalledWith(PRESETS[0]);
    expect(PRESETS[0].instruction.length).toBeGreaterThan(20);
  });

  it('does not steal the selection when clicked', () => {
    // Clicking a toolbar normally moves focus and collapses the range the whole
    // feature depends on. The bar must preventDefault on mousedown.
    render(<SelectionToolbar anchor={anchor} onAsk={() => undefined} onPreset={() => undefined} />);
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    screen.getByTestId('selection-toolbar').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('drops below the selection when there is no room above it', () => {
    const { rerender } = render(
      <SelectionToolbar anchor={anchor} onAsk={() => undefined} onPreset={() => undefined} />,
    );
    expect(screen.getByTestId('selection-toolbar').style.top).toBe('258px');
    rerender(
      <SelectionToolbar
        anchor={{ ...anchor, top: 10, bottom: 30 }}
        onAsk={() => undefined}
        onPreset={() => undefined}
      />,
    );
    expect(screen.getByTestId('selection-toolbar').style.top).toBe('38px');
  });

  it('reaches every preset through the overflow', () => {
    const onPreset = vi.fn();
    render(<SelectionToolbar anchor={anchor} onAsk={() => undefined} onPreset={onPreset} />);
    fireEvent.click(screen.getByRole('button', { name: 'More AI actions' }));
    expect(screen.getAllByTestId('selection-preset')).toHaveLength(2 + PRESETS.length);
  });
});

describe('useSelectionAnchor', () => {
  const container = () => {
    const node = document.createElement('div');
    const inner = document.createTextNode('hello world');
    node.appendChild(inner);
    document.body.appendChild(node);
    return { node, inner };
  };

  const selectionOf = (node: Node, text: string, collapsed = false) =>
    ({
      isCollapsed: collapsed,
      rangeCount: 1,
      toString: () => text,
      getRangeAt: () => ({
        commonAncestorContainer: node,
        getBoundingClientRect: () => ({ left: 4, top: 8, bottom: 20 }) as DOMRect,
      }),
    }) as unknown as Selection;

  const fire = () => act(() => void document.dispatchEvent(new Event('selectionchange')));

  it('anchors to a live selection inside the editor', () => {
    const { node, inner } = container();
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionOf(inner, 'hello'));
    const { result } = renderHook(() => useSelectionAnchor(node, true));
    fire();
    expect(result.current).toMatchObject({ text: 'hello', left: 4, top: 8, bottom: 20 });
  });

  it('is null for a collapsed caret — a cursor is not a selection', () => {
    const { node, inner } = container();
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionOf(inner, '', true));
    const { result } = renderHook(() => useSelectionAnchor(node, true));
    fire();
    expect(result.current).toBe(null);
  });

  it('is null for whitespace, which is a selection but not a passage', () => {
    const { node, inner } = container();
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionOf(inner, '  \n '));
    const { result } = renderHook(() => useSelectionAnchor(node, true));
    fire();
    expect(result.current).toBe(null);
  });

  it('ignores a selection in ANOTHER editor', () => {
    // A record panel and a doc are on screen together. A toolbar floating over
    // the wrong one is worse than no toolbar.
    const mine = container();
    const theirs = container();
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionOf(theirs.inner, 'not mine'));
    const { result } = renderHook(() => useSelectionAnchor(mine.node, true));
    fire();
    expect(result.current).toBe(null);
  });

  it('stays silent when disabled — read-only, or the popover already open', () => {
    const { node, inner } = container();
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionOf(inner, 'hello'));
    const { result } = renderHook(() => useSelectionAnchor(node, false));
    fire();
    expect(result.current).toBe(null);
  });
});
