import { describe, expect, it } from 'vitest';
import { gitBadgeText, isMarkdownPath, parentPath, viewerKindFor } from './roots';

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

describe('gitBadgeText', () => {
  it('stays silent when a repo is clean and in sync', () => {
    expect(gitBadgeText({ branch: 'main', ahead: 0, behind: 0, dirty: 0 })).toBeNull();
  });

  it('speaks the branch only once there is something to say', () => {
    expect(gitBadgeText({ branch: 'main', ahead: 2, behind: 0, dirty: 0 })).toBe('main ↑2');
    expect(gitBadgeText({ branch: 'main', ahead: 0, behind: 3, dirty: 0 })).toBe('main ↓3');
    expect(gitBadgeText({ branch: 'wip', ahead: 0, behind: 0, dirty: 4 })).toBe('wip ●4');
  });

  it('orders ahead, behind, then dirty', () => {
    expect(gitBadgeText({ branch: 'main', ahead: 1, behind: 2, dirty: 3 })).toBe('main ↑1 ↓2 ●3');
  });
});
