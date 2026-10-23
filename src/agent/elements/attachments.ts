import { chipId, type ContextChip } from '@/agent/contextChips';
import type { AttachmentData, AttachmentState } from '@/components/ai/Attachment';
import { VAULT_ROOT } from '@/engine/fileBytes';
import type { FileKind } from '@/engine/fileKinds';

/**
 * The files on the composer (M91.17), as the Attachment element draws them:
 * each file chip by its path in the vault, where a picture's thumbnail comes
 * from, then each file from outside the vault waiting to be copied in when
 * the message is sent — its name, its kind and where its copy stands. A file
 * whose copy failed keeps its reason in words. Pure.
 */

/** A file from outside the vault, as the composer shows it before its copy. */
export interface PendingView {
  /** Stable for its chip, and never a file chip's `file:` id. */
  id: string;
  /** The file's own name. */
  label: string;
  fileKind: FileKind;
  /** Waiting for the send, being copied in, or refused by the copy. */
  state: 'waiting' | 'copying' | 'failed';
  /** Why the copy failed, in the door's words. */
  reason?: string;
}

/** One chip, as the element takes it. */
export interface ComposerFile {
  data: AttachmentData;
  state: AttachmentState;
}

/** Each kind, in the words a chip's second line says it in. */
export const KIND_WORDS: Record<FileKind, string> = {
  archive: 'Archive',
  audio: 'Audio',
  binary: 'Binary file',
  code: 'Code',
  data: 'Data',
  design: 'Design file',
  diagram: 'Diagram',
  document: 'Document',
  executable: 'Program',
  font: 'Font',
  image: 'Image',
  markdown: 'Markdown',
  pdf: 'PDF',
  presentation: 'Presentation',
  spreadsheet: 'Spreadsheet',
  text: 'Text',
  unknown: 'File',
  video: 'Video',
  whiteboard: 'Whiteboard',
};

/** What a waiting or copying chip says under its name. */
export const FILE_WORDS = {
  waiting: 'copied in when you send',
  copying: 'Copying into attachments/…',
  failed: 'Not copied',
} as const;

/** Where each file's copy stands, as the element's states read. */
const STATES: Record<PendingView['state'], AttachmentState> = {
  waiting: 'idle',
  copying: 'uploading',
  failed: 'error',
};

function pendingLine(file: PendingView): string {
  if (file.state === 'copying') return FILE_WORDS.copying;
  if (file.state === 'failed') return file.reason ?? FILE_WORDS.failed;
  return `${KIND_WORDS[file.fileKind]} · ${FILE_WORDS.waiting}`;
}

/** The chips the composer draws: the attached files in the vault, in the
 *  order they were attached, then the ones waiting to be copied in. */
export function composerFiles(
  chips: readonly ContextChip[],
  pending: readonly PendingView[],
): ComposerFile[] {
  const attached: ComposerFile[] = chips.flatMap((chip) =>
    chip.kind === 'file'
      ? [
          {
            data: {
              id: chipId(chip),
              label: chip.label,
              path: chip.path,
              rootId: VAULT_ROOT,
              kind: chip.fileKind,
              description: KIND_WORDS[chip.fileKind],
            },
            state: 'done' as const,
          },
        ]
      : [],
  );
  const waiting = pending.map((file) => ({
    data: { id: file.id, label: file.label, kind: file.fileKind, description: pendingLine(file) },
    state: STATES[file.state],
  }));
  return [...attached, ...waiting];
}
