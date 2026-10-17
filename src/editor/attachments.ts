import { closeHistory } from 'prosemirror-history';
import {
  attachmentLink,
  attachmentRefusal,
  describeAttachments,
  type AttachmentImport,
} from '@/engine/attachments';
import { KINDS } from '@/engine/fileKinds';
import { mediaKindOf } from '@/engine/pageMedia';
import { importAttachment, importAttachmentBytes } from '@/lib/ipc';
import { fileUrl } from '@/lib/rootsIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { resolveImagePath } from '@/workspace/docLinks';
import type { CerebroEditor } from './MarkdownEditor';

export type AttachmentSource = string | File;
export interface AttachmentAnchor {
  id: string;
  replace?: boolean;
  /** Exact placeholder at the time the picker opened. */
  expected?: string;
}
export interface AttachmentBatch {
  results: AttachmentImport[];
  skipped: string[];
}

/** Rich editor/IDE content and text-bearing HTML keep their own paste chain. */
export function pastedFiles(data: DataTransfer | null): File[] {
  if (
    data === null ||
    data.types.includes('blocknote/html') ||
    data.types.includes('vscode-editor-data')
  )
    return [];
  const html = data.getData('text/html');
  if (html && new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim())
    return [];
  return Array.from(data.files).map((file) => {
    if (file.name.trim()) return file;
    const ext = KINDS.kinds.find((row) => row.mime === file.type)?.ext ?? 'bin';
    return new File([file], `pasted.${ext}`, { type: file.type });
  });
}

async function base64(file: File): Promise<string> {
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
  for (let start = 0; start < bytes.length; start += 8192)
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}

/** Sequential for selection order. Guard again after a browser reads its bytes. */
export async function importSources(
  vault: string,
  sources: readonly AttachmentSource[],
  current: () => boolean,
): Promise<AttachmentBatch> {
  const results: AttachmentImport[] = [];
  const skipped: string[] = [];
  for (const source of sources) {
    if (!current()) break;
    try {
      if (typeof source === 'string') results.push(await importAttachment(vault, source));
      else {
        const refusal = attachmentRefusal(source.name, source.size);
        if (refusal !== null) {
          skipped.push(refusal);
          continue;
        }
        const encoded = await base64(source);
        if (!current()) break;
        results.push(await importAttachmentBytes(vault, source.name, encoded));
      }
    } catch (error) {
      skipped.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { results, skipped };
}

/** Capture a block identity before a picker or copy moves focus. */
export function anchorAt(
  editor: CerebroEditor,
  host: HTMLElement | null,
  point?: { x: number; y: number },
): AttachmentAnchor | null {
  if (point !== undefined && host !== null) {
    const element = document.elementFromPoint(point.x, point.y);
    const block = element?.closest<HTMLElement>('.bn-block-outer[data-id]');
    if (
      block !== null &&
      block !== undefined &&
      host.contains(block) &&
      block.dataset.id !== undefined
    )
      return { id: block.dataset.id };
    const last = editor.document.at(-1);
    return last === undefined ? null : { id: last.id };
  }
  try {
    return { id: editor.getTextCursorPosition().block.id };
  } catch {
    const last = editor.document.at(-1);
    return last === undefined ? null : { id: last.id };
  }
}

/** Copying is outside history; one undo removes exactly the placed batch. */
export function placeBlocks(
  editor: CerebroEditor,
  anchor: AttachmentAnchor | null,
  results: readonly AttachmentImport[],
): boolean {
  if (anchor === null || results.length === 0 || editor.getBlock(anchor.id) === undefined)
    return false;
  if (anchor.replace && JSON.stringify(editor.getBlock(anchor.id)) !== anchor.expected)
    return false;
  const blocks = results.map(({ path }) => ({
    type: mediaKindOf(path),
    props: {
      url: attachmentLink(path),
      name: mediaKindOf(path) === 'image' ? '' : (path.split('/').at(-1) ?? ''),
    },
  }));
  editor.transact((tr) => {
    closeHistory(tr);
    if (anchor.replace) editor.replaceBlocks([anchor.id], blocks);
    else editor.insertBlocks(blocks, anchor.id, 'after');
  });
  editor.transact((tr) => {
    closeHistory(tr);
  });
  return true;
}

export async function addAttachments(options: {
  editor: CerebroEditor;
  sources: readonly AttachmentSource[];
  anchor: AttachmentAnchor | null;
  current: () => boolean;
  readOnly: () => boolean;
}): Promise<void> {
  const toast = useUiStore.getState().toast;
  if (options.sources.length === 0) return;
  if (options.readOnly()) {
    toast('This page is read-only — nothing was added');
    return;
  }
  const state = useVaultStore.getState();
  if (
    state.vaultPath === null ||
    (state.entriesVault !== null && state.entriesVault !== state.vaultPath)
  ) {
    toast('Nothing added — the vault is still opening');
    return;
  }
  const current = () => {
    const fresh = useVaultStore.getState();
    return (
      options.current() &&
      !options.readOnly() &&
      fresh.vaultPath === state.vaultPath &&
      (fresh.entriesVault === null || fresh.entriesVault === state.vaultPath)
    );
  };
  if (!current()) {
    toast('Nothing added. The page closed first, so nothing was placed.');
    return;
  }
  const batch = await importSources(state.vaultPath, options.sources, current);
  let placed = false;
  if (current()) {
    try {
      placed =
        batch.results.length === 0 || placeBlocks(options.editor, options.anchor, batch.results);
    } catch {
      /* Copies stay recorded even if the editor changed before placement. */
    }
  }
  const line = describeAttachments(batch.results, batch.skipped);
  toast(
    placed
      ? line
      : current()
        ? `${line}. The insertion point changed, so nothing was placed.`
        : `${line}. The page closed first, so nothing was placed.`,
  );
}

export async function resolveAttachmentUrl(url: string, notePath: string | null): Promise<string> {
  if (/^(?:https?:\/\/|data:)/i.test(url)) return url;
  const path = resolveImagePath(notePath ?? '', url);
  if (path === null) return '';
  try {
    const result = await fileUrl('0', path);
    return typeof result === 'string' ? result : '';
  } catch {
    return '';
  }
}
