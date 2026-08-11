import { describe, expect, it } from 'vitest';
import { classifyHref, resolveRelative } from './docLinks';

describe('resolveRelative', () => {
  it('resolves a sibling', () => {
    expect(resolveRelative('docs/guide.md', './setup.md')).toBe('docs/setup.md');
  });

  it('resolves a bare sibling with no leading dot', () => {
    expect(resolveRelative('docs/guide.md', 'setup.md')).toBe('docs/setup.md');
  });

  it('resolves a parent hop', () => {
    expect(resolveRelative('docs/guide/setup.md', '../index.md')).toBe('docs/index.md');
  });

  it('resolves a descent', () => {
    expect(resolveRelative('README.md', './docs/guide.md')).toBe('docs/guide.md');
  });

  it('treats a leading slash as root-relative', () => {
    expect(resolveRelative('docs/guide.md', '/README.md')).toBe('README.md');
  });

  it('drops a fragment', () => {
    expect(resolveRelative('docs/guide.md', './setup.md#install')).toBe('docs/setup.md');
  });

  it('drops a query string', () => {
    expect(resolveRelative('docs/guide.md', './setup.md?v=2')).toBe('docs/setup.md');
  });

  it('cannot climb above the root', () => {
    expect(resolveRelative('README.md', '../../etc/passwd')).toBe('etc/passwd');
  });
});

describe('classifyHref', () => {
  it('calls out external links', () => {
    expect(classifyHref('https://example.com')).toBe('external');
    expect(classifyHref('mailto:a@b.c')).toBe('external');
  });

  it('calls out in-page anchors', () => {
    expect(classifyHref('#install')).toBe('anchor');
  });

  it('calls everything else internal', () => {
    expect(classifyHref('./setup.md')).toBe('internal');
    expect(classifyHref('docs/guide.md')).toBe('internal');
  });
});
