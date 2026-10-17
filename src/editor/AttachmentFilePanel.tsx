import { createContext, useContext, useRef, useState } from 'react';
import { FilePanel, useBlockNoteEditor, type FilePanelProps } from '@blocknote/react';
import { filenameFromURL } from '@blocknote/core';
import { FilePanelExtension } from '@blocknote/core/extensions';
import { pickFiles } from '@/lib/ipc';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useUiStore } from '@/stores/uiStore';
import { capWords } from '@/engine/attachments';
import type { AttachmentAnchor, AttachmentSource } from './attachments';
import type { CerebroEditor } from './MarkdownEditor';

export const AttachmentUploadContext = createContext<
  (anchor: AttachmentAnchor) => (sources: readonly AttachmentSource[]) => Promise<void>
>(() => async () => {});

/** Keeps upload under the page's receipt/placement door, never BlockNote's uploader. */
export function AttachmentFilePanel({ blockId }: FilePanelProps) {
  const editor = useBlockNoteEditor() as CerebroEditor;
  const prepare = useContext(AttachmentUploadContext);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<((sources: readonly AttachmentSource[]) => Promise<void>) | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const close = () => editor.getExtension(FilePanelExtension)?.closeMenu();
  const upload = async () => {
    const accept = prepare({ id: blockId, replace: true });
    if (!('__TAURI_INTERNALS__' in window)) {
      pending.current = accept;
      input.current?.click();
      return;
    }
    setBusy(true);
    try {
      const paths = await pickFiles();
      close();
      await accept(paths);
    } catch (error) {
      useUiStore.getState().toast(`Couldn't choose files — ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  const embed = () => {
    if (!editor.isEditable || !url.trim() || editor.getBlock(blockId) === undefined) return;
    const source = url.trim();
    editor.updateBlock(blockId, { props: { url: source, name: filenameFromURL(source) } });
    close();
  };
  return (
    <FilePanel
      blockId={blockId}
      tabs={[
        {
          name: 'Upload',
          tabPanel: (
            <div className="bn-tab-panel flex flex-col gap-3 p-3">
              <Button
                icon="upload"
                disabled={busy}
                onClick={() => {
                  void upload();
                }}
              >
                Choose files
              </Button>
              <input
                ref={input}
                data-testid="attachment-upload-input"
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  const accept = pending.current ?? prepare({ id: blockId, replace: true });
                  pending.current = null;
                  close();
                  void accept(files);
                }}
              />
              <p className="text-xs text-muted">Copied into attachments/ · up to {capWords}</p>
            </div>
          ),
        },
        {
          name: 'Embed',
          tabPanel: (
            <div className="bn-tab-panel flex flex-col gap-3 p-3">
              <Input
                ariaLabel="File URL"
                placeholder="Paste a link"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    embed();
                  }
                }}
              />
              <Button onClick={embed}>Embed</Button>
            </div>
          ),
        },
      ]}
    />
  );
}
