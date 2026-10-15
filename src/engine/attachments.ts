import { KINDS } from './fileKinds';
import { isHiddenName } from './trash';

export const ATTACHMENT_MAX_BYTES = KINDS.limits.attachment_bytes;
export const capWords = `${ATTACHMENT_MAX_BYTES / 1_000_000} MB`;
export interface AttachmentImport {
  path: string;
  reused: boolean;
}
const basename = (name: string) => name.split(/[\\/]/).at(-1)?.trim() ?? '';

export function attachmentRefusal(name: string, size: number): string | null {
  const leaf = basename(name);
  if (leaf === '') return 'a file needs a name';
  if (isHiddenName(leaf)) return `${leaf} is hidden`;
  if (size > ATTACHMENT_MAX_BYTES) return `${leaf} is over ${capWords}`;
  return null;
}
export function attachmentName(name: string): string {
  const safe = [...basename(name)]
    .map((c) =>
      c.codePointAt(0)! < 32 ||
      (c.codePointAt(0)! >= 127 && c.codePointAt(0)! <= 159) ||
      '<>:|?*#%"'.includes(c)
        ? '-'
        : c,
    )
    .join('')
    .trim();
  const dot = safe.lastIndexOf('.');
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : '';
  let prefix = '';
  let bytes = 0;
  for (const c of stem) {
    const cp = c.codePointAt(0)!;
    const length = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + length > 200) break;
    prefix += c;
    bytes += length;
  }
  return `${prefix || 'file'}${ext}`;
}
/** One root-anchored markdown path; names contain no URL metacharacters. */
export const attachmentLink = (path: string): string => `/${path.replace(/^\/+/, '')}`;
export function describeAttachments(
  results: readonly AttachmentImport[],
  skipped: readonly string[],
): string {
  const reused = results.filter((result) => result.reused).length;
  const added = results.length - reused;
  let line =
    added > 0
      ? `Added ${added} ${added === 1 ? 'file' : 'files'} to attachments/`
      : reused > 0
        ? `Reused ${reused} ${reused === 1 ? 'file' : 'files'} already in attachments/`
        : 'Nothing added';
  if (added > 0 && reused > 0) line += ` and reused ${reused} already there`;
  if (skipped.length > 0) line += ` — skipped: ${skipped.join('; ')}`;
  return line;
}
