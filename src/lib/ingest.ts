import { INBOX_DIR } from '@/engine/inbox';
import { toWorkingDoc } from '@/engine/ingest';
import { captureSlug } from '@/lib/capture';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The write half of ingest (M8.2).
 *
 * Everything that comes in from outside lands the same way: an untyped note
 * in `inbox/` carrying where it came from. Untyped is deliberate — it is what
 * queues the note for filing, so material you dropped can never appear
 * unreviewed in the surfaces you author.
 */

/** Text formats we can read. Anything else is a file we would garble. */
export const INGESTIBLE_EXTENSIONS = ['md', 'markdown', 'txt', 'text', 'vtt', 'srt'] as const;

/** A transcript of a long meeting is big; a video of one is not text. */
export const MAX_INGEST_BYTES = 4 * 1024 * 1024;

export function isIngestible(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return false;
  return (INGESTIBLE_EXTENSIONS as readonly string[]).includes(
    filename.slice(dot + 1).toLowerCase(),
  );
}

export interface IngestResult {
  /** Vault paths written, in the order the files were given. */
  paths: string[];
  /** Files that were not written, each with the reason, for one summary toast. */
  skipped: { filename: string; reason: string }[];
}

/** Write one piece of material into the Inbox and return its path. */
export async function ingestOne(
  filename: string,
  content: string,
  at: string = new Date().toISOString(),
): Promise<string> {
  const doc = toWorkingDoc({ filename, content, at });
  return useVaultStore.getState().createItem({
    folder: INBOX_DIR,
    slug: captureSlug(doc.title),
    frontmatter: doc.frontmatter,
    body: doc.body,
  });
}

/**
 * Ingest dropped or chosen files.
 *
 * Unreadable files are collected rather than thrown: dropping six transcripts
 * and one PDF should file the six and say so, not fail the batch on the odd
 * one out.
 */
export async function ingestFiles(files: readonly File[]): Promise<IngestResult> {
  const result: IngestResult = { paths: [], skipped: [] };
  for (const file of files) {
    if (!isIngestible(file.name)) {
      result.skipped.push({ filename: file.name, reason: 'not a text file' });
      continue;
    }
    if (file.size > MAX_INGEST_BYTES) {
      result.skipped.push({ filename: file.name, reason: 'too large' });
      continue;
    }
    try {
      const content = await file.text();
      if (content.trim() === '') {
        result.skipped.push({ filename: file.name, reason: 'empty' });
        continue;
      }
      result.paths.push(await ingestOne(file.name, content));
    } catch (err) {
      result.skipped.push({
        filename: file.name,
        reason: err instanceof Error ? err.message : 'could not be read',
      });
    }
  }
  return result;
}

/** One-line summary of a batch, for a single toast. */
export function describeIngest(result: IngestResult): string {
  const filed = result.paths.length;
  const noun = filed === 1 ? 'note' : 'notes';
  const head = filed === 0 ? 'Nothing filed' : `Filed ${filed} ${noun} to the Inbox`;
  if (result.skipped.length === 0) return head;
  const detail = result.skipped.map((s) => `${s.filename} (${s.reason})`).join(', ');
  return `${head} — skipped ${detail}`;
}
