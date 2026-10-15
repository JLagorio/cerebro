/**
 * The composer's unsent text, per conversation (M57.6).
 *
 * The draft was panel state, so closing the assistant threw it away, and one
 * draft followed you from thread to thread. Now each thread keeps its own,
 * in localStorage under `cerebro.composerDrafts`, with a memory copy that
 * answers when storage cannot (private mode, a full quota): a draft is a
 * convenience for this viewer, and losing it to a storage failure must never
 * break typing. An empty draft is no draft.
 */

const KEY = 'cerebro.composerDrafts';

let memory: Record<string, string> | null = null;

function read(): Record<string, string> {
  if (memory !== null) return memory;
  let stored: Record<string, string> = {};
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      stored = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
        ),
      );
    }
  } catch {
    // Unreadable: start from nothing, and keep what is typed in memory.
  }
  memory = stored;
  return memory;
}

function write(next: Record<string, string>): void {
  memory = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the memory copy holds it for this session.
  }
}

/** The draft conversation `id` left, or ''. */
export function loadDraft(id: string): string {
  return read()[id] ?? '';
}

/** Keep `text` as conversation `id`'s draft; an empty one removes it. */
export function saveDraft(id: string, text: string): void {
  const current = read();
  if ((current[id] ?? '') === text) return;
  const next = { ...current };
  if (text === '') delete next[id];
  else next[id] = text;
  write(next);
}

/** Forget the drafts of every conversation not in `ids`. */
export function pruneDrafts(ids: readonly string[]): void {
  const current = read();
  const keep = new Set(ids);
  const stale = Object.keys(current).filter((id) => !keep.has(id));
  if (stale.length === 0) return;
  const next = { ...current };
  for (const id of stale) delete next[id];
  write(next);
}

/** Test seam: forget the memory copy, as a reload does. */
export function forgetDraftsInMemory(): void {
  memory = null;
}
