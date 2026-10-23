import type { TurnContext } from './useAgentChat';
import type { SkillNarrowing } from '@/engine/skills';

/**
 * Up next (M57.5): the messages a conversation holds for after its turn.
 *
 * Text sent while a turn runs used to be dropped (Enter did nothing). Now it
 * waits here, in run order, next first. An entry is typed text, a labelled
 * ask (a handoff: `useUpNext` takes one, though the panel opens each page's
 * ask in a conversation of its own), or review notes sent from the dock
 * (M58.5). It freezes what the person was looking at when they sent it (its
 * TurnContext, M17.6), its text and its skill, whose expansion starts at
 * enqueue; the Settings ceilings and the panel's binding are read when it
 * starts. Pure: no store, no React, no IPC.
 */

/** How many messages one conversation's Up next holds; the panel says so. */
export const UP_NEXT_CAP = 10;

/**
 * Steer stops the running turn and starts the steered entry by resuming the
 * same session (D4 (a): M53.10's TERM-then-KILL, then `--resume`). That holds
 * only while a stop mid-tool leaves a session Claude Code resumes cleanly:
 * the D4 record's fact F17 (`cli-stream/spike/kill-resume.json`), derived from
 * the 2.1.250 bundle until the owner's live run records it. upNextQueue.test pins
 * this flag to that recording; false hides Steer, and Up next still edits,
 * removes and runs in order (M57 Q25).
 */
export const STEER_BY_RESTART = true;

/** What a skill invocation resolves to (AiPanel's `resolveSkill`). */
export interface ResolvedText {
  skill: { path: string } | null;
  /** The skill's expansion, started at enqueue; absent for plain text. */
  expansion?: Promise<string>;
  narrowing: SkillNarrowing;
}

export interface UpNextEntry {
  id: string;
  /** What the bubble will say. */
  text: string;
  /** What the agent is sent, when it is not `text`: a page's labelled ask
   * (a handoff). Absent on a typed entry, the only kind that can be edited. */
  prompt?: string;
  /** The review notes this entry's prompt carries (M58.5): the person's
   * words, built from notes, so not typed and never edited here. They are
   * stamped sent when the entry is dispatched, never when it is queued. */
  notes?: { ids: readonly string[] };
  skill: { path: string } | null;
  expansion?: Promise<string>;
  narrowing: SkillNarrowing;
  /** The context the entry was sent in, frozen then. */
  turn: TurnContext;
  /** The vault it was queued in: a vault switch drops the others. */
  vault: string;
  queuedAt: number;
}

/** `queue` with `entry` last, or 'full' at the cap. */
export function enqueue(queue: UpNextEntry[], entry: UpNextEntry): UpNextEntry[] | 'full' {
  if (queue.length >= UP_NEXT_CAP) return 'full';
  return [...queue, entry];
}

/** Whether `entry` is one the person typed, the only kind that can be
 * edited: not a handoff (a `prompt`) and not review notes (M58.5). */
export function isTyped(entry: UpNextEntry): boolean {
  return entry.prompt === undefined && entry.notes === undefined;
}

/** `queue` with a typed entry's text, and what it resolves to, replaced; its
 * id and position kept. A handoff's entry (one with a `prompt`), a notes
 * entry, blank text or an id not queued leaves the same queue. */
export function edit(
  queue: UpNextEntry[],
  id: string,
  text: string,
  resolved: ResolvedText,
): UpNextEntry[] {
  const trimmed = text.trim();
  const at = queue.findIndex((e) => e.id === id);
  if (at === -1 || trimmed === '' || !isTyped(queue[at])) return queue;
  const { expansion: _old, ...kept } = queue[at];
  const next = queue.slice();
  next[at] = {
    ...kept,
    text: trimmed,
    skill: resolved.skill,
    narrowing: structuredClone(resolved.narrowing),
    ...(resolved.expansion === undefined ? {} : { expansion: resolved.expansion }),
  };
  return next;
}

/** `queue` without the entry `id`. */
export function remove(queue: UpNextEntry[], id: string): UpNextEntry[] {
  return queue.some((e) => e.id === id) ? queue.filter((e) => e.id !== id) : queue;
}

/** `queue` with the entry `id` first. The head, or an id not queued, leaves
 * the same queue. */
export function toFront(queue: UpNextEntry[], id: string): UpNextEntry[] {
  const at = queue.findIndex((e) => e.id === id);
  if (at <= 0) return queue;
  return [queue[at], ...queue.slice(0, at), ...queue.slice(at + 1)];
}

/** The next entry and the queue after it, or null when nothing waits. */
export function claimHead(
  queue: UpNextEntry[],
): { entry: UpNextEntry; rest: UpNextEntry[] } | null {
  if (queue.length === 0) return null;
  const [entry, ...rest] = queue;
  return { entry, rest };
}
