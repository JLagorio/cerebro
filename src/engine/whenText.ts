/**
 * Times, said in words (M33b.3).
 *
 * Two formatters, extracted here because two surfaces now need them and a
 * second copy of "how do we write a time" is how two screens end up
 * disagreeing about the same moment.
 *
 * **Neither one invents a time it was not given.** An absent timestamp is not
 * this module's problem — a caller with nothing to format says "never ran" in
 * its own words, because an epoch, a dash or an empty string would all read as
 * a measurement. What arrives here is a real stamp; what leaves is that stamp
 * in a form somebody can read.
 */

/**
 * A wall-clock stamp, in the timezone the reader is in.
 *
 * LOCAL, deliberately, and only for times the vault wrote in local terms.
 * `parseSchedule`/`lastFireKey` have always read `daily 09:00` as nine in the
 * morning where the person is, so rendering the next fire through
 * `toISOString()` would show a UTC stamp for a local-time rule — "09:00" on
 * the record and "16:00" on the dossier, for the same moment. The formatting
 * mirrors `lastFireKey`'s for the same reason.
 */
export function localStamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * How long ago something happened, from an ISO stamp.
 *
 * For RECORDED times — a run's `started_at` — which the runtime writes in UTC
 * with a `Z`. Relative rather than absolute because the question the fleet
 * asks is "when did this last do anything", and `2026-07-28T11:42:00Z` makes a
 * reader do subtraction to answer it. The exact stamp stays available: every
 * call site puts it in a `title`, so the precise moment is one hover away and
 * nothing is rounded out of reach.
 *
 * `now` is a parameter rather than a call to the clock so a test can pin it —
 * the same `VAULT_TODAY` discipline the e2e specs follow, and the reason
 * `AgentDossier` already takes one.
 *
 * Three honesty cases, all of which have happened to somebody's database:
 *
 * - An **unparseable** stamp comes back verbatim. Guessing at it would print
 *   a confident wrong time for a row that is actually corrupt.
 * - A stamp **ahead of the clock** — skew, or a machine whose time moved —
 *   prints as itself rather than as "just now". "0 minutes ago" for a run
 *   that has not started yet is the surface covering for the database.
 * - Anything **older than a month** prints its date. "47 days ago" is a
 *   number nobody converts back into a day.
 */
export function relativeWhen(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const ms = now.getTime() - at;
  if (ms < 0) return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return iso.slice(0, 10);
}
