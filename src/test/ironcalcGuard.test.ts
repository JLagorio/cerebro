import { describe, expect, it } from 'vitest';
import { calculateSheets } from '@/lib/ipc';
import { checkIronCalcTrips, guardsIronCalc } from './ironcalcGuard';

describe('the sheet engine guard', () => {
  it('guards every test except dedicated engine measurements', () => {
    expect(guardsIronCalc('/repo/src/sheet/SheetView.test.tsx')).toBe(true);
    expect(guardsIronCalc('/repo/src/lib/mockSheet.ironcalc.test.ts')).toBe(false);
  });
  it('fails a swallowed real load and names the mock seam', async () => {
    await expect(calculateSheets([])).rejects.toThrow(
      "The sheet engine couldn't load in this browser.",
    );
    expect(() => checkIronCalcTrips(expect.getState().testPath ?? '')).toThrow(
      "Mock calculateSheets from '@/lib/ipc'",
    );
    expect(() => checkIronCalcTrips('after')).not.toThrow();
  });
});
