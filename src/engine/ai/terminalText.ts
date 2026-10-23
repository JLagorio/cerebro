/**
 * Terminal output as the lines a person would read (M91.10): escape sequences
 * removed, CRLF read as LF, and a carriage-return rewrite (a progress line)
 * resolved to the text that stayed on screen. Pure: no DOM.
 */

const ESCAPES =
  // eslint-disable-next-line no-control-regex -- ESC and BEL are the match: CSI, OSC and two-byte escapes leave no text a person reads.
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function terminalLines(text: string): string[] {
  return text
    .replace(ESCAPES, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const rewrites = line.split('\r').filter((part) => part !== '');
      return rewrites.length === 0 ? '' : rewrites[rewrites.length - 1];
    });
}
