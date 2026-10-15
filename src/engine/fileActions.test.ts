import { expect, it } from 'vitest';
import { fileActionWords, isFileActionRefusal } from './fileActions';
import { fileRefusal } from './fileBytes';
it('reports refusals and saved destinations, keeping handoffs and cancel silent', () => {
  for (const state of ['opened', 'revealed', 'previewed', 'cancelled'] as const)
    expect(fileActionWords({ state })).toBeNull();
  expect(fileActionWords({ state: 'saved', destination: '/tmp/copy.png' })).toBe(
    'Saved a copy to /tmp/copy.png',
  );
  expect(fileActionWords(fileRefusal('outside'))).toBe(fileRefusal('outside').message);
  expect(fileActionWords({ code: 'changed', message: 'File changed' })).toBe('File changed');
});
it('does not disguise transport errors as a typed refusal', () => {
  expect(isFileActionRefusal({ code: 'changed', message: 'File changed' })).toBe(true);
  expect(isFileActionRefusal({ code: 'outside' })).toBe(false);
  expect(isFileActionRefusal({ code: 'unknown_command', message: 'Command not found' })).toBe(
    false,
  );
  expect(isFileActionRefusal('Connection lost')).toBe(false);
});
