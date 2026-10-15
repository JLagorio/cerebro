/** Browser-only extraction outcomes; paths obey the native read boundary. */
import type { Extraction, ExtractionOutcome } from '@/engine/extracted';
import { extOf, kindFor } from '@/engine/fileKinds';
import { isFileRefusal, relRefusal } from '@/engine/fileBytes';
import { resolveBytes } from './mockBytes';
import { sha256Bytes } from './sha256';
const seeded = new Map<string, ExtractionOutcome>();
export function resetExtractions(): void {
  seeded.clear();
}
export function seedExtractions(rows: Record<string, ExtractionOutcome>): void {
  seeded.clear();
  for (const [path, value] of Object.entries(rows)) seeded.set(path, structuredClone(value));
}
const hidden = (path: string) => path.split('/').some((part) => part.startsWith('.'));
export async function extractDocument(_vault: string, path: string): Promise<Extraction> {
  if (relRefusal('0', path) !== null || path.charAt(1) === ':')
    throw new Error(`path escapes the vault: ${path}`);
  if (hidden(path)) throw new Error('dot-folders and dotfiles are not readable here');
  const file = resolveBytes('0', path);
  if (isFileRefusal(file)) {
    if (file.code === 'outside' || file.code === 'bad_address')
      throw new Error(`path escapes the vault: ${path}`);
    if (file.code === 'folder') throw new Error(`${path} is a folder, not a file`);
    throw new Error(`no file at ${path}`);
  }
  if (hidden(file.path)) throw new Error('dot-folders and dotfiles are not readable here');
  const ext = extOf(path) ?? '';
  const format = kindFor(path).extractor;
  let outcome: ExtractionOutcome;
  if (file.size > 256 * 1024 * 1024)
    outcome = { state: 'too_large', detail: 'the file exceeds 256 MiB' };
  else if (format !== 'docx' && format !== 'pptx' && format !== 'xlsx')
    outcome = { state: 'unsupported', detail: `Cerebro has no text reader for .${ext} files` };
  else
    outcome = structuredClone(
      seeded.get(path) ?? {
        state: 'unsupported',
        detail: 'The browser build has no Office reader; the desktop app extracts this file.',
      },
    );
  return {
    format: format === 'pdf' ? ext : (format ?? ext),
    sha256: sha256Bytes(file.bytes),
    bytes: file.size,
    outcome,
  };
}
if (typeof window !== 'undefined') {
  (
    window as unknown as { __cerebroSeedExtractions: typeof seedExtractions }
  ).__cerebroSeedExtractions = seedExtractions;
}
