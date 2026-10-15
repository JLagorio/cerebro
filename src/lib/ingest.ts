import { ingestDocument, type DocumentSource } from './documentIngest';
import { CAPTURE_MAX_BYTES, IMPORT_MAX_BYTES, KINDS, kindFor, extOf } from '@/engine/fileKinds';
import { inletFor, type ImportInput } from '@/engine/inlets';
import { INBOX_DIR } from '@/engine/inbox';
import { filedCopyOf, toWorkingDoc } from '@/engine/ingest';
import { captureSlug } from '@/lib/capture';
import { useVaultStore } from '@/stores/vaultStore';
import { droppedReason, droppedTextReason } from '@/engine/osDrop';
import { inspectDropped, readDroppedText } from './ipc';

/**
 * The write half of ingest (M8.2).
 *
 * New material from outside lands the same way: an untyped note in `inbox/`
 * carrying where it came from. Untyped is deliberate — it is what queues the
 * note for filing, so material you dropped can never appear unreviewed in the
 * surfaces you author.
 *
 * Documents keep their original in attachments/ and file a stamped capture,
 * including an explicit outcome when text cannot be extracted.
 *
 * Material the vault already holds lands nowhere (M64.7). Its `source_sha256`
 * matches a filed page, and the outcome names that page instead of writing a
 * numbered second copy.
 */

// Captures write notes; local imports open a preview before any write.
export const INGESTIBLE_EXTENSIONS: readonly string[] = KINDS.kinds
  .filter((row) => row.ingest === 'capture' || row.ingest === 'import' || row.ingest === 'extract')
  .map((row) => row.ext);

/** The largest file the Inbox captures: the kind table's `limits.capture_max_bytes`. */
export const MAX_INGEST_BYTES = CAPTURE_MAX_BYTES;

const noReader = (name: string) =>
  extOf(name) === null ? 'no reader for this file' : `no reader for .${extOf(name)} files`;

export function isIngestible(filename: string): boolean {
  return ['capture', 'import', 'extract'].includes(kindFor(filename).ingest);
}

export interface IngestResult {
  /** Failed or partial document extraction, after the kept original was filed. */
  notes?: { filename: string; reason: string }[];
  /** Local files claimed by a preview; no pages written yet. */
  imports?: number;
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
 * and one ZIP should file the six and say so, not fail the batch on the odd
 * one out.
 */
export type ClaimImport = (input: ImportInput) => boolean;
function takeImport(
  name: string,
  content: string,
  result: IngestResult,
  claim?: ClaimImport,
): boolean {
  if (kindFor(name).ingest !== 'import') return false;
  const kind = inletFor(name, content);
  if (kind && claim?.({ kind, name, content })) result.imports = (result.imports ?? 0) + 1;
  else
    result.skipped.push({
      filename: name,
      reason: kind ? 'open this file from the Inbox to preview it' : 'not a calendar file',
    });
  return true;
}
async function ingestTextFiles(
  files: readonly File[],
  current: () => boolean = () => true,
  claim?: ClaimImport,
  seen: SeenInDrop = new Map(),
): Promise<IngestResult> {
  const result: IngestResult = { paths: [], duplicates: [], skipped: [] };
  // One map per drop, so the same file twice in one drop files once.
  for (const file of files) {
    if (!current()) break;
    if (!isIngestible(file.name)) {
      result.skipped.push({ filename: file.name, reason: noReader(file.name) });
      continue;
    }
    if (
      file.size > (kindFor(file.name).ingest === 'import' ? IMPORT_MAX_BYTES : MAX_INGEST_BYTES)
    ) {
      result.skipped.push({ filename: file.name, reason: 'too large' });
      continue;
    }
    try {
      let content: string;
      if (kindFor(file.name).ingest === 'import') {
        const bytes = await file.arrayBuffer();
        if (!current()) break;
        if (bytes.byteLength > IMPORT_MAX_BYTES) throw new Error('too large');
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new Error('not valid UTF-8 text');
        }
      } else content = await file.text();
      if (!current()) break;
      if (takeImport(file.name, content, result, claim)) continue;
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

/** The native drop route: use names as provenance, never outside paths.
 * The caller's lifetime guard prevents a delayed read writing another vault. */
async function ingestTextDropped(
  paths: readonly string[],
  current: () => boolean,
  claim?: ClaimImport,
  seen: SeenInDrop = new Map(),
): Promise<IngestResult> {
  const result: IngestResult = { paths: [], duplicates: [], skipped: [] };
  const files = await inspectDropped(paths);
  for (const file of files) {
    if (!current()) break;
    const limit = kindFor(file.name).ingest === 'import' ? IMPORT_MAX_BYTES : MAX_INGEST_BYTES;
    const why =
      droppedReason(file) ??
      (!isIngestible(file.name)
        ? noReader(file.name)
        : file.size !== null && file.size > limit
          ? 'too large'
          : null);
    if (why !== null) {
      result.skipped.push({ filename: file.name, reason: why });
      continue;
    }
    try {
      const read = await readDroppedText(file.path);
      if (!current()) break;
      if (read.kind !== 'text') {
        result.skipped.push({ filename: file.name, reason: droppedTextReason(read) });
        continue;
      }
      if (takeImport(file.name, read.content, result, claim)) continue;
      if (read.content.trim() === '') {
        result.skipped.push({ filename: file.name, reason: 'empty' });
        continue;
      }
      const outcome = await ingestOne(file.name, read.content, undefined, seen);
      if (outcome.kind === 'filed') result.paths.push(outcome.path);
      else
        result.duplicates.push({ filename: file.name, path: outcome.path, title: outcome.title });
    } catch (error) {
      result.skipped.push({
        filename: file.name,
        reason: error instanceof Error ? error.message : 'could not be read',
      });
    }
  }
  return result;
}

/** The picker and native drop both use the same routing; structured imports
 * still only claim a preview, and documents keep their original first. */
export async function ingestFiles(
  sources: readonly DocumentSource[],
  current: () => boolean = () => true,
  claim?: ClaimImport,
): Promise<IngestResult> {
  const result: IngestResult = { paths: [], duplicates: [], skipped: [] };
  const vault = useVaultStore.getState().vaultPath;
  let retired = false;
  const unsubscribe = useVaultStore.subscribe((state) => {
    if (state.vaultPath !== vault) retired = true;
  });
  const active = () => !retired && current() && useVaultStore.getState().vaultPath === vault;
  const seen: SeenInDrop = new Map();
  try {
    for (const source of sources) {
      if (!active()) break;
      try {
        if (kindFor(source.name).ingest === 'extract') {
          const read = await ingestDocument(source, active, seen);
          if (!active() || read === null) break;
          if (read.outcome.kind === 'filed') result.paths.push(read.outcome.path);
          else
            result.duplicates.push({
              filename: source.name,
              path: read.outcome.path,
              title: read.outcome.title,
            });
          if (read.note !== null)
            (result.notes ??= []).push({ filename: source.name, reason: read.note });
          continue;
        }
        const one =
          'path' in source
            ? await ingestTextDropped([source.path], active, claim, seen)
            : await ingestTextFiles([source], active, claim, seen);
        if (!active()) break;
        result.paths.push(...one.paths);
        result.duplicates.push(...one.duplicates);
        result.skipped.push(...one.skipped);
        if (one.imports) result.imports = (result.imports ?? 0) + one.imports;
      } catch (error) {
        if (!active()) break;
        result.skipped.push({
          filename: source.name,
          reason: error instanceof Error ? error.message : 'could not be read',
        });
      }
    }
    // Completed writes remain in the old vault; their navigation and toast
    // result must not be published into a later visit.
    return active() ? result : { paths: [], duplicates: [], skipped: [] };
  } finally {
    unsubscribe();
  }
}
export function ingestDropped(
  paths: readonly string[],
  current: () => boolean,
  claim?: ClaimImport,
): Promise<IngestResult> {
  return ingestFiles(
    paths.map((path) => ({ path, name: path.split(/[\\/]/).at(-1) ?? path })),
    current,
    claim,
  );
}
export function documentCount(files: readonly { name: string }[]): number {
  return files.filter((file) => kindFor(file.name).ingest === 'extract').length;
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
  if (result.imports)
    parts.push(`Opened ${result.imports} import ${result.imports === 1 ? 'preview' : 'previews'}`);
  if (parts.length === 0) parts.push('Nothing filed');
  if (result.skipped.length > 0) {
    const detail = result.skipped.map((s) => `${s.filename} (${s.reason})`).join(', ');
    parts.push(`skipped ${detail}`);
  }
  if (result.notes?.length)
    parts.push(result.notes.map((note) => `${note.filename}: ${note.reason}`).join('; '));
  return parts.join(' — ');
}
