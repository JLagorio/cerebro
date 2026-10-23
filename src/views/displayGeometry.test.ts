import { describe, expect, it } from 'vitest';
import { tableTitleWidth, timeTableAllocation } from './displayGeometry';

describe('render-only view allocation', () => {
  it('gives unconfigured titles room without changing explicit widths', () => {
    expect(tableTitleWidth(1200)).toBe(384);
    expect(tableTitleWidth(400)).toBe(240);
    expect(tableTitleWidth(320)).toBe(200);
    expect(tableTitleWidth(1800)).toBe(480);
    expect(tableTitleWidth(1200, 225)).toBe(225);
  });

  it('preserves a usable time axis even with many wide table columns', () => {
    for (const width of [720, 900, 1146, 1600]) {
      const split = timeTableAllocation(width, 1050);
      expect(split.width).toBeLessThanOrEqual(width / 2);
      expect(width - split.width).toBeGreaterThanOrEqual(320);
    }
    expect(timeTableAllocation(1146).width).toBeCloseTo(401.1);
    expect(timeTableAllocation(480, 400).width).toBe(220);
    expect(timeTableAllocation(320, 400).width).toBe(160);
  });
});
