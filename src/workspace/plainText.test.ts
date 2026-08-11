import { describe, expect, it } from 'vitest';
import { plainExcerpt } from './plainText';

describe('plainExcerpt', () => {
  it('drops heading marks but keeps the words', () => {
    expect(plainExcerpt('# Atlas\n\nA ledger.')).toBe('Atlas A ledger.');
  });

  it('removes a fenced block entirely, contents and all', () => {
    const md = 'Install it.\n\n```bash\npnpm install\n```\n\nThen run.';
    expect(plainExcerpt(md)).toBe('Install it. Then run.');
  });

  it('keeps link text and discards the target', () => {
    expect(plainExcerpt('See [the guide](./docs/guide.md) first.')).toBe('See the guide first.');
  });

  it('drops an image rather than reading its alt text as prose', () => {
    expect(plainExcerpt('Before ![a diagram](x.png) after')).toBe('Before after');
  });

  it('unwraps inline code, emphasis and strikethrough', () => {
    expect(plainExcerpt('Call `run()` **now**, not _later_, and never ~~then~~.')).toBe(
      'Call run() now, not later, and never then.',
    );
  });

  it('strips list and quote markers', () => {
    expect(plainExcerpt('- one\n- two\n\n> quoted')).toBe('one two quoted');
  });

  it('shows a wikilink label, or its target when it has none', () => {
    expect(plainExcerpt('[[projects/atlas|Atlas]] and [[Beacon]]')).toBe('Atlas and Beacon');
  });

  it('collapses every run of whitespace to one space', () => {
    expect(plainExcerpt('a\n\n\nb   c\t\td')).toBe('a b c d');
  });

  it('leaves plain prose exactly as it was', () => {
    expect(plainExcerpt('Just a sentence.')).toBe('Just a sentence.');
  });

  it('is empty for input that was only syntax', () => {
    expect(plainExcerpt('---\n\n```\ncode\n```')).toBe('');
  });
});
