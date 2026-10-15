import { expect, it } from 'vitest';
import { findRequest, matchWords } from './find';
it('uses literal case-insensitive find with explicit next/previous direction', () => {
  expect(findRequest('a.*[b]')).toMatchObject({
    query: 'a.*[b]',
    caseSensitive: false,
    type: '',
    findPrevious: false,
  });
  expect(findRequest('Page', true, true)).toMatchObject({ type: 'again', findPrevious: true });
  expect(matchWords({ current: 2, total: 40 }, 'Page')).toBe('2 of 40');
  expect(matchWords({ current: 0, total: 0 }, '')).toBe('');
});
