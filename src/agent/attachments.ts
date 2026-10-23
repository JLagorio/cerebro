import type { PendingView } from '@/agent/elements/attachments';
import { attachmentRefusal } from '@/engine/attachments';
import { KINDS, kindFor } from '@/engine/fileKinds';
import { droppedReason, type DroppedFile } from '@/engine/osDrop';
import { deleteNote, importAttachment, importAttachmentBytes, inspectDropped } from '@/lib/ipc';

/**
 * Files the person attaches to a conversation (M91.17), through the doors a
 * page's attachments use (CV-56). A file from outside the vault waits on the
 * composer, and the message's files are copied into attachments/ when it is
 * sent, one after another: `import_attachment` for a path the picker or a
 * drop gave, `import_attachment_bytes` for a browser's File, each bounded by
 * the shared file-kind cap, which is checked here first so a file over it
 * never waits. The Undo of a send's copies moves the new ones to the vault's
 * Trash (CV-37). Nothing here throws (CV-03): each step returns what it
 * could not do, in words, for its caller to say.
 */

/** A file from outside the vault: a path the native picker or a drop gave,
 * or a File from the browser's picker or a paste. */
export type FileSource = string | File;

/** A file waiting on the composer to be copied in. */
export interface PendingFile extends PendingView {
  source: FileSource;
}

/** What a send's copy made of one file: its vault path, and whether the
 * vault already held the same bytes there. */
export interface CopiedFile {
  id: string;
  path: string;
  reused: boolean;
}

/** How a send's copies went: all of them, or the first that failed (the
 * rest were not tried), or none past the point the conversation or the
 * vault changed. */
export type CopyOutcome =
  | { kind: 'copied'; copied: CopiedFile[] }
  | { kind: 'failed'; copied: CopiedFile[]; failed: { id: string; reason: string } }
  | { kind: 'stale'; copied: CopiedFile[] };

let pendingSeq = 0;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const nameOf = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;

function waiting(label: string, source: FileSource): PendingFile {
  pendingSeq += 1;
  return {
    id: `pending:${pendingSeq}`,
    label,
    fileKind: kindFor(label).kind,
    state: 'waiting',
    source,
  };
}

/**
 * The files `sources` names, ready to wait on the composer, in the order
 * given, and each one refused with why: a folder, a hidden file, one that
 * can't be read or one over the cap. A path is looked at once, through the
 * drop door's inspection; a read that fails refuses every path in words, as
 * does one that leaves a path unanswered.
 */
export async function pendingFrom(
  sources: readonly FileSource[],
): Promise<{ files: PendingFile[]; skipped: string[] }> {
  const paths = sources.filter((source): source is string => typeof source === 'string');
  const files: PendingFile[] = [];
  const skipped: string[] = [];
  let inspected: Map<string, DroppedFile> | null;
  try {
    inspected = new Map(
      paths.length === 0 ? [] : (await inspectDropped(paths)).map((file) => [file.path, file]),
    );
  } catch (error) {
    inspected = null;
    for (const path of paths) skipped.push(`${nameOf(path)} (${reasonOf(error)})`);
  }
  for (const source of sources) {
    if (typeof source !== 'string') {
      const refusal = attachmentRefusal(source.name, source.size);
      if (refusal === null) files.push(waiting(source.name, source));
      else skipped.push(refusal);
      continue;
    }
    if (inspected === null) continue;
    const file = inspected.get(source);
    // A path the inspection did not answer for is named, never dropped
    // without a word.
    if (file === undefined) {
      skipped.push(`${nameOf(source)} (could not be read)`);
      continue;
    }
    const why = droppedReason(file);
    if (why !== null) {
      skipped.push(`${file.name} (${why})`);
      continue;
    }
    const refusal = attachmentRefusal(file.name, file.size ?? 0);
    if (refusal === null) files.push(waiting(file.name, source));
    else skipped.push(refusal);
  }
  return { files, skipped };
}

/** Whether two waiting files come from the same place: one path, or one
 *  File the browser handed over twice. */
export function sameSource(a: PendingFile, b: PendingFile): boolean {
  return a.source === b.source;
}

async function base64Of(file: File): Promise<string> {
  const buffer =
    typeof file.arrayBuffer === 'function'
      ? await file.arrayBuffer()
      : await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(new Error(`${file.name} could not be read`));
          reader.readAsArrayBuffer(file);
        });
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

/**
 * Copy `files` into the vault's attachments/, in order, through the human
 * doors. The first refusal ends the batch, so a message is never sent with
 * a file that is not there; `current` is asked before each copy and after
 * the last, so nothing is copied for a conversation or a vault the person
 * has left.
 */
export async function copyIn(
  vault: string,
  files: readonly PendingFile[],
  current: () => boolean,
): Promise<CopyOutcome> {
  const copied: CopiedFile[] = [];
  for (const file of files) {
    if (!current()) return { kind: 'stale', copied };
    try {
      const result =
        typeof file.source === 'string'
          ? await importAttachment(vault, file.source)
          : await importAttachmentBytes(vault, file.label, await base64Of(file.source));
      copied.push({ id: file.id, path: result.path, reused: result.reused });
    } catch (error) {
      return { kind: 'failed', copied, failed: { id: file.id, reason: reasonOf(error) } };
    }
  }
  return current() ? { kind: 'copied', copied } : { kind: 'stale', copied };
}

/**
 * Undo a send's copies: move each new one to the vault's Trash, where
 * Settings can restore it (CV-37). A copy that only reused bytes already in
 * the vault predates the send, so it is never passed here. Returns the paths
 * moved, and the first refusal in words.
 */
export async function discardCopies(
  vault: string,
  paths: readonly string[],
): Promise<{ moved: string[]; failed: string | null }> {
  const moved: string[] = [];
  let failed: string | null = null;
  for (const path of paths) {
    try {
      await deleteNote(vault, path);
      moved.push(path);
    } catch (error) {
      failed ??= `${nameOf(path)} stayed: ${reasonOf(error)}`;
    }
  }
  return { moved, failed };
}

/**
 * The files a paste into the composer carries — unless it carries text to
 * paste. Rich editor content, or HTML with words in it, pastes as text, as a
 * page's editor reads a paste (M66.6); a screenshot or a copied file pastes
 * as a file. A pasted file with no name is named for its MIME.
 */
export function pastedFiles(data: DataTransfer | null): File[] {
  if (
    data === null ||
    data.files.length === 0 ||
    data.types.includes('blocknote/html') ||
    data.types.includes('vscode-editor-data')
  ) {
    return [];
  }
  const html = data.getData('text/html');
  if (html !== '' && new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim()) {
    return [];
  }
  return Array.from(data.files).map((file) => {
    if (file.name.trim() !== '') return file;
    const ext = KINDS.kinds.find((row) => row.mime === file.type)?.ext ?? 'bin';
    return new File([file], `pasted.${ext}`, { type: file.type });
  });
}
