import { describe, expect, it } from 'vitest';
import { languageFor } from './highlighter';

describe('languageFor', () => {
  it('maps known extensions', () => {
    expect(languageFor('src/main.rs')).toBe('rust');
    expect(languageFor('src/app.tsx')).toBe('tsx');
    expect(languageFor('Cargo.toml')).toBe('toml');
  });

  it('maps extensionless well-known filenames', () => {
    expect(languageFor('Dockerfile')).toBe('docker');
    expect(languageFor('Makefile')).toBe('make');
  });

  it('returns null for anything unrecognised, so it renders as plain text', () => {
    expect(languageFor('notes.xyz')).toBeNull();
    expect(languageFor('.env.example')).toBeNull();
  });

  it('reads the extension from the filename, not the directory', () => {
    expect(languageFor('a.rs/b.md')).toBe('markdown');
  });

  it('is case-insensitive on the extension', () => {
    expect(languageFor('Main.RS')).toBe('rust');
  });
});
