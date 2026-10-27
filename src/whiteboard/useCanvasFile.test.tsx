// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { readCanvasFile, saveCanvasFile } from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import {
  __resetOpenPages,
  announceExternalWrites,
  editorHoldersOf,
  flushOpenPages,
  heldOpenPages,
  unresolvedOpenPages,
} from '@/editor/openPages';
import { readCanvas } from '@/engine/scene/jsonCanvas';
import { makeEntry } from '@/engine/testHelpers';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useCanvasFile, type CanvasFile } from './useCanvasFile';
import { BoardCanvas } from './BoardCanvas';

const PATH = 'boards/plan.canvas';
const VAULT = '/demo-vault';
const seed = (a = 0, b = 200) =>
  JSON.stringify({
    nodes: [
      { id: 'a', type: 'text', text: 'First', x: a, y: 0, width: 100, height: 60 },
      { id: 'b', type: 'text', text: 'Second', x: b, y: 0, width: 100, height: 60 },
    ],
    edges: [],
    keep: { raw: 'saved' },
  });
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const ready = (state: CanvasFile) => {
  if (state.state !== 'ready') throw new Error(state.state);
  return state;
};
const tick = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};
const advance = async (ms: number) => {
  await act(() => vi.advanceTimersByTimeAsync(ms));
};
const move = (state: CanvasFile, x: number, id = 'a') =>
  act(() => {
    const editor = ready(state).editor;
    editor.begin('Move');
    editor.preview(new Map([[`n:${id}` as const, { ...editor.board.nodes.get(id)!, x }]]));
    editor.commit();
  });
const xOf = (path = PATH) => {
  const parsed = readCanvas(fs().get(path)!);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.board.nodes.get('a')!.x;
};

beforeEach(() => {
  vi.spyOn(ipc, 'readCanvasFile');
  vi.spyOn(ipc, 'saveCanvasFile');
  vi.useFakeTimers();
  mock.resetMockFs();
  __resetOpenPages();
  fs().set(PATH, seed());
  useVaultStore.setState({ vaultPath: VAULT, entries: [] });
  useUiStore.setState({ toasts: [] });
});
afterEach(async () => {
  cleanup();
  await tick();
  vi.restoreAllMocks();
  vi.useRealTimers();
  __resetOpenPages();
});

describe('useCanvasFile', () => {
  it('an earlier edit autosaves without ending the text draft now being typed', async () => {
    let current: CanvasFile = { state: 'loading' };
    function OpenBoard() {
      current = useCanvasFile(PATH);
      return current.state === 'ready' ? (
        <BoardCanvas source={current.editor} name="Plan" cameraKey="autosave-text" />
      ) : null;
    }
    render(<OpenBoard />);
    await tick();
    move(current, 10);
    fireEvent.doubleClick(screen.getByTestId('wb-input'), { clientX: 30, clientY: 10 });
    fireEvent.change(screen.getByTestId('wb-text-editor'), { target: { value: 'still typing' } });
    await advance(500);
    expect(screen.getByTestId('wb-text-editor')).toHaveProperty('value', 'still typing');
    expect(JSON.parse(fs().get(PATH)!).nodes[0]).toMatchObject({ x: 10, text: 'First' });
    fireEvent.keyDown(screen.getByTestId('wb-text-editor'), { key: 'Escape' });
    await advance(500);
    expect(JSON.parse(fs().get(PATH)!).nodes[0].text).toBe('still typing');
    expect(saveCanvasFile).toHaveBeenCalledTimes(2);
  });
  it.each(['Save', 'unmount'] as const)(
    '%s settles the latest raw text draft before the file flush',
    async (ending) => {
      function OpenBoard() {
        const file = useCanvasFile(PATH);
        return file.state === 'ready' ? (
          <BoardCanvas source={file.editor} name="Plan" cameraKey="pending-text" />
        ) : null;
      }
      const { unmount } = render(
        <StrictMode>
          <OpenBoard />
        </StrictMode>,
      );
      await tick();
      fireEvent.doubleClick(screen.getByTestId('wb-input'), { clientX: 20, clientY: 10 });
      const input = screen.getByTestId('wb-text-editor');
      fireEvent.change(input, { target: { value: '# Latest\n- typed just now' } });
      expect(saveCanvasFile).not.toHaveBeenCalled();
      if (ending === 'Save') await act(() => flushOpenPages());
      else {
        unmount();
        await tick();
      }
      const stored = JSON.parse(fs().get(PATH)!);
      expect(stored.nodes[0].text).toBe('# Latest\n- typed just now');
      expect(stored.keep).toEqual({ raw: 'saved' });
      expect(saveCanvasFile).toHaveBeenCalledTimes(1);
    },
  );
  it('opening and reloading a board write nothing', async () => {
    const { result } = renderHook(() => useCanvasFile(PATH));
    expect(result.current.state).toBe('loading');
    await tick();
    expect(editorHoldersOf(PATH)).toHaveLength(1);
    await act(() => ready(result.current).reload());
    await advance(1500);
    expect(saveCanvasFile).not.toHaveBeenCalled();
    expect(fs().get(PATH)).toBe(seed());
    expect(ready(result.current).editor.canUndo()).toBe(false);
  });
  it.each(['{broken', '{"cerebro":{"version":2}}'])(
    'an unreadable board is never written: %s',
    async (source) => {
      fs().set(PATH, source);
      const { result } = renderHook(() => useCanvasFile(PATH));
      await tick();
      expect(result.current).toMatchObject({ state: 'unavailable', preview: source });
      await advance(1500);
      await act(() => flushOpenPages());
      expect(saveCanvasFile).not.toHaveBeenCalled();
      expect(fs().get(PATH)).toBe(source);
    },
  );
  it('limits an unavailable preview and distinguishes missing from a failed read', async () => {
    fs().set(PATH, '{' + ' '.repeat(25_000));
    const { result, unmount } = renderHook(() => useCanvasFile(PATH));
    await tick();
    expect(result.current).toMatchObject({
      state: 'unavailable',
      preview: ('{' + ' '.repeat(25_000)).slice(0, 20_000),
    });
    unmount();
    fs().delete(PATH);
    const missing = renderHook(() => useCanvasFile(PATH));
    await tick();
    expect(missing.result.current.state).toBe('missing');
    missing.unmount();
    vi.mocked(readCanvasFile).mockRejectedValueOnce(new Error('disk unavailable'));
    const failed = renderHook(() => useCanvasFile(PATH));
    await tick();
    expect(failed.result.current).toEqual({
      state: 'unavailable',
      reason: 'disk unavailable',
      preview: '',
    });
  });
  it('saves once 500 ms after the last change, retaining unknown keys', async () => {
    const { result } = renderHook(() => useCanvasFile(PATH));
    await tick();
    move(result.current, 10);
    await advance(400);
    move(result.current, 20);
    await advance(499);
    expect(saveCanvasFile).not.toHaveBeenCalled();
    await advance(1);
    expect(saveCanvasFile).toHaveBeenCalledTimes(1);
    expect(xOf()).toBe(20);
    expect(fs().get(PATH)).toContain('"raw":"saved"');
    expect(ready(result.current).saveState).toBe('saved');
  });
  it('a change mid-save gives exactly one more serial save, and a flush waits for both', async () => {
    let finish!: () => void;
    vi.mocked(saveCanvasFile).mockImplementationOnce(async (vault, path, content) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ok: true, ...(await mock.saveCanvasFile(vault, path, content)) };
    });
    const { result } = renderHook(() => useCanvasFile(PATH));
    await tick();
    move(result.current, 10);
    await advance(500);
    move(result.current, 20);
    move(result.current, 30);
    let flushed = false;
    const flush = flushOpenPages().then(() => {
      flushed = true;
    });
    await tick();
    expect(flushed).toBe(false);
    expect(saveCanvasFile).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await flush;
    });
    expect(saveCanvasFile).toHaveBeenCalledTimes(2);
    expect(xOf()).toBe(30);
    await advance(1000);
    expect(saveCanvasFile).toHaveBeenCalledTimes(2);
  });
  it('a failure stays dirty and toasts once per streak, then a successful retry releases the hold', async () => {
    vi.mocked(saveCanvasFile)
      .mockRejectedValueOnce(new Error('full'))
      .mockRejectedValueOnce(new Error('full'));
    const { result } = renderHook(() => useCanvasFile(PATH));
    await tick();
    move(result.current, 10);
    await advance(500);
    expect(ready(result.current).saveState).toBe('failed');
    expect(heldOpenPages()).toEqual([PATH]);
    await act(() => flushOpenPages());
    expect(
      useUiStore.getState().toasts.filter((t) => t.message === "Couldn't save whiteboard"),
    ).toHaveLength(1);
    expect(xOf()).toBe(0);
    await act(() => flushOpenPages());
    expect(xOf()).toBe(10);
    expect(heldOpenPages()).toEqual([]);
  });
  it('flushes a pending edit on unmount and preserves the old vault binding', async () => {
    const { result, unmount } = renderHook(() => useCanvasFile(PATH));
    await tick();
    move(result.current, 35);
    unmount();
    await tick();
    expect(saveCanvasFile).toHaveBeenCalledWith(VAULT, PATH, expect.any(String));
    expect(xOf()).toBe(35);
  });
  it('a clean outside write is one undo step and writes nothing', async () => {
    const { result } = renderHook(() => useCanvasFile(PATH));
    await tick();
    fs().set(PATH, seed(10));
    await act(() => announceExternalWrites([PATH], async () => {}));
    await tick();
    expect(ready(result.current).editor.board.nodes.get('a')?.x).toBe(10);
    expect(ready(result.current).editor.canUndo()).toBe(true);
    await advance(1500);
    expect(saveCanvasFile).not.toHaveBeenCalled();
    act(() => {
      ready(result.current).editor.undo();
    });
    await advance(500);
    expect(xOf()).toBe(0);
  });
  it('merges a dirty outside write card by card and saves the local edit', async () => {
    const { result } = renderHook(() => useCanvasFile(PATH));
    await tick();
    move(result.current, 10);
    fs().set(PATH, seed(0, 300));
    await act(() => announceExternalWrites([PATH], async () => {}));
    await tick();
    await advance(500);
    expect(xOf()).toBe(10);
    expect(ready(result.current).editor.board.nodes.get('b')?.x).toBe(300);
    expect(saveCanvasFile).toHaveBeenCalledTimes(1);
  });
  it.each(['unreadable', 'missing'] as const)(
    'holds a dirty board while %s and resumes only after readable bytes return',
    async (held) => {
      const { result } = renderHook(() => useCanvasFile(PATH));
      await tick();
      move(result.current, 10);
      if (held === 'missing') fs().delete(PATH);
      else fs().set(PATH, 'broken');
      await act(() => announceExternalWrites([PATH], async () => {}));
      await tick();
      expect(ready(result.current).held).toBe(held);
      expect(heldOpenPages()).toEqual([PATH]);
      await advance(1000);
      await act(() => flushOpenPages());
      expect(saveCanvasFile).not.toHaveBeenCalled();
      fs().set(PATH, seed(0, 300));
      await act(() => ready(result.current).reload());
      await advance(500);
      expect(ready(result.current).held).toBeNull();
      expect(xOf()).toBe(10);
      expect(ready(result.current).editor.board.nodes.get('b')?.x).toBe(300);
    },
  );
  it('a knowledge board never saves, even if an editor command is called', async () => {
    const path = 'knowledge/plan.canvas';
    fs().set(path, seed());
    const { result } = renderHook(() => useCanvasFile(path));
    await tick();
    expect(ready(result.current).readOnly).toBe(true);
    move(result.current, 20);
    await advance(1000);
    await act(() => flushOpenPages());
    expect(saveCanvasFile).not.toHaveBeenCalled();
    expect(fs().get(path)).toBe(seed());
  });
  it('its own hash never rereads, and an unseen scan hash does', async () => {
    const { result } = renderHook(() => useCanvasFile(PATH));
    await tick();
    move(result.current, 20);
    await advance(500);
    const own = await mock.readCanvasFile(VAULT, PATH);
    const reads = vi.mocked(readCanvasFile).mock.calls.length;
    act(() => useVaultStore.setState({ entries: [makeEntry({ path: PATH, hash: own.hash })] }));
    await tick();
    expect(readCanvasFile).toHaveBeenCalledTimes(reads);
    fs().set(PATH, seed(40));
    act(() => useVaultStore.setState({ entries: [makeEntry({ path: PATH, hash: 'outside' })] }));
    await tick();
    expect(readCanvasFile).toHaveBeenCalledTimes(reads + 1);
    expect(ready(result.current).editor.board.nodes.get('a')?.x).toBe(40);
  });
  it('a scan that loses the file rereads and shows missing', async () => {
    useVaultStore.setState({ entries: [makeEntry({ path: PATH, hash: 'initial' })] });
    const { result } = renderHook(() => useCanvasFile(PATH));
    await tick();
    fs().delete(PATH);
    act(() => useVaultStore.setState({ entries: [] }));
    await tick();
    expect(result.current.state).toBe('missing');
  });
});

it('an outside restoration to an earlier hash is still reread', async () => {
  const first = await mock.readCanvasFile(VAULT, PATH);
  useVaultStore.setState({ entries: [makeEntry({ path: PATH, hash: first.hash })] });
  const { result } = renderHook(() => useCanvasFile(PATH));
  await tick();
  move(result.current, 20);
  await advance(500);
  const own = await mock.readCanvasFile(VAULT, PATH);
  act(() => useVaultStore.setState({ entries: [makeEntry({ path: PATH, hash: own.hash })] }));
  await tick();
  fs().set(PATH, seed());
  act(() => useVaultStore.setState({ entries: [makeEntry({ path: PATH, hash: first.hash })] }));
  await tick();
  expect(ready(result.current).editor.board.nodes.get('a')?.x).toBe(0);
  expect(saveCanvasFile).toHaveBeenCalledTimes(1);
});

it('queues a newer scan hash while an older read is still in flight', async () => {
  const older = await mock.readCanvasFile(VAULT, PATH);
  let finish!: (value: Awaited<ReturnType<typeof readCanvasFile>>) => void;
  vi.mocked(readCanvasFile).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useVaultStore.setState({ entries: [makeEntry({ path: PATH, hash: older.hash })] });
  const { result } = renderHook(() => useCanvasFile(PATH));
  fs().set(PATH, seed(45));
  act(() => useVaultStore.setState({ entries: [makeEntry({ path: PATH, hash: 'newer' })] }));
  await tick();
  await act(async () => {
    finish({ ok: true, ...older });
  });
  await tick();
  expect(ready(result.current).editor.board.nodes.get('a')?.x).toBe(45);
  expect(readCanvasFile).toHaveBeenCalledTimes(2);
  expect(saveCanvasFile).not.toHaveBeenCalled();
});

it('unmount waits for a dirty outside read, merges it and flushes before retiring the editor', async () => {
  const { result, unmount } = renderHook(() => useCanvasFile(PATH));
  await tick();
  move(result.current, 10);
  fs().set(PATH, seed(0, 300));
  const outside = await mock.readCanvasFile(VAULT, PATH);
  let finish!: (value: Awaited<ReturnType<typeof readCanvasFile>>) => void;
  vi.mocked(readCanvasFile).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = ready(result.current).reload();
  });
  unmount();
  expect(saveCanvasFile).not.toHaveBeenCalled();
  await act(async () => {
    finish({ ok: true, ...outside });
    await pending;
  });
  await tick();
  expect(saveCanvasFile).toHaveBeenCalledTimes(1);
  expect(xOf()).toBe(10);
  const disk = readCanvas(fs().get(PATH)!);
  expect(disk.ok && disk.board.nodes.get('b')?.x).toBe(300);
});

it('unmount reconciles an announced write even before its catch-up finishes', async () => {
  const { result, unmount } = renderHook(() => useCanvasFile(PATH));
  await tick();
  move(result.current, 10);
  fs().set(PATH, seed(0, 320));
  let caughtUp!: () => void;
  const pending = announceExternalWrites(
    [PATH],
    () =>
      new Promise<void>((resolve) => {
        caughtUp = resolve;
      }),
  );
  unmount();
  await tick();
  expect(xOf()).toBe(10);
  const disk = readCanvas(fs().get(PATH)!);
  expect(disk.ok && disk.board.nodes.get('b')?.x).toBe(320);
  await act(async () => {
    caughtUp();
    await pending;
  });
  expect(saveCanvasFile).toHaveBeenCalledTimes(1);
});

it('an unmount flush failure still tells the person in the same vault', async () => {
  const { result, unmount } = renderHook(() => useCanvasFile(PATH));
  await tick();
  move(result.current, 10);
  vi.mocked(saveCanvasFile).mockRejectedValueOnce(new Error('full'));
  unmount();
  await tick();
  expect(useUiStore.getState().toasts.map((toast) => toast.message)).toContain(
    "Couldn't save whiteboard",
  );
  expect(xOf()).toBe(0);
});

it('reports the writer hash and retains a failed exact scene through reopening', async () => {
  const first = renderHook(() => useCanvasFile(PATH));
  await tick();
  const original = ready(first.result.current).editor;
  const dispose = vi.spyOn(original, 'dispose');
  move(first.result.current, 77);
  vi.mocked(saveCanvasFile).mockRejectedValueOnce(new Error('full'));
  first.unmount();
  await tick();
  expect(dispose).not.toHaveBeenCalled();
  expect(unresolvedOpenPages()).toEqual([
    expect.objectContaining({
      key: { vaultId: VAULT, path: PATH, ownerId: 'p1' },
      latestDraft: expect.stringContaining('"x":77'),
      failure: expect.objectContaining({ kind: 'failed' }),
    }),
  ]);
  const second = renderHook(() => useCanvasFile(PATH));
  await tick();
  expect(ready(second.result.current).editor).toBe(original);
  expect(ready(second.result.current).saveState).toBe('failed');
  let report!: Awaited<ReturnType<typeof flushOpenPages>>;
  await act(async () => {
    report = await flushOpenPages();
  });
  expect(report.unresolvedOwnerIds).toEqual([]);
  const disk = await mock.readCanvasFile(VAULT, PATH);
  expect(report.outcomes).toContainEqual(
    expect.objectContaining({
      kind: 'acknowledged',
      write: { kind: 'file', contentHash: disk.hash },
    }),
  );
  expect(xOf()).toBe(77);
  expect(dispose).not.toHaveBeenCalled();
  second.unmount();
  await tick();
  expect(dispose).toHaveBeenCalledOnce();
});

it('prepares focused inspector drafts and refuses invalid exact values before serialization', async () => {
  let current: CanvasFile = { state: 'loading' };
  function OpenBoard() {
    current = useCanvasFile(PATH);
    return current.state === 'ready' ? (
      <BoardCanvas source={current.editor} name="Plan" cameraKey="inspector-save" />
    ) : null;
  }
  render(<OpenBoard />);
  await tick();
  act(() => ready(current).editor.select(['n:a']));
  const x = screen.getByRole('textbox', { name: 'X' });
  fireEvent.change(x, { target: { value: '42' } });
  await act(() => flushOpenPages());
  expect(xOf()).toBe(42);
  fireEvent.change(x, { target: { value: '1.25 invalid' } });
  let report!: Awaited<ReturnType<typeof flushOpenPages>>;
  await act(async () => {
    report = await flushOpenPages();
  });
  expect(report.unresolvedOwnerIds).not.toEqual([]);
  expect(x).toHaveProperty('value', '1.25 invalid');
  expect(unresolvedOpenPages()[0].latestDraft).toContain('1.25 invalid');
  expect(xOf()).toBe(42);
  fireEvent.change(x, { target: { value: '43' } });
  await act(async () => {
    report = await flushOpenPages();
  });
  expect(report.unresolvedOwnerIds).toEqual([]);
  expect(xOf()).toBe(43);
});

it('reattaches during a pending save without an old release disposing the live scene', async () => {
  let finish!: () => void;
  vi.mocked(saveCanvasFile).mockImplementationOnce(async (vault, path, content) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { ok: true, ...(await mock.saveCanvasFile(vault, path, content)) };
  });
  const first = renderHook(() => useCanvasFile(PATH));
  await tick();
  const original = ready(first.result.current).editor;
  const dispose = vi.spyOn(original, 'dispose');
  move(first.result.current, 88);
  await advance(500);
  first.unmount();
  const second = renderHook(() => useCanvasFile(PATH));
  await tick();
  expect(ready(second.result.current).editor).toBe(original);
  await act(async () => {
    finish();
  });
  await tick();
  expect(xOf()).toBe(88);
  expect(dispose).not.toHaveBeenCalled();
  expect(editorHoldersOf(PATH)).toHaveLength(1);
  move(second.result.current, 89);
  await act(() => flushOpenPages());
  expect(xOf()).toBe(89);
  second.unmount();
  await tick();
  expect(dispose).toHaveBeenCalledOnce();
});

it('reopens an invalid inspector draft in the same retained scene', async () => {
  let current: CanvasFile = { state: 'loading' };
  function OpenBoard() {
    current = useCanvasFile(PATH);
    return current.state === 'ready' ? (
      <BoardCanvas source={current.editor} name="Plan" cameraKey="invalid-reopen" />
    ) : null;
  }
  const first = render(<OpenBoard />);
  await tick();
  const original = ready(current).editor;
  act(() => original.select(['n:a']));
  fireEvent.change(screen.getByRole('textbox', { name: 'W' }), {
    target: { value: '-invalid width' },
  });
  first.unmount();
  await tick();
  expect(unresolvedOpenPages()[0].latestDraft).toContain('-invalid width');
  render(<OpenBoard />);
  await tick();
  expect(ready(current).editor).toBe(original);
  const width = screen.getByRole('textbox', { name: 'W' });
  expect(width).toHaveProperty('value', '-invalid width');
  fireEvent.change(width, { target: { value: '175' } });
  await act(() => flushOpenPages());
  expect(JSON.parse(fs().get(PATH)!).nodes[0].width).toBe(175);
  expect(unresolvedOpenPages()).toEqual([]);
});
