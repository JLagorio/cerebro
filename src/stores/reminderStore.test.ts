import { beforeEach, expect, it, vi } from 'vitest';
import { useReminderStore } from './reminderStore';
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/ipc', () => ({ reminderState: read }));
beforeEach(() => {
  vi.clearAllMocks();
  useReminderStore.getState().reset(null);
});
it('hydrates once and ignores a late old-vault read', async () => {
  let finish!: (r: { fires: []; window: null }) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = useReminderStore.getState().hydrate('/a');
  const same = useReminderStore.getState().hydrate('/a');
  expect(read).toHaveBeenCalledOnce();
  read.mockResolvedValue({ fires: [], window: null });
  await useReminderStore.getState().hydrate('/b');
  finish({ fires: [], window: null });
  await Promise.all([old, same]);
  expect(useReminderStore.getState()).toMatchObject({ vault: '/b', status: 'ready', fires: {} });
});
it('retains an unavailable read as error, not ready-empty', async () => {
  read.mockRejectedValue(Error('disk'));
  await useReminderStore.getState().hydrate('/a');
  expect(useReminderStore.getState().status).toBe('error');
});
