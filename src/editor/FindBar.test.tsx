import { commandDef } from '@/app/commands';
import { matchesSpec } from '@/lib/keys/combo';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { undoDepth } from 'prosemirror-history';
import { TextSelection } from 'prosemirror-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEscapeLayer } from '@/components/ui/Popover';
import { resetLayers } from '@/components/ui/layers';
import type { Entry } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import { blocksToMarkdownNow } from './markdown';
import { MarkdownEditor, type CerebroEditor, type EditorReadyInfo } from './MarkdownEditor';
import { openTogglesAround } from './sectionLinks';

vi.mock('./sectionLinks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sectionLinks')>();
  return { ...actual, openTogglesAround: vi.fn(actual.openTogglesAround) };
});

/**
 * The find bar (M59.6) on a mounted MarkdownEditor: the keys, the marks, the
 * save it stays out of, and the one undo step Replace all is.
 */

const ENTRIES = [
  {
    path: 'knowledge/sync-error-rate.md',
    filename: 'sync-error-rate.md',
    folder: 'knowledge',
    project: null,
    title: 'Sync error rate',
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-01T00:00:00Z',
    parseError: null,
    hash: null,
  },
] as Entry[];

beforeEach(() => {
  useVaultStore.setState({ entries: ENTRIES });
});

afterEach(() => {
  cleanup();
  resetLayers();
  vi.mocked(openTogglesAround).mockClear();
});

interface Mounted {
  editor: CerebroEditor;
  host: HTMLElement;
  onChange: ReturnType<typeof vi.fn>;
  onDirty: ReturnType<typeof vi.fn>;
  loadedAs: string;
  unmount: () => void;
}

async function mount(
  markdown: string,
  opts: { readOnly?: boolean; debounceMs?: number; before?: React.ReactNode } = {},
): Promise<Mounted> {
  const onChange = vi.fn();
  const onDirty = vi.fn();
  const onReady = vi.fn<(info: EditorReadyInfo) => void>();
  const utils = render(
    <>
      {opts.before}
      <MarkdownEditor
        markdown={markdown}
        onChange={onChange}
        onDirty={onDirty}
        onReady={onReady}
        readOnly={opts.readOnly}
        debounceMs={opts.debounceMs ?? 30}
      />
    </>,
  );
  await waitFor(() => expect(onReady).toHaveBeenCalled());
  const info = onReady.mock.calls[0][0];
  const host = utils.container.querySelector<HTMLElement>('[data-testid="markdown-editor"]')!;
  return {
    editor: info.editor,
    host,
    onChange,
    onDirty,
    loadedAs: info.loadedAs,
    unmount: utils.unmount,
  };
}

/** A key pressed wherever focus is, bubbling to the window; false if prevented. */
const press = (key: string, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });

const openFind = () => press('f', { metaKey: true, code: 'KeyF' });
const openReplace = () => press('ƒ', { metaKey: true, altKey: true, code: 'KeyF' });

const marks = (host: HTMLElement) =>
  new Set([...host.querySelectorAll('[data-find]')].map((el) => el.getAttribute('data-find')));

const count = () => screen.getByTestId('find-count').textContent;

async function search(query: string) {
  fireEvent.change(screen.getByTestId('find-input'), { target: { value: query } });
  await waitFor(() => expect(screen.getByTestId('find-input')).toHaveProperty('value', query));
}

function select(editor: CerebroEditor, from: number, to: number) {
  editor.transact((tr) => {
    tr.setSelection(TextSelection.create(tr.doc, from, to));
  });
}

const PAGE = 'Sync first.\n\nThen sync, and [[sync-error-rate]].\n\nLast sync here.\n';

describe('finding', () => {
  it('⌘F opens the bar focused, marks every hit and counts them', async () => {
    const { host } = await mount(PAGE);
    expect(screen.queryByTestId('find-bar')).toBeNull();
    expect(openFind()).toBe(false);
    expect(screen.getByTestId('find-bar').getAttribute('role')).toBe('search');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('find-input')));
    await search('SYNC');
    await waitFor(() => expect(count()).toBe('1 of 4'));
    expect(marks(host)).toEqual(new Set(['1', '2', '3', '4']));
    expect(host.querySelectorAll('.cb-find-current')).toHaveLength(1);
  });

  it('Enter, ⇧Enter, ⌘G and ⇧⌘G step through the hits and wrap', async () => {
    await mount(PAGE);
    openFind();
    await search('sync');
    await waitFor(() => expect(count()).toBe('1 of 4'));
    const input = screen.getByTestId('find-input');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(count()).toBe('2 of 4');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(count()).toBe('4 of 4');
    fireEvent.keyDown(input, { key: 'g', metaKey: true });
    expect(count()).toBe('1 of 4');
    fireEvent.keyDown(input, { key: 'G', metaKey: true, shiftKey: true });
    expect(count()).toBe('4 of 4');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(count()).toBe('3 of 4 · in a link');
    fireEvent.click(screen.getByTestId('find-next'));
    expect(count()).toBe('4 of 4');
  });

  it('says No matches when nothing matches', async () => {
    await mount(PAGE);
    openFind();
    await search('nowhere');
    await waitFor(() => expect(count()).toBe('No matches'));
  });
});

describe('highlights stay out of the save', () => {
  it('opening, searching, stepping and closing change nothing', async () => {
    const { editor, onChange, onDirty, unmount, loadedAs } = await mount(PAGE, { debounceMs: 20 });
    const depth = undoDepth(editor.prosemirrorState);
    openFind();
    await search('sync');
    await waitFor(() => expect(count()).toBe('1 of 4'));
    fireEvent.keyDown(screen.getByTestId('find-input'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('find-close'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 80)));
    expect(onChange).not.toHaveBeenCalled();
    expect(onDirty).not.toHaveBeenCalled();
    expect(undoDepth(editor.prosemirrorState)).toBe(depth);
    expect(blocksToMarkdownNow(editor)).toBe(loadedAs);
    unmount();
    expect(onChange).not.toHaveBeenCalled();
  });
});

/** Open the bar with Replace showing, find `query` and type `replacement`. */
async function readyReplace(query: string, replacement: string) {
  openReplace();
  await search(query);
  fireEvent.change(screen.getByTestId('find-replace-input'), {
    target: { value: replacement },
  });
  await waitFor(() => expect(count()).not.toBe(''));
}

/** The position just after the `n`th (1-based) `word` in the doc. */
function after(editor: CerebroEditor, word: string, n: number): number {
  let found = -1;
  let seen = 0;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found !== -1 || !node.isText) return;
    let at = node.text!.indexOf(word);
    while (at !== -1) {
      seen += 1;
      if (seen === n) {
        found = pos + at + word.length;
        return;
      }
      at = node.text!.indexOf(word, at + 1);
    }
  });
  return found;
}

describe('undo', () => {
  const TEXT = 'One sync.\n\nTwo sync.\n\nThree sync.\n';

  it('Replace all saves once, and one undo restores the page exactly', async () => {
    const { editor, onChange, loadedAs } = await mount(TEXT);
    await readyReplace('sync', 'link');
    fireEvent.click(screen.getByTestId('find-replace-all'));
    expect(screen.getByTestId('find-status').textContent).toBe('Replaced 3');
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe('One link.\n\nTwo link.\n\nThree link.\n');
    act(() => {
      editor.undo();
    });
    expect(blocksToMarkdownNow(editor)).toBe(loadedAs);
  });

  it('never joins the typing just before it', async () => {
    const { editor, loadedAs } = await mount(TEXT);
    await readyReplace('sync', 'link');
    // Next to the LAST hit: the first range Replace all changes, so the one
    // history would join the typing to.
    const x = after(editor, 'sync', 3);
    act(() => {
      editor.transact((tr) => {
        tr.insertText('X', x);
      });
    });
    fireEvent.click(screen.getByTestId('find-replace-all'));
    expect(blocksToMarkdownNow(editor)).toBe('One link.\n\nTwo link.\n\nThree linkX.\n');
    act(() => {
      editor.undo();
    });
    expect(blocksToMarkdownNow(editor)).toBe('One sync.\n\nTwo sync.\n\nThree syncX.\n');
    act(() => {
      editor.undo();
    });
    expect(blocksToMarkdownNow(editor)).toBe(loadedAs);
  });

  it('never joins the typing just after it', async () => {
    const { editor } = await mount(TEXT);
    await readyReplace('sync', 'link');
    fireEvent.click(screen.getByTestId('find-replace-all'));
    const y = after(editor, 'link', 1);
    act(() => {
      editor.transact((tr) => {
        tr.insertText('Y', y);
      });
    });
    expect(blocksToMarkdownNow(editor)).toBe('One linkY.\n\nTwo link.\n\nThree link.\n');
    act(() => {
      editor.undo();
    });
    expect(blocksToMarkdownNow(editor)).toBe('One link.\n\nTwo link.\n\nThree link.\n');
  });
});

describe('replace and links', () => {
  const LINKED = 'A sync, [[sync-error-rate]], one more sync.\n';

  it('Replace changes the current hit, moves on, and stops at a link', async () => {
    const { editor } = await mount(LINKED);
    select(editor, 1, 1);
    await readyReplace('sync', 'X');
    await waitFor(() => expect(count()).toBe('1 of 3'));
    fireEvent.click(screen.getByTestId('find-replace'));
    expect(blocksToMarkdownNow(editor)).toBe('A X, [[sync-error-rate]], one more sync.\n');
    expect(count()).toBe('1 of 2 · in a link');
    expect(screen.getByTestId('find-replace')).toHaveProperty('disabled', true);
  });

  it('Replace all leaves a link as it is, and says so', async () => {
    const { editor } = await mount('See [[sync-error-rate]].\n');
    await readyReplace('sync', 'link');
    fireEvent.click(screen.getByTestId('find-replace-all'));
    expect(blocksToMarkdownNow(editor)).toBe('See [[sync-error-rate]].\n');
    expect(screen.getByTestId('find-status').textContent).toBe(
      'Nothing replaced · 1 in a link left as is',
    );
  });

  it('Replace all counts links beside what it replaced', async () => {
    await mount(LINKED);
    await readyReplace('sync', 'link');
    fireEvent.click(screen.getByTestId('find-replace-all'));
    expect(screen.getByTestId('find-status').textContent).toBe(
      'Replaced 2 · 1 in a link left as is',
    );
    expect(count()).toBe('1 of 1 · in a link');
    // Either field changing clears the status.
    fireEvent.change(screen.getByTestId('find-replace-input'), { target: { value: 'other' } });
    expect(screen.queryByTestId('find-status')).toBeNull();
  });

  it('an empty replacement deletes every hit', async () => {
    const { editor } = await mount('Keep sync this sync.\n');
    await readyReplace('sync ', '');
    fireEvent.click(screen.getByTestId('find-replace-all'));
    expect(blocksToMarkdownNow(editor)).toBe('Keep this sync.\n');
  });

  it('a read-only page finds but never offers Replace', async () => {
    await mount(PAGE, { readOnly: true });
    expect(openReplace()).toBe(true);
    openFind();
    await search('sync');
    await waitFor(() => expect(count()).toBe('1 of 4'));
    expect(screen.queryByTestId('find-toggle-replace')).toBeNull();
    expect(screen.queryByTestId('find-replace-input')).toBeNull();
  });
});

function StandIn({ onClose }: { onClose: () => void }) {
  useEscapeLayer(onClose, { modal: false });
  return <div data-testid="stand-in">panel</div>;
}

describe('escape and focus', () => {
  it('Escape in the bar closes only the bar, clears the marks and refocuses the page', async () => {
    const panelClose = vi.fn();
    const { editor, host } = await mount(PAGE, { before: <StandIn onClose={panelClose} /> });
    const focus = vi.spyOn(editor, 'focus');
    openFind();
    await search('sync');
    await waitFor(() => expect(marks(host).size).toBe(4));
    fireEvent.keyDown(screen.getByTestId('find-input'), { key: 'Escape' });
    expect(screen.queryByTestId('find-bar')).toBeNull();
    expect(marks(host).size).toBe(0);
    expect(focus).toHaveBeenCalled();
    expect(panelClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('stand-in')).toBeTruthy();
  });

  it('⌘F over a dialog does nothing and is not prevented', async () => {
    await mount(PAGE, {
      before: (
        <div role="dialog">
          <input data-testid="dialog-input" />
        </div>
      ),
    });
    screen.getByTestId('dialog-input').focus();
    expect(openFind()).toBe(true);
    expect(screen.queryByTestId('find-bar')).toBeNull();
  });

  it('⌘F with the bar open selects the query again', async () => {
    await mount(PAGE);
    openFind();
    await search('sync');
    const input = screen.getByTestId<HTMLInputElement>('find-input');
    input.setSelectionRange(4, 4);
    openFind();
    await waitFor(() => expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4]));
  });

  it('a one-line selection seeds the query', async () => {
    const { editor } = await mount(PAGE);
    const from = after(editor, 'Then', 1) + 1;
    select(editor, from, from + 4);
    openFind();
    expect(screen.getByTestId('find-input')).toHaveProperty('value', 'sync');
    await waitFor(() => expect(count()).toBe('2 of 4'));
  });

  it('reaching a hit in a toggle opens the toggles around it and scrolls to its mark', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { host } = await mount(':::toggle Questions\nWhere does sync stop?\n:::\n');
    openFind();
    await search('sync');
    await waitFor(() => expect(count()).toBe('1 of 1'));
    await waitFor(() => expect(vi.mocked(openTogglesAround)).toHaveBeenCalled());
    const block = vi.mocked(openTogglesAround).mock.calls.at(-1)![0];
    expect(block.textContent).toContain('Where does sync stop?');
    await waitFor(() =>
      expect(scroll.mock.contexts).toContain(host.querySelector('[data-find="1"]')),
    );
    scroll.mockRestore();
  });

  it('⌘K with the query selected opens no Ask AI', async () => {
    const { host } = await mount(PAGE);
    openFind();
    await search('sync');
    const input = screen.getByTestId<HTMLInputElement>('find-input');
    input.select();
    // Chromium reports text selected inside an <input> through
    // window.getSelection(), with a range collapsed in the bar; jsdom does
    // not, so stand that in.
    const range = document.createRange();
    range.setStart(screen.getByTestId('find-bar'), 0);
    const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'sync',
      rangeCount: 1,
      isCollapsed: true,
      getRangeAt: () => range,
    } as unknown as Selection);
    expect(fireEvent.keyDown(input, { key: 'k', metaKey: true })).toBe(true);
    expect(screen.queryByTestId('ask-ai')).toBeNull();
    // The same selection, keyed from the page, does open it: the bar is what
    // keeps it shut.
    fireEvent.keyDown(host.querySelector('.ProseMirror')!, { key: 'k', metaKey: true });
    await waitFor(() => expect(screen.queryByTestId('ask-ai')).not.toBeNull());
    getSelection.mockRestore();
  });
});

describe('which page a key acts on', () => {
  async function two() {
    const onReady = vi.fn<(info: EditorReadyInfo) => void>();
    render(
      <>
        <MarkdownEditor markdown={'First sync.\n'} onChange={vi.fn()} onReady={onReady} />
        <MarkdownEditor markdown={'Second sync.\n'} onChange={vi.fn()} onReady={onReady} />
      </>,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
    const hosts = screen.getAllByTestId('markdown-editor');
    return { hosts };
  }

  /** Put focus on a focusable element inside `host`, as a click in the page would. */
  function focusIn(host: HTMLElement) {
    const spot = document.createElement('span');
    spot.tabIndex = -1;
    host.append(spot);
    spot.focus();
    return spot;
  }

  const barIn = (host: HTMLElement) => host.querySelector('[data-testid="find-bar"]');

  it('the page holding focus wins', async () => {
    const { hosts } = await two();
    focusIn(hosts[1]);
    openFind();
    expect(barIn(hosts[1])).not.toBeNull();
    expect(barIn(hosts[0])).toBeNull();
  });

  it('with nothing focused, the page focused last', async () => {
    const { hosts } = await two();
    focusIn(hosts[1]).blur();
    expect(document.activeElement).toBe(document.body);
    openFind();
    expect(barIn(hosts[1])).not.toBeNull();
    expect(barIn(hosts[0])).toBeNull();
  });

  it('with no page ever focused, the first in the document', async () => {
    const { hosts } = await two();
    (document.activeElement as HTMLElement | null)?.blur();
    openFind();
    expect(barIn(hosts[0])).not.toBeNull();
    expect(barIn(hosts[1])).toBeNull();
  });

  it('focus outside every page leaves the key alone', async () => {
    await two();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    expect(openFind()).toBe(true);
    expect(screen.queryByTestId('find-bar')).toBeNull();
    outside.remove();
  });
});

it('the Find row reserves Command-F, leaving Control-F to macOS line editing', async () => {
  const spec = commandDef('find.open').keys[0]!;
  const control = { key: 'f', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false };
  expect(matchesSpec(spec, control, true)).toBe(false);
  expect(matchesSpec(spec, { ...control, metaKey: true, ctrlKey: false }, true)).toBe(true);
  await mount(PAGE);
  expect(openFind()).toBe(false);
  expect(screen.getByTestId('find-input')).toBeTruthy();
});
