import { describe, expect, it } from 'vitest';
import { slugify } from '@/lib/slug';

describe('slugify', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(slugify('Ship the fix!')).toBe('ship-the-fix');
  });
  it('strips diacritics and trims dashes', () => {
    expect(slugify('  Émigré notes ')).toBe('emigre-notes');
  });
  it('collapses runs of separators', () => {
    expect(slugify('A  --  B')).toBe('a-b');
  });
});
