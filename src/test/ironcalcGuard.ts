import { afterEach, vi } from 'vitest';

const trips: string[] = [];
export function guardsIronCalc(testPath: string): boolean {
  return !testPath.endsWith('.ironcalc.test.ts');
}

/** A loader rejection becomes an unavailable surface, so afterEach also
 * reports the attempted real load. Only dedicated engine tests may load it. */
export function installIronCalcGuard(testPath: string): void {
  if (!guardsIronCalc(testPath)) return;
  for (const id of ['@ironcalc/wasm', '@ironcalc/wasm/wasm_bg.wasm?url']) {
    vi.doMock(id, () => {
      trips.push(id);
      throw new Error(`the sheet engine guard refused ${id} in ${testPath}`);
    });
  }
  afterEach(() => checkIronCalcTrips(testPath));
}

export function checkIronCalcTrips(testPath: string): void {
  if (!trips.length) return;
  const ids = [...new Set(trips.splice(0))];
  throw new Error(
    `${testPath} reached the real sheet engine (${ids.join(', ')}). Mock calculateSheets from '@/lib/ipc', or measure the engine in a *.ironcalc.test.ts file (AGENTS.md CV-54).`,
  );
}
