import { beforeEach, expect, it, vi } from 'vitest';
import { stampActivation } from './activation';
import { jobLedgerClaim } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
vi.mock('@/lib/ipc', () => ({ jobLedgerClaim: vi.fn(async () => true) }));
const NOW = new Date(2026, 6, 28, 14);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(jobLedgerClaim).mockResolvedValue(true);
  useUiStore.setState({ skillRuns: {} });
});
it('stamps the newest list fire durably before recording it locally', async () => {
  vi.mocked(jobLedgerClaim).mockImplementation(async () => {
    expect(useUiStore.getState().skillRuns).toEqual({});
    return true;
  });
  expect(await stampActivation('/v', 'digest', ['daily 09:00', 'daily 12:00'], NOW)).toBe(true);
  expect(jobLedgerClaim).toHaveBeenCalledWith('/v', 'skillRuns', 'digest', '2026-07-28 12:00');
  expect(useUiStore.getState().skillRuns).toEqual({ '/v': { digest: '2026-07-28 12:00' } });
});
it('records an already answered key too', async () => {
  vi.mocked(jobLedgerClaim).mockResolvedValue(false);
  expect(await stampActivation('/v', 'digest', 'daily 09:00', NOW)).toBe(true);
  expect(useUiStore.getState().skillRuns['/v'].digest).toBe('2026-07-28 09:00');
});
it.each([null, [], ['bad'], ['once 2026-10-20 09:00']])(
  'does nothing when there is no passed fire: %j',
  async (schedule) => {
    expect(await stampActivation('/v', 'digest', schedule, NOW)).toBe(true);
    expect(jobLedgerClaim).not.toHaveBeenCalled();
  },
);
it('returns false on a rejected write and leaves local state intact', async () => {
  useUiStore.setState({ skillRuns: { '/v': { digest: 'older' } } });
  vi.mocked(jobLedgerClaim).mockRejectedValue(new Error('disk'));
  expect(await stampActivation('/v', 'digest', 'daily 09:00', NOW)).toBe(false);
  expect(useUiStore.getState().skillRuns).toEqual({ '/v': { digest: 'older' } });
});
