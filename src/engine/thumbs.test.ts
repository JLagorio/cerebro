import { describe, expect, it } from 'vitest';
import cases from '../../src-tauri/fixtures/thumbnail-cases.json';
import {
  snapThumbSize,
  thumbReason,
  thumbSource,
  type ThumbReason,
  type ThumbSource,
} from './thumbs';
describe('thumbnail-cases.json', () => {
  it.each(cases.sizes)('snaps $input to $expected', ({ input, expected }) =>
    expect(snapThumbSize(input)).toBe(expected),
  );
  it('names every native reason and source', () => {
    for (const reason of cases.reasons) expect(thumbReason(reason as ThumbReason)).not.toBe('');
    for (const source of cases.sources)
      expect(thumbSource(source as ThumbSource)).not.toBeUndefined();
  });
  it('bounds non-finite renderer inputs', () => {
    expect(snapThumbSize(NaN)).toBe(128);
    expect(snapThumbSize(Infinity)).toBe(128);
    expect(snapThumbSize(-100)).toBe(128);
  });
});
