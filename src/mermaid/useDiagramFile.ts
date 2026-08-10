import { useEffect, useRef, useState } from 'react';
import type { SaveState } from '@/editor/NoteBodyEditor';
import { readNote, saveNote } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** How long a pause in editing waits before the source flushes to disk. */
const SAVE_DEBOUNCE_MS = 500;

export interface DiagramFile {
  /** null while loading; hosts only mount editors on real content. */
  code: string | null;
  /** The read failed — renamed, trashed, or unreadable. The tombstone signal. */
  loadFailed: boolean;
  saveState: SaveState;
  /** The one write channel: every edit — typed or structural — goes through here. */
  handleChange: (next: string) => void;
}

/**
 * A `.mmd` file's whole editing lifecycle (M29.46): read-once, debounce-save,
 * survive-unmount. Extracted verbatim from DiagramPage (M29.21) so the
 * whiteboard view (M29.46) edits its canvas with the identical discipline.
 *
 * THE KEYED-MOUNT CONTRACT (M29.23) TRAVELS WITH THIS HOOK: the component
 * calling it MUST be mounted `key={path}` by its host, so a path change is a
 * true unmount. The pending-debounce flush runs as an unmount cleanup, and
 * only a true unmount guarantees that cleanup still belongs to the file it
 * was editing — an unkeyed path change re-points `handleChange`'s refs at
 * the new file FIRST and then runs the old cleanup, which writes the old
 * file's bytes into the new one and drops the pending edit. App.tsx keys
 * DiagramPage; WhiteboardView keys its canvas subtree. Do not call this from
 * a component whose host does not key it.
 *
 * Content is RAW end-to-end: readNote/saveNote pass `.mmd` bytes through
 * verbatim, so mermaid's own `---` config header survives every save. No
 * external live-reload (DocPage's M17.4 reconcile problem, consciously
 * deferred): the file is read once per mount, and an outside edit wins or
 * loses on last-write like any plain editor.
 */
export function useDiagramFile(path: string): DiagramFile {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);

  const [code, setCode] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // Only a FAILED READ sets this: the file is the truth in a files-first app,
  // so a path the scanner has not adopted yet still opens (a just-created
  // .mmd edits fine pre-rescan), and only "nothing readable here" is gone.
  const [loadFailed, setLoadFailed] = useState(false);

  // The save pipeline lives in refs so the debounce and the unmount flush
  // always see the newest source without re-arming effects per keystroke.
  const latest = useRef('');
  const timer = useRef<number | null>(null);
  const saving = useRef(false);
  const queued = useRef(false);

  const flushRef = useRef<() => Promise<void>>(async () => {});
  flushRef.current = async () => {
    if (vaultPath === null) return;
    if (saving.current) {
      // A save is already on the wire; run again with the newer bytes when
      // it lands rather than racing two writes to the same file.
      queued.current = true;
      return;
    }
    saving.current = true;
    setSaveState('saving');
    try {
      await saveNote(vaultPath, path, latest.current);
      saving.current = false;
      if (queued.current) {
        queued.current = false;
        await flushRef.current();
      } else {
        setSaveState('saved');
      }
    } catch {
      saving.current = false;
      queued.current = false;
      setSaveState('failed');
      toast("Couldn't save diagram");
    }
  };

  const handleChange = (next: string) => {
    latest.current = next;
    setCode(next);
    setSaveState('dirty');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void flushRef.current();
    }, SAVE_DEBOUNCE_MS);
  };

  // Load once per mount (the host's key makes a path change a fresh mount).
  useEffect(() => {
    let cancelled = false;
    setCode(null);
    setSaveState('idle');
    setLoadFailed(false);
    if (vaultPath === null) return;
    void readNote(vaultPath, path)
      .then((raw) => {
        if (cancelled) return;
        latest.current = raw;
        setCode(raw);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultPath, path]);

  // A pending debounce must not die with the host: flush it on unmount. This
  // is only safe BECAUSE the host keys the caller on the path — a path change
  // is a real unmount, so the flushRef this cleanup reads was last assigned
  // by the dying instance and still closes over ITS path and bytes. (Without
  // the key, the new path's render reassigned flushRef before this ran.)
  useEffect(() => {
    return () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
        void flushRef.current();
      }
    };
  }, []);

  return { code, loadFailed, saveState, handleChange };
}
