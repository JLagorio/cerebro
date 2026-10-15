import { beforeEach, expect, it, vi } from 'vitest';
import payloads from '../../src-tauri/fixtures/deep-link-payloads.json';
const ipc = vi.hoisted(() => ({ listenDeepLinks: vi.fn(), takeDeepLink: vi.fn() }));
vi.mock('@/lib/ipc', () => ipc);
import {
  __resetDeepLinks,
  hasPendingDeepLink,
  primeDeepLinks,
  readDeepLink,
  shiftDeepLink,
} from './deepLinks';
const home = { kind: 'go', to: 'home', database: null, view: null, vault: null };
beforeEach(() => {
  __resetDeepLinks();
  vi.resetAllMocks();
  ipc.listenDeepLinks.mockResolvedValue(() => {});
  ipc.takeDeepLink.mockResolvedValue(null);
});
it('reads every shared delivered payload without parsing a URL', () => {
  for (const payload of payloads.payloads) expect(readDeepLink(payload)).toEqual(payload);
  for (const bad of [
    null,
    [],
    {},
    { kind: 'open', path: 3, vault: null },
    { kind: 'open', path: 'a', vault: { id: 'x', lookup: {} } },
    { kind: 'go', to: 'history', vault: null },
    { kind: 'refused', reason: 2 },
  ])
    expect(readDeepLink(bad)).toBeNull();
});
it('binds the listener before the take and a second prime does nothing', async () => {
  let bound!: (stop: () => void) => void;
  ipc.listenDeepLinks.mockReturnValue(
    new Promise<() => void>((resolve) => {
      bound = resolve;
    }),
  );
  const first = primeDeepLinks();
  expect(primeDeepLinks()).toBe(first);
  expect(ipc.takeDeepLink).not.toHaveBeenCalled();
  expect(hasPendingDeepLink('/vault')).toBe(true);
  bound(() => {});
  await first;
  expect(ipc.listenDeepLinks).toHaveBeenCalledTimes(1);
  expect(ipc.takeDeepLink).toHaveBeenCalledTimes(1);
  expect(hasPendingDeepLink('/vault')).toBe(false);
});
it('keeps the held link ahead of events received while taking, and consumes once', async () => {
  let reply!: (value: unknown) => void;
  ipc.takeDeepLink.mockReturnValue(
    new Promise((resolve) => {
      reply = resolve;
    }),
  );
  const started = primeDeepLinks();
  await Promise.resolve();
  const receive = ipc.listenDeepLinks.mock.calls[0][0] as (payload: unknown) => void;
  receive({ ...home, to: 'history' });
  expect(shiftDeepLink()).toBeNull();
  reply(home);
  await started;
  expect(shiftDeepLink()).toEqual(home);
  expect(shiftDeepLink()).toEqual({ ...home, to: 'history' });
  expect(shiftDeepLink()).toBeNull();
  receive({ kind: 'refused', reason: 'bad' });
  expect(shiftDeepLink()).toEqual({ kind: 'refused', reason: 'bad' });
});
it('turns a failed inbox read into visible refusal rather than swallowing it', async () => {
  ipc.takeDeepLink.mockRejectedValue(new Error('offline'));
  await primeDeepLinks();
  expect(shiftDeepLink()).toEqual({
    kind: 'refused',
    reason: "Cerebro couldn't read its incoming links",
  });
});
