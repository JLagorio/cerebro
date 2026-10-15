import { beforeEach, describe, expect, it } from 'vitest';
import paths from '../../src-tauri/fixtures/document-paths.json';
import wire from '../../src-tauri/fixtures/extract-wire.json';
import { extractDocument, resetMockFs, seedExtractions } from './mockIpc';
import { seedBytes, seedLink } from './mockBytes';
import { sha256Bytes } from './sha256';
beforeEach(() => resetMockFs());
describe('native document-paths.json and extract-wire.json parity', () => {
  it('replays document-paths.json in the native refusal order', async () => {
    seedBytes('0', 'docs/report.docx', { text: 'bytes' });
    for (const row of paths) {
      if ('error' in row)
        await expect(extractDocument('/demo-vault', row.path)).rejects.toThrow(row.error);
      else
        await expect(extractDocument('/demo-vault', row.path)).resolves.toMatchObject({
          format: 'docx',
        });
    }
  });
  it('answers seeded outcomes in extract-wire.json shape with the actual copied-byte hash', async () => {
    const bytes = new Uint8Array(12);
    seedBytes('0', 'docs/report.docx', { bytes });
    seedExtractions({ 'docs/report.docx': { ...wire.outcome, state: 'extracted' } });
    expect(await extractDocument('/demo-vault', 'docs/report.docx')).toEqual({
      ...wire,
      sha256: sha256Bytes(bytes),
    });
  });
  it('is explicit when the browser has no Office reader, and resets seeds', async () => {
    seedBytes('0', 'docs/report.docx', { text: 'x' });
    const result = await extractDocument('/demo-vault', 'docs/report.docx');
    expect(result.outcome).toEqual({
      state: 'unsupported',
      detail: 'The browser build has no Office reader; the desktop app extracts this file.',
    });
    seedExtractions({ 'docs/report.docx': { state: 'encrypted' } });
    expect((await extractDocument('/demo-vault', 'docs/report.docx')).outcome).toEqual({
      state: 'encrypted',
    });
    resetMockFs();
    seedBytes('0', 'docs/report.docx', { text: 'x' });
    expect((await extractDocument('/demo-vault', 'docs/report.docx')).outcome.state).toBe(
      'unsupported',
    );
  });
  it('checks symlink landings and aliases xlsm to xlsx without executing macros', async () => {
    seedBytes('0', '.hidden/report.docx', { text: 'private' });
    seedLink('0', 'visible.docx', '.hidden/report.docx');
    await expect(extractDocument('/demo-vault', 'visible.docx')).rejects.toThrow(
      'dot-folders and dotfiles',
    );
    seedLink('0', 'out.docx', '../private.docx');
    await expect(extractDocument('/demo-vault', 'out.docx')).rejects.toThrow(
      'path escapes the vault',
    );
    seedBytes('0', 'macro.xlsm', { text: 'bytes' });
    expect((await extractDocument('/demo-vault', 'macro.xlsm')).format).toBe('xlsx');
  });
  it('refuses over-limit input before a seeded parser outcome', async () => {
    seedBytes('0', 'large.docx', { size: 256 * 1024 * 1024 + 1 });
    seedExtractions({ 'large.docx': { state: 'encrypted' } });
    expect((await extractDocument('/demo-vault', 'large.docx')).outcome.state).toBe('too_large');
  });
});
