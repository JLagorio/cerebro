import { afterEach, describe, expect, it } from 'vitest';
import { VAULT_TODAY } from '@/lib/vaultToday';
import { clockLine, instantOf, LAB_NOW, pinClock, unpin } from './clock';

/** The lab's clock pins what the clock reads, and nothing else (M64.1). */

afterEach(unpin);

const PINNED = Date.UTC(2026, 6, 28, 12, 0, 0);

describe('pinClock', () => {
  it('pins Date.now() and a zero-argument new Date() to LAB_NOW', () => {
    pinClock();
    expect(Date.now()).toBe(PINNED);
    expect(new Date().getTime()).toBe(PINNED);
    expect(new Date().toISOString()).toBe('2026-07-28T12:00:00.000Z');
    expect(typeof Date()).toBe('string');
  });

  it('leaves new Date(value) and the static helpers alone', () => {
    pinClock();
    expect(new Date('2020-01-02T03:04:05Z').toISOString()).toBe('2020-01-02T03:04:05.000Z');
    expect(new Date(0).getTime()).toBe(0);
    expect(new Date(2021, 0, 1).getFullYear()).toBe(2021);
    expect(Date.UTC(2000, 0, 1)).toBe(946684800000);
    expect(Date.parse('2000-01-01T00:00:00Z')).toBe(946684800000);
  });

  it('keeps instanceof Date for dates made before and after the pin', () => {
    const before = new Date(5);
    pinClock();
    expect(before instanceof Date).toBe(true);
    expect(new Date() instanceof Date).toBe(true);
  });

  it('is undone by unpin, and pinning twice still unpins to the real clock', () => {
    const RealDate = Date;
    const undo = pinClock();
    pinClock('2026-07-29T00:00:00Z');
    expect(Date.now()).toBe(Date.UTC(2026, 6, 29));
    undo();
    expect(Date).toBe(RealDate);
    expect(Math.abs(Date.now() - new RealDate().getTime())).toBeLessThan(1000);
  });
});

describe('the lab instant', () => {
  it('is VAULT_TODAY', () => {
    expect(LAB_NOW).toBe(VAULT_TODAY);
    expect(instantOf(LAB_NOW)).toBe(PINNED);
  });

  it('refuses a stamp it would have to guess at', () => {
    expect(() => instantOf('2026-07-28 12:00')).toThrow('YYYY-MM-DDTHH:MM:SSZ');
  });

  it('names itself in words', () => {
    expect(clockLine()).toBe('Clock pinned to 28 Jul 2026, 12:00 UTC');
  });
});
