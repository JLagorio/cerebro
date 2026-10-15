import { CAPTURE_MAX_BYTES, captureExtensions, isCapturable } from '@/engine/fileKinds';
import { INBOX_DIR } from '@/engine/inbox';
import { filedCopyOf, toWorkingDoc } from '@/engine/ingest';
import { captureSlug } from '@/lib/capture';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The write half of ingest (M8.2).
 *
 * New material from outside lands the same way: an untyped note in `inbox/`
 * carrying where it came from. Untyped is deliberate — it is what queues the
 * note for filing, so material you dropped can never appear unreviewed in the
 * surfaces you author.
 *
 * Material the vault already holds lands nowhere (M64.7). Its `source_sha256`
 * matches a filed page, and the outcome names that page instead of writing a
 * numbered second copy.
 */

/** The extensions the Inbox captures as text: the kind table's `capture` rows (M66.1). */
export const INGESTIBLE_EXTENSIONS: readonly string[] = captureExtensions();

/** The largest file the Inbox captures: the kind table's `limits.capture_max_bytes`. */
export const MAX_INGEST_BYTES = CAPTURE_MAX_BYTES;

export function isIngestible(filename: string): boolean {
  return isCapturable(filename);
}

export interface IngestResult {
  /** Vault paths written, in the order the files were given. */
  paths: string[];
  /** Files already filed, each with the page that holds them; nothing was written. */
  duplicates: { filename: string; path: string; title: string }[];
  /** Files that were not written, each with the reason, for one summary toast. */
  skipped: { filename: string; reason: string }[];
}

/** What one piece of material became: a new capture, or the page already holding it. */
export type IngestOutcome =
  { kind: 'filed'; path: string } | { kind: 'duplicate'; path: string; title: string };

/** The pages one drop has filed so far, by `source_sha256`. */
export type SeenInDrop = Map<string, { path: string; title: string }>;

/** What the vault says while an open has not landed its entries yet. */
export const VAULT_STILL_OPENING = 'The vault is still opening. Try again in a moment.';

/**
 * File one piece of material into the Inbox, unless the vault already holds
 * it (M64.7).
 *
 * The repeat check reads `seen` first, the pages this same drop has filed,
 * then the store's entries. Those are read only while they are the open
 * vault's: during an open they are the last vault's, and a match there would
 * name a page this vault does not have, so the call throws instead. A
 * duplicate writes nothing.
 */
export async function ingestOne(
  filename: string,
  content: string,
  at: string = new Date().toISOString(),
  seen: SeenInDrop = new Map(),
): Promise<IngestOutcome> {
  const doc = toWorkingDoc({ filename, content, at });
  const sha = doc.frontmatter.source_sha256 as string;
  const earlier = seen.get(sha);
  if (earlier !== undefined) return { kind: 'duplicate', ...earlier };
  const store = useVaultStore.getState();
  if (store.entriesVault !== store.vaultPath) throw new Error(VAULT_STILL_OPENING);
  const copy = filedCopyOf(store.entries, sha);
  if (copy !== null) return { kind: 'duplicate', path: copy.path, title: copy.title };
  const path = await store.createItem({
    folder: INBOX_DIR,
    slug: captureSlug(doc.title),
    frontmatter: doc.frontmatter,
    body: doc.body,
  });
  seen.set(sha, { path, title: doc.title });
  return { kind: 'filed', path };
}

/**
 * Ingest dropped or chosen files.
 *
 * Unreadable files are collected rather than thrown: dropping six transcripts
 * and one PDF should file the six and say so, not fail the batch on the odd
 * one out.
 */
export async function ingestFiles(files: readonly File[]): Promise<IngestResult> {
  const result: IngestResult = { paths: [], duplicates: [], skipped: [] };
  // One map per drop, so the same file twice in one drop files once.
  const seen: SeenInDrop = new Map();
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
      const outcome = await ingestOne(file.name, content, undefined, seen);
      if (outcome.kind === 'filed') result.paths.push(outcome.path);
      else
        result.duplicates.push({ filename: file.name, path: outcome.path, title: outcome.title });
    } catch (err) {
      result.skipped.push({
        filename: file.name,
        reason: err instanceof Error ? err.message : 'could not be read',
      });
    }
  }
  return result;
}

/**
 * One-line summary of a batch, for a single toast: what filed, then each
 * file already filed by the title its page has now, then what was skipped.
 * "Nothing filed" leads only when nothing filed and nothing was a repeat.
 */
export function describeIngest(result: IngestResult): string {
  const filed = result.paths.length;
  const noun = filed === 1 ? 'note' : 'notes';
  const parts: string[] = [];
  if (filed > 0) parts.push(`Filed ${filed} ${noun} to the Inbox`);
  if (result.duplicates.length > 0) {
    parts.push(
      result.duplicates.map((d) => `${d.filename} is already filed as ${d.title}`).join('; '),
    );
  }
  if (parts.length === 0) parts.push('Nothing filed');
  if (result.skipped.length > 0) {
    const detail = result.skipped.map((s) => `${s.filename} (${s.reason})`).join(', ');
    parts.push(`skipped ${detail}`);
  }
  return parts.join(' — ');
}
