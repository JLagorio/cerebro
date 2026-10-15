// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerOsDropZone, retainOsDropRouter, routeOsDrop } from './osDrop';
import { useUiStore } from '@/stores/uiStore';
import { NO_DROP_ZONE } from '@/engine/osDrop';
const { listen, stop } = vi.hoisted(() => ({ listen: vi.fn(), stop: vi.fn() }));
vi.mock('./ipc', () => ({ listenOsFileDrop: listen }));
const clean: (() => void)[] = [];
let target: Element | null;
beforeEach(() => {
  target = null;
  listen.mockResolvedValue(stop);
  useUiStore.setState({ toasts: [] });
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => target),
  });
});
afterEach(async () => {
  for (const close of clean.splice(0)) close();
  document.body.replaceChildren();
  await Promise.resolve();
  vi.clearAllMocks();
});
const position = { x: 10, y: 20 };
it('ignores internal drags with no paths', () => {
  routeOsDrop({ type: 'enter', paths: [], position });
  routeOsDrop({ type: 'over', position });
  routeOsDrop({ type: 'drop', paths: [], position });
  expect(useUiStore.getState().toasts).toEqual([]);
});
it('the innermost registered editor wins over the Inbox and hover clears on leave', async () => {
  const inbox = document.createElement('div');
  const editor = document.createElement('div');
  const child = document.createElement('span');
  inbox.append(editor);
  editor.append(child);
  document.body.append(inbox);
  const outer = { over: vi.fn(), drop: vi.fn() };
  const inner = { over: vi.fn(), drop: vi.fn() };
  clean.push(registerOsDropZone(inbox, outer), registerOsDropZone(editor, inner));
  target = child;
  routeOsDrop({ type: 'enter', paths: ['/a.md'], position });
  expect(inner.over).toHaveBeenLastCalledWith(true);
  expect(outer.over).not.toHaveBeenCalled();
  routeOsDrop({ type: 'leave' });
  expect(inner.over).toHaveBeenLastCalledWith(false);
  routeOsDrop({ type: 'drop', paths: ['/a.md'], position });
  await Promise.resolve();
  expect(inner.drop).toHaveBeenCalledWith(['/a.md'], position);
  expect(outer.drop).not.toHaveBeenCalled();
});
it('installs once and toasts one unsupported drop even with multiple zones', async () => {
  clean.push(retainOsDropRouter());
  clean.push(registerOsDropZone(document.createElement('div'), { over: vi.fn(), drop: vi.fn() }));
  expect(listen).toHaveBeenCalledTimes(1);
  routeOsDrop({ type: 'enter', paths: ['/a.md'], position });
  routeOsDrop({ type: 'over', position });
  expect(useUiStore.getState().toasts).toEqual([]);
  routeOsDrop({ type: 'drop', paths: ['/a.md'], position });
  expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([NO_DROP_ZONE]);
  clean.splice(0).forEach((close) => close());
  await Promise.resolve();
  await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
});
it('toasts a throwing handler without leaking a rejection', async () => {
  const element = document.createElement('div');
  target = element;
  clean.push(
    registerOsDropZone(element, {
      over: vi.fn(),
      drop: () => {
        throw new Error('no space');
      },
    }),
  );
  routeOsDrop({ type: 'drop', paths: ['/a.md'], position });
  await vi.waitFor(() => expect(useUiStore.getState().toasts[0]?.message).toContain('no space'));
});
it('an obsolete native listener cannot deliver while its async unlisten is pending', async () => {
  let finish!: (stop: () => void) => void;
  listen.mockReturnValueOnce(
    new Promise<() => void>((resolve) => {
      finish = resolve;
    }),
  );
  const older = retainOsDropRouter();
  const oldReceiver = listen.mock.calls[0][0];
  older();
  clean.push(retainOsDropRouter());
  const newReceiver = listen.mock.calls[1][0];
  oldReceiver({ type: 'drop', paths: ['/old.md'], position });
  expect(useUiStore.getState().toasts).toEqual([]);
  newReceiver({ type: 'drop', paths: ['/new.md'], position });
  expect(useUiStore.getState().toasts).toHaveLength(1);
  const oldStop = vi.fn();
  finish(oldStop);
  await vi.waitFor(() => expect(oldStop).toHaveBeenCalledTimes(1));
});
it('captures the handler synchronously at drop time before its zone is replaced', () => {
  const element = document.createElement('div');
  target = element;
  const old = vi.fn();
  const next = vi.fn();
  const release = registerOsDropZone(element, { over: vi.fn(), drop: old });
  routeOsDrop({ type: 'drop', paths: ['/a.md'], position });
  expect(old).toHaveBeenCalledWith(['/a.md'], position);
  release();
  clean.push(registerOsDropZone(element, { over: vi.fn(), drop: next }));
  expect(next).not.toHaveBeenCalled();
});
