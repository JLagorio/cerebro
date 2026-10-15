import { create } from 'zustand';
import {
  MAX_NOTE_CHARS,
  MAX_QUEUED_NOTES,
  capNotes,
  parseStoredNotes,
  type ReviewNote,
} from '@/engine/reviewNotes';
import { useUpNextStore } from '@/stores/upNextStore';

/** Where this viewer's review notes live (M58.5). */
export const REVIEW_NOTES_KEY = 'cerebro.reviewNotes';

/** What a note reads as: sent, waiting in Up next, or queued for the agent. */
export type NoteStatus = 'sent' | 'waiting' | 'queued';

/** A new note: everything but what the store stamps. */
export type NewNote = Omit<ReviewNote, 'id' | 'createdAt' | 'heldBy' | 'sentAt'>;

/** What storage holds, or null when it could not be read. */
function load(): ReviewNote[] | null {
  try {
    const raw = localStorage.getItem(REVIEW_NOTES_KEY);
    return raw === null ? [] : parseStoredNotes(JSON.parse(raw));
  } catch {
    return null;
  }
}

function save(notes: ReviewNote[]): void {
  try {
    localStorage.setItem(REVIEW_NOTES_KEY, JSON.stringify({ v: 1, notes }));
  } catch {
    // Storage blocked or full: the memory copy keeps working this session.
  }
}

/**
 * Sent when its prompt was dispatched; waiting while an Up next entry still
 * holds it; queued otherwise. Up next is memory-only (M57 Q24), so after a
 * reload, or once its entry is removed, a waiting note reads queued again.
 */
export function statusOf(note: ReviewNote): NoteStatus {
  if (note.sentAt !== undefined) return 'sent';
  if (note.heldBy !== undefined && useUpNextStore.getState().has(note.heldBy)) return 'waiting';
  return 'queued';
}

let noteSeq = 0;

interface ReviewNotesState {
  notes: ReviewNote[];
  /** The new note, or null when its text is empty or too long, or the
   * conversation already holds 30 unsent notes (Q16). */
  add(note: NewNote): ReviewNote | null;
  /** Replace a queued note's text; false when it is not queued or too long. */
  update(id: string, text: string): boolean;
  /** Drop a queued note. */
  remove(id: string): void;
  /** Mark `ids` as held by the Up next entry `entryId`. */
  hold(ids: readonly string[], entryId: string): void;
  /** Stamp `ids` sent at `at` (unix ms): the moment their prompt is
   * dispatched, never when it is queued (Q13). */
  markSent(ids: readonly string[], at: number): void;
  /** Drop every note of a deleted conversation. */
  prune(conversationId: string): void;
  /** Re-read storage, as a reload does; storage that cannot be read keeps
   * the memory copy. */
  rehydrate(): void;
}

/**
 * Review notes, per viewer (M58.5): kept in this device's storage under
 * `cerebro.reviewNotes` as `{v: 1, notes}`, keyed in each note by vault and
 * conversation, and never in the vault, git or runtime.db. Every storage read
 * and write is caught; the store's own copy is the memory one, so blocked
 * storage costs only persistence.
 */
export const useReviewNotesStore = create<ReviewNotesState>()((set, get) => {
  const put = (notes: ReviewNote[]) => {
    set({ notes });
    save(notes);
  };
  const unsentIn = (n: Pick<ReviewNote, 'vault' | 'conversationId'>) =>
    get().notes.filter(
      (m) => m.vault === n.vault && m.conversationId === n.conversationId && m.sentAt === undefined,
    ).length;
  return {
    notes: load() ?? [],
    add: (input) => {
      const text = input.text.trim();
      if (text === '' || text.length > MAX_NOTE_CHARS) return null;
      if (unsentIn(input) >= MAX_QUEUED_NOTES) return null;
      noteSeq += 1;
      const note: ReviewNote = {
        ...input,
        text,
        id: `rn-${Date.now().toString(36)}-${noteSeq}`,
        createdAt: Date.now(),
      };
      put([...get().notes, note]);
      return note;
    },
    update: (id, text) => {
      if (text.length > MAX_NOTE_CHARS) return false;
      const note = get().notes.find((n) => n.id === id);
      if (note === undefined || statusOf(note) !== 'queued') return false;
      put(get().notes.map((n) => (n.id === id ? { ...n, text } : n)));
      return true;
    },
    remove: (id) => {
      const note = get().notes.find((n) => n.id === id);
      if (note === undefined || statusOf(note) !== 'queued') return;
      put(get().notes.filter((n) => n.id !== id));
    },
    hold: (ids, entryId) => {
      const held = new Set(ids);
      put(
        get().notes.map((n) =>
          held.has(n.id) && n.sentAt === undefined ? { ...n, heldBy: entryId } : n,
        ),
      );
    },
    markSent: (ids, at) => {
      const sent = new Set(ids);
      const notes = get().notes.map((n) => {
        if (!sent.has(n.id) || n.sentAt !== undefined) return n;
        const { heldBy: _held, ...rest } = n;
        return { ...rest, sentAt: at };
      });
      put(capNotes(notes));
    },
    prune: (conversationId) => {
      const notes = get().notes;
      const kept = notes.filter((n) => n.conversationId !== conversationId);
      if (kept.length !== notes.length) put(kept);
    },
    rehydrate: () => {
      const notes = load();
      if (notes !== null) set({ notes });
    },
  };
});
