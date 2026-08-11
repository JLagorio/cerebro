import { describe, expect, it } from 'vitest';
import { isVaultPath, isWebUrl } from './linkTargets';

// One predicate pair, two callers: the popover that OFFERS targets and the
// badge that OPENS them. They spelled their own regexes first and drifted —
// the badge's looser prefix test classified things the popover would never
// have produced, and routed the rest at the vault router regardless.
describe('link target classification (M29.38)', () => {
  it('a web URL is the whole string, http(s) only', () => {
    for (const t of ['https://example.com', 'http://a.b/c?d=e#f', '  https://example.com  ']) {
      expect([t, isWebUrl(t)]).toEqual([t, true]);
    }
    for (const t of [
      'notes/a.md',
      'https://example.com and more', // whitespace: not one target
      'ftp://example.com',
      'javascript:alert(1)',
      'mailto:x@y.com',
      '',
    ]) {
      expect([t, isWebUrl(t)]).toEqual([t, false]);
    }
  });

  it('a vault path is anything carrying no URI scheme at all', () => {
    for (const t of ['notes/a.md', 'a.md', 'my notes/a b.md', './rel.md', '  padded.md  ']) {
      expect([t, isVaultPath(t)]).toEqual([t, true]);
    }
    // Every one of these is hand-written only — LinkPopover offers a URL or a
    // vault path and nothing else — and each would have become a doc page for
    // a file that does not exist.
    for (const t of [
      'mailto:x@y.com',
      'tel:+15551234',
      'file:///etc/passwd',
      'data:text/html,x',
      'https://example.com',
      'C:\\Users\\a.md',
      '',
    ]) {
      expect([t, isVaultPath(t)]).toEqual([t, false]);
    }
  });

  it('the two readings never overlap, and a target can be neither', () => {
    expect(isWebUrl('https://a.b') && isVaultPath('https://a.b')).toBe(false);
    expect(isWebUrl('mailto:x@y.com') || isVaultPath('mailto:x@y.com')).toBe(false);
  });
});
