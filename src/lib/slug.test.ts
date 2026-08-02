import { describe, expect, it } from 'vitest';
import { humanizeSlug, slugify } from '@/lib/slug';

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

describe('humanizeSlug', () => {
  it('title-cases dash- and underscore-separated words', () => {
    expect(humanizeSlug('app-notes')).toBe('App Notes');
    expect(humanizeSlug('field_app')).toBe('Field App');
  });
  // 'Guided Onboarding Ga' read as a typo the user could not correct — the
  // folder is called GA and renaming it would just be lowercased back.
  it('keeps known acronyms uppercase instead of mangling them', () => {
    expect(humanizeSlug('guided-onboarding-ga')).toBe('Guided Onboarding GA');
    expect(humanizeSlug('q3-okr-review')).toBe('Q3 OKR Review');
    expect(humanizeSlug('api-notes')).toBe('API Notes');
  });
  it('leaves ordinary words alone', () => {
    expect(humanizeSlug('meetings')).toBe('Meetings');
    expect(humanizeSlug('items')).toBe('Items');
  });
  it('falls back to the raw slug when there is nothing to split', () => {
    expect(humanizeSlug('')).toBe('');
  });
});
