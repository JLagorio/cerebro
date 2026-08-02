import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { inboxEntries, ORGANIZED_KEY, type InboxPeriod } from '@/engine/inbox';
import { isAgentWritten, verifyPatch } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

export interface InboxQueue {
  entries: Entry[];
  selected: Entry | null;
  select(path: string): void;
  /** Mark organized, then open the next capture when auto-advance is on. */
  organize(path: string): Promise<void>;
  /** Send an organized note back to the queue (undo, or rework). */
  unorganize(path: string): Promise<void>;
}

/**
 * The Inbox queue (M4), after Tolaria's organize-and-advance loop: reviewing
 * captures is a rhythm, so organizing one immediately opens the next instead
 * of dropping you on an empty pane.
 *
 * PINNING. Inbox membership is derived (untyped ⇒ queued), which means the
 * moment you assign a type — the main thing organizing IS — the note stops
 * matching and would vanish from under the cursor before you finished adding
 * a status or a link. So a note you are actively working on is pinned into
 * the list until you explicitly finish it. The derived rule decides what
 * ENTERS the queue; only the organize action decides what leaves it.
 */
export function useInboxQueue(period: InboxPeriod): InboxQueue {
  const allEntries = useVaultStore((s) => s.entries);
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const autoAdvance = useUiStore((s) => s.inboxAutoAdvance);
  // Selection lives in the store, not in this hook: the agent proposes a
  // filing for a specific capture and has to be able to open it, which it
  // cannot do if the only way in is a click on a row.
  const selectedPath = useUiStore((s) => s.inboxSelectedPath);
  const setSelectedPath = useUiStore((s) => s.setInboxSelectedPath);
  const [pinned, setPinned] = useState<readonly string[]>([]);

  const queued = useMemo(() => inboxEntries(allEntries, period), [allEntries, period]);

  // Pinned notes that no longer match the filter, restored to their place in
  // the queue so the list does not reshuffle around the note being edited.
  const entries = useMemo(() => {
    if (pinned.length === 0) return queued;
    const present = new Set(queued.map((e) => e.path));
    const held = allEntries.filter((e) => pinned.includes(e.path) && !present.has(e.path));
    if (held.length === 0) return queued;
    return [...queued, ...held].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title),
    );
  }, [allEntries, pinned, queued]);

  // A selection that has just been organized (or deleted) falls back to the
  // head of the queue rather than blanking the pane.
  const selected = entries.find((e) => e.path === selectedPath) ?? entries[0] ?? null;

  // Pin whatever is on screen — including the head-of-queue fallback the
  // user never clicked, since that is the note the organize panel edits.
  const selectedResolvedPath = selected?.path ?? null;
  useEffect(() => {
    if (selectedResolvedPath === null) return;
    setPinned((prev) =>
      prev.includes(selectedResolvedPath) ? prev : [...prev, selectedResolvedPath],
    );
  }, [selectedResolvedPath]);

  // organize() reads these through a ref so the callback identity stays
  // stable — it is a keydown-handler dependency, and re-registering the
  // listener on every list change is how double-fires happen.
  const state = useRef({ entries, selectedPath: selectedResolvedPath, autoAdvance });
  state.current = { entries, selectedPath: selectedResolvedPath, autoAdvance };
  const allEntriesRef = useRef(allEntries);
  allEntriesRef.current = allEntries;

  const organize = useCallback(
    async (path: string) => {
      const current = state.current;
      // Compute the successor BEFORE the write: the moment `_organized`
      // lands the note leaves the list and its neighbours shift.
      const index = current.entries.findIndex((e) => e.path === path);
      const next =
        index < 0 ? null : (current.entries[index + 1] ?? current.entries[index - 1] ?? null);
      const wasOnScreen = current.selectedPath === path;

      setPinned((prev) => prev.filter((p) => p !== path));

      // M7: organizing an AI-written note is a REVIEW, so it records who
      // signed off. That is the whole loop — the agent writes, the note
      // lands unverified, and approving it is what earns the human stamp.
      const entry = allEntriesRef.current.find((e) => e.path === path);
      const patch: Record<string, unknown> = { [ORGANIZED_KEY]: true };
      if (entry !== undefined && isAgentWritten(entry)) {
        Object.assign(
          patch,
          verifyPatch(entry, `human:${useUiStore.getState().actorId}`, new Date().toISOString()),
        );
      }
      await patchFrontmatter(path, patch);

      // M8.6 — filing is the trigger the M8 plan named and never wired. It
      // hands the capture to the background distiller rather than distilling
      // here: this is a keyboard action that should end the moment the write
      // lands, and the base reading it is a separate, slower thing.
      useUiStore.getState().fileForLearning(path);

      // Only steer the selection when the note we organized was the one on
      // screen — organizing from a row while reading another must not yank
      // the reading pane away.
      if (current.autoAdvance && wasOnScreen) setSelectedPath(next?.path ?? null);
    },
    // setSelectedPath is the store's own setter and never changes identity,
    // so listing it keeps the dependency honest without destabilising the
    // callback that the ⌘E keydown handler is bound to.
    [patchFrontmatter, setSelectedPath],
  );

  const unorganize = useCallback(
    async (path: string) => {
      await patchFrontmatter(path, { [ORGANIZED_KEY]: false });
      setSelectedPath(path);
    },
    [patchFrontmatter, setSelectedPath],
  );

  return { entries, selected, select: setSelectedPath, organize, unorganize };
}
