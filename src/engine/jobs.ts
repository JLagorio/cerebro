import { isAgentEntry } from './agents';
import type { VaultEvent } from './events';
import { recordIdentity } from './identity';
import { SOURCES_DIR } from './ingest';
import { isSkillEntry, lastFireKey, parseSchedule } from './skills';
import { firstMatch, parseTriggers } from './triggers';
import { resolveTarget } from './wikilink';
import type { Concept } from './okf';
import type { Entry } from './types';

/**
 * The background agent's work list (M13.2) — one queue, the reasons that are
 * left.
 *
 * M8.6 built this for learning; M13 recognized that a scheduled skill run is
 * the same shape of thing: derived from vault state rather than stored,
 * drained one at a time by a single runner, and stopped from spinning by a
 * ledger recorded before the run.
 *
 * **M26.4j retired the distillation lanes.** `filed` and `behind` are gone,
 * and so is `engine/learn.ts`: reading a note and extracting concepts is now
 * `src-tauri/src/ingest/`, driven by a Rust tick against durable scheduler
 * rows. The two lanes died for different reasons and both are worth stating.
 * `behind` compared a FILESYSTEM mtime against a frontmatter stamp, so a
 * `git checkout` flooded the queue; catch-up compares content hashes. `filed`
 * needed a renderer-side ledger of paths somebody had organized, which meant
 * a note edited any other way was never re-read — the ingest pass watches the
 * bytes, so filing is picked up because it WRITES, not because the UI
 * remembered to say so.
 *
 * What is left here is not distillation: scheduled skills, scheduled and
 * event-triggered agent runs, cached-source refresh, and the concept recheck
 * lanes (`stale`, `schema`) that M26.6's maintenance pass will take over.
 *
 * Ranking: a standing appointment goes first; refresh and rechecks are
 * maintenance.
 */

export type JobKind = 'scheduled' | 'agent' | 'refresh' | 'stale' | 'schema';

/**
 * How long an event-triggered agent must wait before another event can fire
 * it (M17.12).
 *
 * A LOOP-BREAKER, not a rate limit, and the distinction matters because it
 * explains the value. An agent watching `records/risks` that WRITES to
 * `records/risks` changes a file, which produces an event, which fires the
 * agent, forever — and nothing about the ledger stops it, because each write
 * mints a genuinely new event key. Fifteen minutes bounds that to four runs an
 * hour in the worst case, which is visible in the run log and cheap enough to
 * survive until somebody notices.
 *
 * The alternative — "ignore events inside your own scope" — is tempting and
 * wrong: reacting to a human edit in the folder you maintain is the single
 * most useful thing a scoped agent can do.
 */
export const TRIGGER_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Off duty without being dismantled (M18).
 *
 * Activation is DERIVED — an agent runs exactly when it has a schedule or a
 * trigger — which is the right rule and left no way to stop one temporarily.
 * The only "off" available was deleting the thing that fires it, so turning an
 * agent off for an afternoon meant destroying the configuration and rebuilding
 * it from memory afterwards. `paused: true` is the pause; the trigger stays on
 * the record, readable, and comes back on when the switch does.
 *
 * Deliberately NOT the inverse (`enabled: true`): a record with no schedule and
 * no trigger is already inert, and a second flag that also has to say so would
 * give "is this running?" two answers that can disagree.
 */
export function isPaused(entry: Entry): boolean {
  return entry.properties.paused === true;
}

export interface AgentJob {
  kind: JobKind;
  path: string;
  /**
   * What the LEDGER remembers this job as (M17.8).
   *
   * The same as `path` for everything whose subject is an ordinary note. For a
   * Skill or an Agent it is `recordIdentity`, so a record that declares a
   * `slug:` keeps its place in the ledger across a rename — renaming a record
   * renames its file, and a path-keyed ledger therefore forgot every fire the
   * schedule had answered and ran one catch-up for the privilege.
   */
  key: string;
  title: string;
  /** What the ledger records at start: the note's modifiedAt for learn jobs,
   * the schedule's fire key for scheduled runs. */
  runKey: string;
  /**
   * WHICH ledger suppresses this job — decided here, where each kind's
   * derivation gates on one, and never re-derived in the runner. The
   * review's worst finding was exactly that drift: agent jobs gated on
   * skillRuns but recorded in attempts, which re-ran a scheduled agent
   * back-to-back forever.
   */
  ledger: 'attempts' | 'skillRuns';
}

export interface JobQueueInput {
  /**
   * path → the run key last attempted. The loop-stopper: a recheck that
   * decided there was nothing to revise writes nothing, which leaves the
   * concept exactly as outstanding as it was before. Without this the runner
   * would pick it up again on the next tick, forever.
   */
  attempts: Readonly<Record<string, string>>;
  /** Skill path → fire key last run — the OPEN VAULT's slice of
   * uiStore.skillRuns, which is vault-scoped (PR #5 review). */
  skillRuns: Readonly<Record<string, string>>;
  /** What changed since the last scan (M17.12). Absent means no previous
   * scan to compare against — the first scan of a session fires nothing. */
  events?: readonly VaultEvent[];
  /** Agent identity → when it last ran from a TRIGGER, ISO. See
   * TRIGGER_COOLDOWN_MS. */
  triggerRuns?: Readonly<Record<string, string>>;
  /** The wall clock — passed in so the queue stays a pure derivation. */
  now: Date;
  /** Connectors enabled (uiStore.agentConnectors). A stale cached source is
   * only work when the agent can actually reach the system it came from. */
  connectors?: boolean;
}

export function jobQueue(
  entries: readonly Entry[],
  concepts: readonly Concept[],
  { attempts, skillRuns, now, connectors = false, events = [], triggerRuns = {} }: JobQueueInput,
): AgentJob[] {
  // A cached source past its refresh date becomes a re-fetch (M13.3) —
  // cache_source stamps stale_after for exactly this, and the refreshed
  // file's new mtime makes citing concepts `behind`, so the distiller
  // re-checks them with no extra wiring. Derived FIRST because a
  // refresh-due source must be exactly ONE job: its own `behind`
  // re-distillation shares the same attempts key, and letting that run
  // first would record the key and starve the re-fetch forever. The
  // re-distill resumes on its own once the refresh changes the mtime.
  const refresh: AgentJob[] = [];
  if (connectors) {
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (const entry of entries) {
      if (!entry.path.startsWith(`${SOURCES_DIR}/`) || entry.parseError !== null) continue;
      const stale = entry.properties.stale_after;
      if (typeof stale !== 'string' || stale > today) continue;
      if (attempts[entry.path] === entry.modifiedAt) continue;
      refresh.push({
        kind: 'refresh',
        path: entry.path,
        // An ordinary note has no declared identity: its path is what the
        // ledger has always remembered it as, and still is.
        key: entry.path,
        title: entry.title,
        runKey: entry.modifiedAt,
        ledger: 'attempts',
      });
    }
  }
  // Re-synthesis is staleness (M13.5): when a Type doc changes after a
  // concept was generated, every concept `about` records of that type is due
  // a recheck — lazily, one at a time, never as a bulk reprocess. The run
  // key is max(concept mtime, newest relevant type-doc mtime): recorded on
  // attempt, it suppresses both triggers at once, and a LATER type edit or
  // concept edit raises it again.
  const typeDocs = new Map<string, Entry>();
  for (const e of entries) {
    if (e.type === 'Type') typeDocs.set(e.title, e);
  }
  const all = [...entries];
  const recheck: AgentJob[] = [];
  for (const concept of concepts) {
    if (concept.supersededBy !== null || concept.lifecycle === 'deprecated') continue;
    const generatedAt = concept.generated?.at ?? null;
    let newestTypeChange: string | null = null;
    if (generatedAt !== null) {
      for (const target of concept.about) {
        const entry = resolveTarget(target, all);
        if (entry === null || entry.type === null) continue;
        const doc = typeDocs.get(entry.type);
        if (doc === undefined || doc.modifiedAt <= generatedAt) continue;
        if (newestTypeChange === null || doc.modifiedAt > newestTypeChange) {
          newestTypeChange = doc.modifiedAt;
        }
      }
    }
    if (!concept.stale && newestTypeChange === null) continue;
    const runKey =
      newestTypeChange !== null && newestTypeChange > concept.entry.modifiedAt
        ? newestTypeChange
        : concept.entry.modifiedAt;
    if (attempts[concept.entry.path] === runKey) continue;
    recheck.push({
      kind: newestTypeChange !== null ? 'schema' : 'stale',
      path: concept.entry.path,
      key: concept.entry.path,
      title: concept.title,
      runKey,
      ledger: 'attempts',
    });
  }

  // Scheduled skills and scheduled agent runs share the derivation and the
  // fire-key ledger (both are path-keyed); they differ in kind because the
  // runner builds a different prompt, tool policy, and actor for an agent.
  const scheduled: AgentJob[] = [];
  for (const entry of entries) {
    const kind: JobKind | null = isSkillEntry(entry)
      ? 'scheduled'
      : isAgentEntry(entry)
        ? 'agent'
        : null;
    if (kind === null || isPaused(entry)) continue;
    const schedule = parseSchedule(entry.properties.schedule);
    if (schedule === null) continue;
    const key = lastFireKey(schedule, now);
    const ledgerKey = recordIdentity(entry);
    if (skillRuns[ledgerKey] === key) continue;
    scheduled.push({
      kind,
      path: entry.path,
      key: ledgerKey,
      title: entry.title,
      runKey: key,
      ledger: 'skillRuns',
    });
  }

  // Event-triggered agent runs (M17.12). Layer ONE only: everything here is
  // answered from the scanned frontmatter, with no model consulted, because a
  // trigger that asks a model whether to fire costs money to be idle and
  // cannot be explained from the record. The `ask:` half is layer two and
  // happens inside the run, in the prompt the runner builds.
  if (events.length > 0) {
    for (const entry of entries) {
      if (!isAgentEntry(entry) || isPaused(entry)) continue;
      const triggers = parseTriggers(entry.properties.when);
      if (triggers.length === 0) continue;
      const key = recordIdentity(entry);
      const last = triggerRuns[key];
      if (last !== undefined && now.getTime() - Date.parse(last) < TRIGGER_COOLDOWN_MS) continue;
      // An agent must never be fired by a change to ITSELF: editing an agent's
      // instructions, or its own memory write at the end of a run, would
      // otherwise be an event it reacts to.
      const event = events.find(
        (e: VaultEvent) => e.path !== entry.path && firstMatch(triggers, e) !== null,
      );
      if (event === undefined) continue;
      const runKey = `event:${event.kind}:${event.path}@${event.entry.modifiedAt}`;
      if (skillRuns[key] === runKey) continue;
      scheduled.push({
        kind: 'agent',
        path: entry.path,
        key,
        title: entry.title,
        runKey,
        ledger: 'skillRuns',
      });
    }
  }

  // Every kind has a DISTINCT rank, and that is load-bearing for the tie-
  // break below: recheck runKeys are ISO timestamps, scheduled runKeys are
  // fire keys, and the two formats only ever compare within their own kind.
  // Give two kinds one rank and the sort silently orders by format.
  // Refresh sits before stale on purpose: a concept recheck reads its
  // sources, and rechecking against a copy about to be replaced is wasted.
  const RANK: Record<JobKind, number> = {
    scheduled: 0,
    agent: 1,
    refresh: 2,
    stale: 3,
    schema: 4,
  };
  return [...scheduled, ...refresh, ...recheck].sort(
    (a, b) =>
      RANK[a.kind] - RANK[b.kind] ||
      b.runKey.localeCompare(a.runKey) ||
      a.path.localeCompare(b.path),
  );
}
