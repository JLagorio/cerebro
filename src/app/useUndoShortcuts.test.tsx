// @vitest-environment jsdom
import { cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ui/Dialog';
import { useDiagramFile } from '@/mermaid/useDiagramFile';
import { useUndoStore, type UndoEntry } from '@/stores/undoStore';
import { useUndoShortcuts } from './useUndoShortcuts';

const ENTRY: UndoEntry = {
  id: 1,
  label: 'Renamed',
  vault: '/demo-vault',
  at: 0,
  kind: 'batch',
  files: [],
};

let undo: ReturnType<typeof vi.fn>;
let redo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  undo = vi.fn(async () => true);
  redo = vi.fn(async () => true);
  useUndoStore.setState({ past: [ENTRY], future: [ENTRY], undo, redo });
});

afterEach(cleanup);

function press(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'z',
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe('useUndoShortcuts (M60.7)', () => {
  it('⌘Z with focus off any text field undoes, and claims the key', () => {
    renderHook(() => useUndoShortcuts());
    const event = press(document.body);
    expect(undo).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('⇧⌘Z redoes', () => {
    renderHook(() => useUndoShortcuts());
    press(document.body, { shiftKey: true });
    expect(redo).toHaveBeenCalledOnce();
    expect(undo).not.toHaveBeenCalled();
  });

  it('does nothing inside contentEditable or an input, and leaves the key alone', () => {
    renderHook(() => useUndoShortcuts());
    const page = document.createElement('div');
    page.setAttribute('contenteditable', 'true');
    const field = document.createElement('input');
    document.body.append(page, field);
    try {
      expect(press(page).defaultPrevented).toBe(false);
      expect(press(field).defaultPrevented).toBe(false);
      expect(undo).not.toHaveBeenCalled();
    } finally {
      page.remove();
      field.remove();
    }
  });

  it('does nothing while a layer is open', () => {
    renderHook(() => useUndoShortcuts());
    render(
      <Dialog open onClose={() => {}} title="Delete?">
        <p>Body</p>
      </Dialog>,
    );
    press(document.body);
    expect(undo).not.toHaveBeenCalled();
  });

  // M65.1: the scope walk replaces M60.7's claim. A mounted diagram binds
  // `diagram.undo` in its page, which the keymap reaches before the app's own.
  it("a diagram's own undo binding shadows it, and unmounting hands it back", () => {
    renderHook(() => useUndoShortcuts());
    const diagram = renderHook(() => useDiagramFile('diagrams/flow.mmd'));
    expect(press(document.body).defaultPrevented).toBe(true);
    expect(undo).not.toHaveBeenCalled();
    diagram.unmount();
    press(document.body);
    expect(undo).toHaveBeenCalledOnce();
  });

  it('⇧⌘Z with nothing to redo leaves the key alone', () => {
    useUndoStore.setState({ future: [] });
    renderHook(() => useUndoShortcuts());
    expect(press(document.body, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(redo).not.toHaveBeenCalled();
  });

  it('an empty stack says nothing and leaves the key alone', () => {
    useUndoStore.setState({ past: [], future: [] });
    renderHook(() => useUndoShortcuts());
    expect(press(document.body).defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });
});
