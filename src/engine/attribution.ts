import { actorLabel } from './authors';
import { OWNER } from './comments';
import { isKnowledgePath } from './okf';
import type { Entry } from './types';
import { relativeWhen } from './whenText';

/**
 * Who changed a page, and what a run wrote, in words (M58.1b).
 *
 * Rust's `runtime::write_log` reads the operational write log back (M58.1)
 * and answers in states; this module is the one place those states become
 * sentences. Pure: no DOM, no IPC.
 *
 * **"not recorded" and "unattributed" are different facts.** `actorLabel`
 * says "unattributed" for a NULL actor. Here a NULL actor is a write whose
 * writer was not recorded, and "unattributed" means something else: the page
 * changed outside Cerebro, after the last write anything recorded (CV-05).
 */

/** Who a person's writes are stamped as: vault/receipt.rs `HUMAN_ACTOR` (D1). */
export const HUMAN_ACTOR = 'human:me';

/** One recorded write, as a page's last change (`write_log::LastWrite`).
 *  `actor: null` is not recorded. */
export interface LastWrite {
  kind: string;
  actor: string | null;
  run_id: string | null;
  approved_by: string | null;
  at: string;
}

/** Who last changed one page (`write_log::Attribution`). */
export type PageAttribution =
  | ({ state: 'recorded' } & LastWrite)
  | ({ state: 'unattributed' } & LastWrite)
  | { state: 'not_recorded' }
  | { state: 'knowledge' };

/** One row a run wrote (`write_log::PageWrite`). `to` only for a rename. */
export interface PageWrite {
  kind: string;
  path: string;
  to: string | null;
  at: string;
  approved_by: string | null;
}

/** What one run wrote (`write_log::RunWrites`). `recorded` with no rows is
 *  measured: it wrote nothing. `partial` is booked, but the shell may have
 *  written elsewhere. */
export type RunPageWrites =
  | { state: 'recorded'; writes: PageWrite[] }
  | { state: 'partial'; writes: PageWrite[] }
  | { state: 'not_recorded' };

export const WROTE_NO_PAGES = 'Wrote no pages';
export const PAGES_NOT_RECORDED = 'Pages written: not recorded';
export const SHELL_NOT_RECORDED = 'Shell changes not recorded';

/** Who a write's actor names: "You" for your own — your page writes
 *  (`human:me`) and your comments (`human:owner`, M70) alike (D1, M58 Q5) —
 *  the app's noun for anyone else (`actorLabel`), and "not recorded" for a
 *  write nobody stamped. */
export function writerWords(actor: string | null, entries: Entry[]): string {
  if (actor === null) return 'not recorded';
  if (actor === HUMAN_ACTOR || actor === OWNER) return 'You';
  return actorLabel(actor, entries).text;
}

/** A page's last change, as the one line its Info tab reads. */
export function attributionLine(attribution: PageAttribution, entries: Entry[], now: Date): string {
  switch (attribution.state) {
    case 'recorded': {
      const who = writerWords(attribution.actor, entries);
      const allowed = attribution.approved_by !== null ? ' · you allowed it' : '';
      return `Last changed by ${who} · ${relativeWhen(attribution.at, now)}${allowed}`;
    }
    case 'unattributed': {
      const who = writerWords(attribution.actor, entries);
      return `Changed outside Cerebro since ${who} wrote it ${relativeWhen(attribution.at, now)} — unattributed`;
    }
    case 'not_recorded':
      return 'Who changed this page was not recorded';
    case 'knowledge':
      return 'Changed through Knowledge';
  }
}

/** The page a row leaves behind: a rename's destination, else its path. */
export const writtenPath = (write: PageWrite): string => write.to ?? write.path;

/**
 * The pages a run's rows name, one per page, in the order each was last
 * written; a moved page is named where it went. A comment changes no page, and a Knowledge page stays with the run
 * detail's own Knowledge section.
 */
export function pagesWritten(writes: PageWrite[]): PageWrite[] {
  const byPage = new Map<string, PageWrite>();
  for (const write of writes) {
    if (write.kind === 'vault.comment' || isKnowledgePath(writtenPath(write))) continue;
    // A moved page is listed where it went, once.
    if (write.kind === 'vault.rename') byPage.delete(write.path);
    byPage.delete(writtenPath(write));
    byPage.set(writtenPath(write), write);
  }
  return [...byPage.values()];
}

/** What a run's row did to its page, in a word or two. */
export function pageWriteWords(write: PageWrite): string {
  switch (write.kind) {
    case 'vault.create':
      return 'created';
    case 'vault.rename':
      return `moved from ${write.path}`;
    case 'vault.delete':
      return 'removed';
    default:
      return 'changed';
  }
}
