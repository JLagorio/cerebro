import { describe, expect, it } from 'vitest';
import { lookFor } from './fileIcons';

describe('lookFor — folders', () => {
  it('opens and closes the generic folder glyph', () => {
    expect(lookFor('whatever', true, { expanded: false }).icon).toBe('folder');
    expect(lookFor('whatever', true, { expanded: true }).icon).toBe('folder-open');
  });

  it('gives well-known folders their own glyph regardless of open state', () => {
    expect(lookFor('.github', true).icon).toBe('github');
    expect(lookFor('scripts', true, { expanded: true }).icon).toBe('terminal');
    expect(lookFor('node_modules', true).icon).toBe('package');
  });

  it('matches folder names case-insensitively', () => {
    expect(lookFor('.GitHub', true).icon).toBe('github');
  });
});

describe('lookFor — files', () => {
  it('prefers an exact filename over its extension', () => {
    // package.json is json, but "the manifest" is the more useful signal.
    expect(lookFor('package.json', false).icon).toBe('package');
    expect(lookFor('other.json', false).icon).toBe('braces');
  });

  it('recognises README case-insensitively', () => {
    expect(lookFor('README.md', false).icon).toBe('book-open');
    expect(lookFor('readme.md', false).icon).toBe('book-open');
  });

  it('falls back to the extension', () => {
    expect(lookFor('main.rs', false).icon).toBe('file-code');
    expect(lookFor('styles.css', false).icon).toBe('palette');
  });

  it('reads the tail of a multi-dot dotfile', () => {
    expect(lookFor('.env.example', false).icon).toBe('key-round');
  });

  it('treats an extensionless dotfile as plain when it is unknown', () => {
    expect(lookFor('.unknownrc', false).icon).toBe('file');
  });

  it('falls back to a plain file for an unknown extension', () => {
    const look = lookFor('notes.xyz', false);
    expect(look.icon).toBe('file');
    expect(look.color).toBeNull();
  });
});

describe('lookFor — colours', () => {
  it('uses DS option tokens, never a raw hex', () => {
    for (const name of ['main.rs', 'app.tsx', 'README.md', 'package.json', 'styles.css']) {
      const { color } = lookFor(name, false);
      expect(color, name).toMatch(/^var\(--(opt-[a-z]+|n-\d+)\)$/);
    }
  });

  it('colours a folder too', () => {
    expect(lookFor('src', true).color).toBe('var(--opt-blue)');
  });
});

describe('lookFor — plain mode is the configurable off switch', () => {
  it('collapses every file to one neutral glyph', () => {
    for (const name of ['main.rs', 'README.md', 'package.json']) {
      const look = lookFor(name, false, { plain: true });
      expect(look.icon).toBe('file-text');
      expect(look.color).toBeNull();
    }
  });

  it('collapses folders to a caret', () => {
    expect(lookFor('src', true, { plain: true, expanded: false }).icon).toBe('chevron-right');
    expect(lookFor('src', true, { plain: true, expanded: true }).icon).toBe('chevron-down');
  });
});
