import { describe, expect, it } from 'vitest';
import { terminalLines } from './terminalText';

describe('terminalLines', () => {
  it('drops colour, cursor and title sequences', () => {
    expect(
      terminalLines(
        '\u001b[1m\u001b[31mFAIL\u001b[39m\u001b[22m a\n\u001b]0;title\u0007b\u001b[2K\u001b[1Gc\n\u001b]8;;https://x.example\u001b\\link\u001b]8;;\u001b\\',
      ),
    ).toEqual(['FAIL a', 'bc', 'link']);
  });

  it('reads CRLF as LF and keeps what a carriage-return rewrite left on screen', () => {
    // A carriage return with nothing after it erases nothing.
    expect(terminalLines('one\r\ntwo\r\n10%\r50%\r100%\nend\r')).toEqual([
      'one',
      'two',
      '100%',
      'end',
    ]);
  });

  it('keeps blank lines and indentation', () => {
    expect(terminalLines('\n  indented\n\tTabbed')).toEqual(['', '  indented', '\tTabbed']);
  });
});
