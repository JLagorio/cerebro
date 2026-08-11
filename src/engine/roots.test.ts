import { describe, expect, it } from 'vitest';
import { isMarkdownPath, parentPath, viewerKindFor } from './roots';

describe('isMarkdownPath', () => {
  it('accepts .md and .markdown regardless of case', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('docs/Guide.MARKDOWN')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isMarkdownPath('src/main.rs')).toBe(false);
    expect(isMarkdownPath('mdfile')).toBe(false);
  });
});

describe('viewerKindFor', () => {
  it('routes markdown to the doc viewer', () => {
    expect(viewerKindFor('README.md')).toBe('doc');
  });

  it('routes anything else to the code viewer', () => {
    expect(viewerKindFor('src/main.rs')).toBe('code');
    expect(viewerKindFor('Dockerfile.dev')).toBe('code');
  });
});

describe('parentPath', () => {
  it('drops the last segment', () => {
    expect(parentPath('docs/guide/setup.md')).toBe('docs/guide');
  });

  it('returns the root for a top-level path', () => {
    expect(parentPath('README.md')).toBe('');
  });
});
