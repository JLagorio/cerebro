import { useEffect, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import { readNote, saveNote } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { LazyMarkdownEditor } from './LazyMarkdownEditor';

/**
 * Loads a note's body, shows the rich editor, and persists debounced edits.
 * Every save rescans, so editing the H1 syncs the entry title everywhere
 * (scanner derives titles from the first H1 — that IS the title sync).
 */
export function NoteBodyEditor({
  path,
  autoFocus = false,
  debounceMs,
  onReady,
}: {
  path: string;
  autoFocus?: boolean;
  debounceMs?: number;
  onReady?: (info: { editor: BlockNoteEditor; lossyImport: boolean }) => void;
}) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [lossy, setLossy] = useState(false);

  useEffect(() => {
    setBody(null);
    setFailed(false);
    setLossy(false);
    if (vaultPath === null) return;
    let cancelled = false;
    readNote(vaultPath, path)
      .then((text) => {
        // Rust read_note returns the body verbatim including the blank line
        // after the frontmatter fence; the mock strips leading newlines —
        // normalize so both backends match (M1 note 10 discipline).
        if (!cancelled) setBody(text.replace(/^\n+/, ''));
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          toast("Couldn't load page");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, vaultPath, toast]);

  const save = (markdown: string) => {
    if (vaultPath === null) return;
    void (async () => {
      // Separate catches: after a successful save the disk already holds the
      // edit, so a refresh failure must not claim the save failed.
      try {
        await saveNote(vaultPath, path, markdown);
      } catch {
        toast("Couldn't save page");
        return;
      }
      try {
        await rescan();
      } catch {
        toast("Couldn't refresh vault");
      }
    })();
  };

  if (failed) {
    return (
      <p className="m-0 px-1 py-2 text-[13px] text-[var(--n-500)]">
        This page couldn't be loaded.
      </p>
    );
  }
  if (body === null) return <div data-testid="note-body-loading" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {lossy && (
        <div
          role="alert"
          className="mx-1 mb-2 rounded-lg border border-[var(--warn-500)] bg-[var(--warn-50)] px-3 py-2 text-[12.5px] text-[var(--warn-700)]"
        >
          Parts of this file (raw HTML) can't be shown in the rich editor and will be lost if
          you edit here.
        </div>
      )}
      <LazyMarkdownEditor
        key={path}
        markdown={body}
        onChange={save}
        onReady={(info) => {
          setLossy(info.lossyImport);
          onReady?.(info);
        }}
        autoFocus={autoFocus}
        debounceMs={debounceMs}
      />
    </div>
  );
}
