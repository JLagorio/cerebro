import { expect, it } from 'vitest';
import { isStaleContent } from './staleContent';
it('recognizes only the typed stale prefix across IPC and JavaScript errors', () => {
  expect(isStaleContent('stale_content: a.md changed')).toBe(true);
  expect(isStaleContent(new Error('stale_content: a.md changed'))).toBe(true);
  for (const other of [null, {}, 'disk full', 'not stale_content:', new Error('disk full')])
    expect(isStaleContent(other)).toBe(false);
});
