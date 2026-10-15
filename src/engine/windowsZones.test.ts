import { expect, it } from 'vitest';
import { WINDOWS_ZONES } from './windowsZones';
it('keeps the CLDR world mappings sorted and accepted by Intl', () => {
  const names = Object.keys(WINDOWS_ZONES);
  expect(names.length).toBeGreaterThan(100);
  expect(names).toEqual([...names].sort());
  expect(new Set(names).size).toBe(names.length);
  for (const zone of Object.values(WINDOWS_ZONES))
    expect(() => new Intl.DateTimeFormat('en', { timeZone: zone }).format(0)).not.toThrow();
  expect(WINDOWS_ZONES['W. Europe Standard Time']).toBe('Europe/Berlin');
});
