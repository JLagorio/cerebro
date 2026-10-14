import { isAgentEntry } from './agents';
import type { VaultEvent } from './events';
import { recordIdentity } from './identity';
import { fireKeyDate, isSkillEntry, lastFireKey, parseSchedule } from './skills';
import { firstMatch, parseTriggers } from './triggers';
import { resolveTarget } from './wikilink';
import { isKnowledgePath, type Concept } from './okf';
import { sha256Hex } from '@/lib/sha256';
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
 * event-triggered agent runs, and the concept recheck lanes (`stale`,
 * `schema`) that M26.6's maintenance pass will take over. Cached-source
 * refresh derives no job since M54.9 (see `jobQueue`).
 *
 * Ranking: a standing appointment goes first; rechecks are maintenance.
 */

export type JobKind = 'scheduled' | 'agent' | 'refresh' | 'stale' | 'schema';

/**
 * The job kinds whose whole purpose is rewriting `knowledge/` (M49.2): the
 * stale and schema recheck lanes. They are held while the vault is not
 * recording — every write they exist to make would be refused (M49.1), so
 * running them only spends money.
 */
export const KNOWLEDGE_JOB_KINDS: ReadonlySet<JobKind> = new Set<JobKind>(['stale', 'schema']);

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
 *
 * The clock is the agent's, under its bare identity in `triggerRuns`, and it
 * only bounds anything while the check and the stamp agree on that key —
 * which is why the job carries it (`AgentJob.cooldownKey`). Only an
 * EVENT-fired run stamps it. A scheduled run does not, so what it writes into
 * the folder its agent watches can fire one event run, and that run starts
 * the clock. Attended @agent chat turns and `hand_to` runs never stamp it.
 *
 * Stamping on a scheduled run too was tried and reverted (AUTOMATION-2). It
 * only postponed that one event run, and a person's edit inside the window
 * could be lost rather than delayed: the runner keeps one event list, and
 * the next scan that finds a change replaces it (useJobRunner).
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
   *
   * An EVENT-triggered agent run is remembered apart from its schedule, as
   * `<identity>#event` (AUTOMATION-2); the bare identity is the schedule's
   * alone. The two shared one slot: an event run overwrote the fire key its
   * schedule had answered, so the schedule fired again the same period, and
   * that re-fire overwrote the event in turn, so the same event fired again
   * once the cooldown ran out — the two ping-ponging every fifteen minutes
   * until the day's budget stopped them. No scanned path ends in `#event`
   * (they all end in `.md`), and no slug contains a `#`.
   */
  key: string;
  title: string;
  /**
   * What the ledger records at start, per kind (M49.7):
   * - `refresh` — the source note's modifiedAt (the only mtime key), though
   *   no refresh job is derived since M54.9;
   * - `stale` — `stale:<stale_after>`, the recheck date;
   * - `schema` — `schema:<hash of the anchoring Type docs>`, plus
   *   `|stale:<stale_after>` when the concept is also stale;
   * - `scheduled` / `agent` — the schedule's fire key; an event-triggered
   *   `agent` run — `event:<kind>:<path>@<modifiedAt>`.
   */
  runKey: string;
  /**
   * WHICH ledger suppresses this job — decided here, where each kind's
   * derivation gates on one, and never re-derived in the runner. The
   * review's worst finding was exactly that drift: agent jobs gated on
   * skillRuns but recorded in attempts, which re-ran a scheduled agent
   * back-to-back forever.
   */
  ledger: 'attempts' | 'skillRuns';
  /**
   * The `triggerRuns` key this job's run stamps when it spawns — the event
   * cooldown's clock — or null for every job but an event-fired agent run,
   * the one run that starts it (see TRIGGER_COOLDOWN_MS).
   *
   * Carried, never re-derived in the runner, for the same reason as `ledger`.
   * It is the agent's bare identity, which is what the cooldown check reads,
   * and NOT `key`: the runner used to stamp under `key`, so splitting event
   * runs into `<identity>#event` (AUTOMATION-2) would have moved the stamp
   * where the check never looks and silently deleted the only bound on an
   * agent re-firing on its own writes.
   */
  cooldownKey: string | null;
}

export interface JobQueueInput {
  /**
   * path → the run key last attempted. The loop-stopper: a recheck that
   * decided there was nothing to revise writes nothing, which leaves the
   * concept exactly as outstanding as it was before. Without this the runner
   * would pick it up again on the next tick, forever.
   */
  attempts: Readonly<Record<string, string>>;
  /** Ledger key → run key last answered: a schedule's fire key under the
   * record's identity, an event run's key under `<identity>#event` (see
   * `AgentJob.key`). The OPEN VAULT's slice of uiStore.skillRuns, which is
   * vault-scoped (PR #5 review). */
  skillRuns: Readonly<Record<string, string>>;
  /** What changed since the last scan of the open vault (M17.12). Absent
   * means no previous scan to compare against — the first scan of a session,
   * or of a vault just opened (AUTOMATION-2b), fires nothing. */
  events?: readonly VaultEvent[];
  /** Agent identity → when it last ran from a trigger, ISO. The bare
   * identity, never the `#event` key — see TRIGGER_COOLDOWN_MS. */
  triggerRuns?: Readonly<Record<string, string>>;
  /** The wall clock — passed in so the queue stays a pure derivation. */
  now: Date;
}

/** An attempt recorded as an mtime — the run key before M49.7. */
function isLegacyAttempt(key: string | undefined): key is string {
  return key !== undefined && /^\d{4}-\d{2}-\d{2}T/.test(key);
}

/** A stable key for the schema a set of Type docs declares: their paths and
 * frontmatter, key-sorted, hashed — content, never a timestamp (M49.7). */
function schemaKey(docs: readonly Entry[]): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((k) => [k, sorted((value as Record<string, unknown>)[k])]),
          )
        : value;
  const canonical = JSON.stringify(
    [...docs]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((d) => [d.path, sorted(d.properties)]),
  );
  return sha256Hex(canonical).slice(0, 16);
}

export function jobQueue(
  entries: readonly Entry[],
  concepts: readonly Concept[],
  { attempts, skillRuns, now, events = [], triggerRuns = {} }: JobQueueInput,
): AgentJob[] {
  // A cached source past its refresh date (cache_source's stale_after) is
  // NOT a job (M54.9). Re-fetching needs the connector the source came from,
  // and a refresh run holds none: it runs unattended with no record to name
  // `connectors:`, and an unattended run reaches only the connectors its
  // record names (Q8). Each stale source would cost one budgeted run that
  // could only say it has no connector. The `refresh` kind, its budget lane
  // and refreshSourcePrompt wait for the owner's call on which connector a
  // refresh run may hold; cache_source records only `issue` or `web`, never
  // the connector.
  //
  // Re-synthesis is staleness (M13.5): when a Type doc changes after a
  // concept was generated, every concept `about` records of that type is due
  // a recheck — lazily, one at a time, never as a bulk reprocess.
  //
  // M49.7 (K18) narrowed what counts, after creating a `Decision` Type doc
  // re-queued three concepts on the live vault for $5.20 of paid runs:
  // - only anchors OUTSIDE the bundle — a concept `about` another concept
  //   (or itself: gcs-5 anchored to gcs-5) describes knowledge, not the
  //   shape of a record, so no Type edit can make it stale;
  // - the run key is the SCHEMA it was checked against (a hash of the
  //   anchoring Type docs' frontmatter), never an mtime — a Restore that
  //   pushed `generated.at` back re-queued the same three concepts;
  // - the stale lane is keyed on the recheck DATE, so a recheck that did
  //   not move it cannot run again until something does (K19's loop).
  const typeDocs = new Map<string, Entry>();
  for (const e of entries) {
    if (e.type === 'Type') typeDocs.set(e.title, e);
  }
  const all = [...entries];
  const recheck: AgentJob[] = [];
  for (const concept of concepts) {
    if (concept.supersededBy !== null || concept.lifecycle === 'deprecated') continue;
    const generatedAt = concept.generated?.at ?? null;
    const changed = new Map<string, Entry>();
    if (generatedAt !== null) {
      for (const target of concept.about) {
        const entry = resolveTarget(target, all);
        if (entry === null || entry.type === null) continue;
        if (entry.path === concept.entry.path || isKnowledgePath(entry.path)) continue;
        const doc = typeDocs.get(entry.type);
        if (doc === undefined || doc.modifiedAt <= generatedAt) continue;
        changed.set(doc.path, doc);
      }
    }
    if (!concept.stale && changed.size === 0) continue;
    // A stale concept's key carries its recheck date even on the schema
    // lane: `recheck_concept` moves only `stale_after` (never
    // `generated.at`), so the schema change stays "newer than generated"
    // for good, and a key without the date would suppress every later
    // stale recheck of that concept (review fix).
    const staleKey = `stale:${String(concept.entry.properties.stale_after ?? '')}`;
    const runKey =
      changed.size > 0
        ? `schema:${schemaKey([...changed.values()])}${concept.stale ? `|${staleKey}` : ''}`
        : staleKey;
    const attempted = attempts[concept.entry.path];
    if (attempted === runKey) continue;
    // An attempt recorded under the OLD mtime key (before M49.7) still
    // answers the question if nothing it would have seen has moved since:
    // honoring it keeps an upgrade from re-running every stale concept
    // once, at a cost nobody asked for.
    const newest = [concept.entry.modifiedAt, ...[...changed.values()].map((d) => d.modifiedAt)]
      .sort()
      .at(-1);
    if (isLegacyAttempt(attempted) && newest !== undefined && attempted >= newest) continue;
    recheck.push({
      kind: changed.size > 0 ? 'schema' : 'stale',
      path: concept.entry.path,
      key: concept.entry.path,
      title: concept.title,
      runKey,
      ledger: 'attempts',
      cooldownKey: null,
    });
  }

  // Scheduled skills and scheduled agent runs share the derivation and the
  // fire-key ledger, under the bare record identity — a slot only a schedule
  // writes (see AgentJob.key). They differ in kind because the runner builds
  // a different prompt, tool policy, and actor for an agent.
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
      // No scheduled run starts the event cooldown, an agent's included:
      // only an event-fired run does (TRIGGER_COOLDOWN_MS).
      cooldownKey: null,
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
      const identity = recordIdentity(entry);
      // ONE variable is both the key this check reads and the key the run
      // stamps (`cooldownKey` below) — see AgentJob.cooldownKey.
      const cooldownKey = identity;
      const last = triggerRuns[cooldownKey];
      if (last !== undefined && now.getTime() - Date.parse(last) < TRIGGER_COOLDOWN_MS) continue;
      // An agent must never be fired by a change to ITSELF: editing an agent's
      // instructions, or its own memory write at the end of a run, would
      // otherwise be an event it reacts to.
      const event = events.find(
        (e: VaultEvent) => e.path !== entry.path && firstMatch(triggers, e) !== null,
      );
      if (event === undefined) continue;
      const runKey = `event:${event.kind}:${event.path}@${event.entry.modifiedAt}`;
      // The event lane's own slot (AUTOMATION-2). Answered here, the same
      // event stays answered however long the vault stays quiet, and the
      // schedule's slot never learns that an event ran.
      const key = `${identity}#event`;
      if (skillRuns[key] === runKey) continue;
      scheduled.push({
        kind: 'agent',
        path: entry.path,
        key,
        title: entry.title,
        runKey,
        ledger: 'skillRuns',
        cooldownKey,
      });
    }
  }

  // Every kind has a DISTINCT rank, and that is load-bearing for the tie-
  // break below: it sorts runKey DESCENDING as a string, and each kind's
  // keys have their own format (see `AgentJob.runKey`), so they only ever
  // compare within their own kind. Give two kinds one rank and the sort
  // silently orders by format. What the descending tie-break yields:
  // - `stale`: the LATEST recheck date first, so the longest-overdue
  //   concept goes last;
  // - `schema`: hash order — stable, but meaningless;
  // - `scheduled` / `agent`: the latest fire first; within `agent`, which
  //   mixes the two formats, every `event:` key sorts before every fire key.
  // Equal keys fall back to path order.
  // `refresh` keeps its slot before stale, where a re-fetch belongs: a
  // concept recheck reads its sources, and rechecking against a copy about
  // to be replaced is wasted.
  const RANK: Record<JobKind, number> = {
    scheduled: 0,
    agent: 1,
    refresh: 2,
    stale: 3,
    schema: 4,
  };
  return [...scheduled, ...recheck].sort(
    (a, b) =>
      RANK[a.kind] - RANK[b.kind] ||
      b.runKey.localeCompare(a.runKey) ||
      a.path.localeCompare(b.path),
  );
}

/**
 * Why a job's run started, as `run_agent`'s request names it (M56.7).
 *
 * `kind` is a string the runtime admits or refuses: the vocabulary, its
 * words and the CHECK that holds it live once, in
 * `src-tauri/src/runtime/cause.rs`, and this side keeps no list of them. Rust
 * cleans and caps every value, quotes it in the run's prompt as data, and
 * records it on the run's row.
 */
export interface RunCauseRequest {
  kind: string;
  subject?: string;
  detail?: string;
  due_at?: string;
}

/** Why a recheck lane's run started, in words, by job kind (Q17: the lanes
 * record `maintenance`, and the reason rides as detail). */
const MAINTENANCE_DETAIL: Partial<Record<JobKind, string>> = {
  refresh: 'a cached source passed its refresh date',
  stale: 'a concept passed its recheck date',
  schema: 'the schema a concept describes changed',
};

/** The path an event run key names: `event:<kind>:<path>@<modifiedAt>`. */
function eventPath(runKey: string): string | null {
  const match = runKey.match(/^event:[^:]+:(.+)@[^@]*$/);
  return match === null ? null : match[1];
}

/**
 * The cause one job's run names (M56.7).
 *
 * - An event run: `event`, its subject the changed path and its detail the
 *   trigger's words. `woke` is what the runner matched; without it the path
 *   is read back from the run key, and the words are left out.
 * - A schedule's fire, a skill's or an agent's: `schedule`, its detail the
 *   record's `schedule:` and its due moment the fire key's instant.
 * - The recheck lanes: `maintenance`, the concept as subject, the lane's
 *   reason as detail.
 */
export function causeOfJob(
  job: AgentJob,
  woke: { subject: string; because: string } | null,
  schedule: string | null,
): RunCauseRequest {
  if (job.runKey.startsWith('event:')) {
    const subject = woke?.subject ?? eventPath(job.runKey);
    return {
      kind: 'event',
      ...(subject === null ? {} : { subject }),
      ...(woke === null ? {} : { detail: woke.because }),
    };
  }
  if (job.kind === 'scheduled' || job.kind === 'agent') {
    const due = fireKeyDate(job.runKey);
    const said = schedule?.trim() ?? '';
    return {
      kind: 'schedule',
      ...(said === '' ? {} : { detail: said }),
      ...(due === null ? {} : { due_at: due.toISOString() }),
    };
  }
  const detail = MAINTENANCE_DETAIL[job.kind];
  return {
    kind: 'maintenance',
    subject: job.path,
    ...(detail === undefined ? {} : { detail }),
  };
}
