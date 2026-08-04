import type { Entry } from './types';

/**
 * What changed in the vault between two scans (M17.12).
 *
 * The event source for triggers, and it is a DIFF rather than a watcher
 * payload on purpose. The `notify` watcher knows a file moved; it does not
 * know that `status` went from `doing` to `blocked`, because it never parsed
 * either version. The app already holds the parsed corpus and already replaces
 * it wholesale on every rescan, so the before/after pair is sitting right
 * there — and the same rescan is what the runner reacts to anyway.
 *
 * ## The honesty constraint
 *
 * A desktop app that is closed observes nothing. An edit made in another
 * editor while cerebro was quit produces NO event, ever — the next scan sees
 * one state and has nothing to compare it to. That is not a bug to be fixed
 * later; it is what "trigger" means in a local-first app, and the trigger UI
 * has to say so rather than implying a daemon.
 *
 * The first scan of a session is therefore deliberately eventless: treating
 * every note in the vault as "created" would fire every trigger at once, every
 * launch. See `diffEntries` — a null `before` yields nothing.
 */
export type VaultEvent =
  | { kind: 'created'; path: string; entry: Entry }
  | { kind: 'moved'; path: string; from: string; entry: Entry }
  | {
      kind: 'changed';
      path: string;
      entry: Entry;
      before: Entry;
      /** Property names whose value differs. Empty when only the body moved. */
      fields: string[];
    };

/** Compare two property bags by their rendered value — enough to answer
 * "did status change", without depending on YAML round-trip fidelity. */
function changedFields(before: Entry, after: Entry): string[] {
  const names = new Set([
    ...Object.keys(before.properties),
    ...Object.keys(after.properties),
    ...Object.keys(before.relationships),
    ...Object.keys(after.relationships),
  ]);
  const show = (v: unknown): string => (v === undefined || v === null ? '' : JSON.stringify(v));
  return [...names]
    .filter(
      (name) =>
        show(before.properties[name]) !== show(after.properties[name]) ||
        show(before.relationships[name]) !== show(after.relationships[name]),
    )
    .sort();
}

/**
 * The events between two corpora.
 *
 * `before` null means "no previous scan" — the first one of a session — and
 * yields nothing at all. A note present in `after` and absent from `before`
 * is only `created` when there WAS a before to be absent from.
 *
 * Deletions produce no event. A trigger that fired on a deleted record would
 * hand an agent a path it cannot read, and "react to something that is gone"
 * has no useful meaning for an unattended run.
 */
export function diffEntries(before: Entry[] | null, after: Entry[]): VaultEvent[] {
  if (before === null) return [];
  const byPath = new Map(before.map((e) => [e.path, e]));
  // Identity for a MOVE. `createdAt` alone is not unique enough on a fast
  // machine; paired with the title it is enough to tell "this file moved" from
  // "a new file appeared", and being wrong here costs a `created` event
  // instead of a `moved` one rather than anything silent.
  const identity = (e: Entry) => `${e.createdAt}|${e.title}`;
  const goneByIdentity = new Map<string, Entry>();
  const survivors = new Set(after.map((e) => e.path));
  for (const e of before) {
    if (!survivors.has(e.path)) goneByIdentity.set(identity(e), e);
  }

  const events: VaultEvent[] = [];
  for (const entry of after) {
    const previous = byPath.get(entry.path);
    if (previous === undefined) {
      const moved = goneByIdentity.get(identity(entry));
      events.push(
        moved === undefined
          ? { kind: 'created', path: entry.path, entry }
          : { kind: 'moved', path: entry.path, from: moved.path, entry },
      );
      continue;
    }
    if (previous.modifiedAt === entry.modifiedAt) continue;
    events.push({
      kind: 'changed',
      path: entry.path,
      entry,
      before: previous,
      fields: changedFields(previous, entry),
    });
  }
  return events;
}
