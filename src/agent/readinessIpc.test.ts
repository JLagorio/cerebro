import { afterEach, expect, it } from 'vitest';
import { readCliReadiness } from './agentIpc';
import { failNext, resetFaults } from '@/lib/mockFaults';

afterEach(resetFaults);

it('the browser readiness check is explicitly a mock and can report a failed read', async () => {
  expect(await readCliReadiness()).toMatchObject({
    state: 'available',
    backend: 'browser_mock',
    path: null,
  });
  failNext('check_cli_readiness');
  await expect(readCliReadiness()).rejects.toThrow('check_cli_readiness');
  resetFaults();
  expect(await readCliReadiness()).toMatchObject({ state: 'available', backend: 'browser_mock' });
});
