import { describe, expect, it } from 'vitest';
import { TEMPLATES } from './templates';

describe('TEMPLATES', () => {
  it('every template has an id, label, icon, and non-empty starter code', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(10);
    for (const t of TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(t.icon).toBeTruthy();
      expect(t.code.trim().length).toBeGreaterThan(0);
    }
  });

  it('ids are unique', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
  });
});
