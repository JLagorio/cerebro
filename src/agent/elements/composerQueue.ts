import { STEER_BY_RESTART, isTyped, type UpNextEntry } from '@/agent/upNextQueue';

/**
 * Up next's rows (M57.5, M91.12a), for its Queue: what each entry offers
 * beside its line, and whether it is starting or being edited. Pure.
 */

/** What an entry's row offers, in the order it shows them. */
export type UpNextAction = 'steer' | 'run-now' | 'edit' | 'remove';

/** What a steered entry says while its turn starts. */
export const UP_NEXT_STARTING = 'Starting…';

/** What a row reads of its Up next: `useUpNext`'s answer, or a test's. */
export interface UpNextRowState {
  held: boolean;
  /** The entry being started, by Steer or Run now. */
  steering: string | null;
  /** The entry whose editor is open. */
  editing: string | null;
  /** A turn is in flight, stopping, or waiting on a card. */
  busy: boolean;
}

export interface UpNextRow {
  /** Steered: its turn is starting, and it offers nothing more. */
  starting: boolean;
  /** Its editor is open in place of its text, and it offers nothing until
   *  the editor closes. Only a typed entry has one. */
  editing: boolean;
  actions: UpNextAction[];
}

/**
 * An entry's row. Steer stops the running turn and starts the entry next,
 * only while a stop leaves a session Claude Code resumes (`STEER_BY_RESTART`)
 * and nothing else is starting; Run now starts it while Up next is on hold
 * and nothing runs; only a typed entry can be edited (a page's ask and
 * review notes cannot); any entry can be removed.
 */
export function upNextRow(
  entry: UpNextEntry,
  { held, steering, editing, busy }: UpNextRowState,
  steerByRestart: boolean = STEER_BY_RESTART,
): UpNextRow {
  const typed = isTyped(entry);
  const starting = steering === entry.id;
  const row = { starting, editing: editing === entry.id && typed };
  if (starting || editing === entry.id) return { ...row, actions: [] };
  const actions: UpNextAction[] = [];
  if (busy && steerByRestart && steering === null) actions.push('steer');
  if (held && !busy) actions.push('run-now');
  if (typed) actions.push('edit');
  actions.push('remove');
  return { ...row, actions };
}
