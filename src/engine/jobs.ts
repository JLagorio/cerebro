import { agentRef, isAgentEntry, isPaused } from './agents';
import { followupDue, type Followup } from './followups';
import { localStamp } from './whenText';
import { recordIdentity } from './identity';
import {
  fireKeyDate,
  isSkillEntry,
  lastSetFireKey,
  parseScheduleSet,
  scheduleText,
} from './skills';
import { parseTriggers, type Trigger } from './triggers';
import { triggerDigest, WAKE_COALESCE_MAX, type PendingWake } from './wakes';
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
 * What is left here is not distillation: scheduled skills, scheduled agent
 * runs, the runs their durable wakes ask for (M63.1), their booked follow-ups
 * (M63.8), and the concept
 * recheck lanes (`stale`,
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
 * which is why the job carries it (`AgentJob.cooldownKey`). Only a WOKEN run
 * stamps it. A scheduled run does not, so what it writes into the folder its
 * agent watches can wake one run, and that run starts the clock. Attended
 * @agent chat turns and `hand_to` runs never stamp it. Recorded assignments
 * neither wait on nor stamp it; unrecorded assignments keep this bound.
 *
 * The cooldown DELAYS, and drops nothing (M63.1): a change made inside the
 * window waits as a durable wake, and runs, with the other changes that
 * matched the same trigger, once the window has passed.
 */
export const TRIGGER_COOLDOWN_MS = 15 * 60 * 1000;

// Moved to engine/agents with M63.1; re-exported so imports keep working.
export { isPaused };

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
   * A woken run's is `<identity>#wake` (M63.1), so a session's hold on it
   * never shares the schedule's slot. Its ledger is Rust's `agent_wakes`, not
   * the job ledger: no scanned path ends in `#wake`, and no slug has a `#`.
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
   * - `scheduled` / `agent` — the schedule's fire key; a woken `agent` run —
   *   `wake:<wake id>`, the wake it claims. A manual start with no due fire
   *   uses `manual:<ISO>` without claiming a ledger.
   */
  runKey: string;
  /**
   * WHICH ledger suppresses this job — decided here, where each kind's
   * derivation gates on one, and never re-derived in the runner. The
   * review's worst finding was exactly that drift: agent jobs gated on
   * skillRuns but recorded in attempts, which re-ran a scheduled agent
   * back-to-back forever. `wakes` is a woken run's (M63.1): Rust's durable
   * wake is its record, claimed with its lease, and the job ledger never
   * hears of it. A `followup` similarly claims its own durable row. A manual
   * start without a due fire uses null.
   */
  ledger: 'attempts' | 'skillRuns' | 'wakes' | 'followup' | null;
  /** A booked later run claims its own durable row, never a job ledger. */
  followup?: Followup;
  /** A human start takes a due fire when possible, otherwise no ledger. */
  manual?: true;
  /**
   * The `triggerRuns` key this job's run stamps when it spawns — the event
   * cooldown's clock — or null for every job but a woken agent run, the one
   * run that starts it (see TRIGGER_COOLDOWN_MS).
   *
   * Carried, never re-derived in the runner, for the same reason as `ledger`.
   * It is the agent's bare identity, which is what the cooldown check reads,
   * and NOT `key`, which is the job's own slot: stamped there, the clock
   * would sit where the check never looks, and nothing would bound an agent
   * waking on its own writes.
   */
  cooldownKey: string | null;
  /**
   * What a woken run claims (M63.1): the head wake, the due wakes of the same
   * trigger it takes with it (oldest first, at most 19), the trigger that
   * matched (its `ask:` is checked first, `do:` goes to the prompt, its words to the log),
   * when the head was admitted, and the reasons it was last deferred, null
   * when it never was.
   */
  wake?: {
    claim: string;
    coalesce: string[];
    trigger: Trigger;
    admittedAt: string;
    deferredBefore: string | null;
    assignment?: { subject: string; field: string; agent: string; trigger: string };
  };
}

export interface JobQueueInput {
  /**
   * path → the run key last attempted. The loop-stopper: a recheck that
   * decided there was nothing to revise writes nothing, which leaves the
   * concept exactly as outstanding as it was before. Without this the runner
   * would pick it up again on the next tick, forever.
   */
  attempts: Readonly<Record<string, string>>;
  /** Ledger key → newest fire the record owes nothing for, under the
   * record's identity. The OPEN VAULT's slice of uiStore.skillRuns, which is
   * vault-scoped (PR #5 review). */
  skillRuns: Readonly<Record<string, string>>;
  /** The open vault's pending wakes, oldest first, as `wakes_pending` read
   * them (M63.1). Absent derives no woken run: a read that failed is not a
   * vault where nothing is waiting, and neither is one not read yet. */
  wakes?: readonly PendingWake[];
  /** Agent identity → when it last ran from a trigger, ISO. The bare
   * identity, never the job's `#wake` key — see TRIGGER_COOLDOWN_MS. */
  triggerRuns?: Readonly<Record<string, string>>;
  /** Read rows only: an unavailable follow-up store supplies none. */
  followups?: readonly Followup[];
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
  { attempts, skillRuns, now, wakes = [], triggerRuns = {}, followups = [] }: JobQueueInput,
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
    const schedule = parseScheduleSet(entry.properties.schedule);
    if (schedule === null) continue;
    const key = lastSetFireKey(schedule, now);
    const ledgerKey = recordIdentity(entry);
    if (key === null || skillRuns[ledgerKey] === key) continue;
    scheduled.push({
      kind,
      path: entry.path,
      key: ledgerKey,
      title: entry.title,
      runKey: key,
      ledger: 'skillRuns',
      // No scheduled run starts the event cooldown, an agent's included:
      // only a woken run does (TRIGGER_COOLDOWN_MS).
      cooldownKey: null,
    });
  }

  // Woken agent runs (M63.1): the wake lane. Each agent drains its own due
  // wakes, one run at a time, oldest first. Only a due wake counts (its
  // `notBefore` passed, or never set), and the cooldown DELAYS: a wake held
  // by it is still pending, and runs once the window has passed. Which
  // changes wake whom, and why, is engine/wakes.ts's; Rust admitted each once.
  for (const entry of entries) {
    if (!isAgentEntry(entry) || isPaused(entry) || wakes.length === 0) continue;
    const triggers = parseTriggers(entry.properties.when);
    if (triggers.length === 0) continue;
    const identity = recordIdentity(entry);
    // ONE variable is both the key this check reads and the key the run
    // stamps (`cooldownKey` below) — see AgentJob.cooldownKey.
    const last = triggerRuns[identity];
    const cooling = last !== undefined && now.getTime() - Date.parse(last) < TRIGGER_COOLDOWN_MS;
    const actor = agentRef(entry).actor;
    const due = wakes.filter(
      (w) =>
        w.agent === actor &&
        (w.notBefore === null || Date.parse(w.notBefore) <= now.getTime()) &&
        (!cooling ||
          (w.cause.kind === 'assigned' && (w.author === 'person' || w.author === 'run'))),
    );
    // The head is the oldest due wake whose trigger is still on the record;
    // one whose trigger was edited away waits for its cancel, never runs.
    const byDigest = new Map(triggers.map((t) => [triggerDigest(t), t]));
    const head = due.find((w) => byDigest.has(w.trigger));
    if (head === undefined) continue;
    const cooldownKey =
      head.cause.kind === 'assigned' && (head.author === 'person' || head.author === 'run')
        ? null
        : identity;
    const matched = byDigest.get(head.trigger)!;
    const coalesce =
      head.cause.kind === 'event'
        ? due
            .filter(
              (w) =>
                w !== head &&
                w.trigger === head.trigger &&
                w.cause.kind === 'event' &&
                (w.parentRunId ?? null) === (head.parentRunId ?? null),
            )
            .slice(0, WAKE_COALESCE_MAX - 1)
            .map((w) => w.wakeId)
        : [];
    scheduled.push({
      kind: 'agent',
      path: entry.path,
      key: `${identity}#wake`,
      title: entry.title,
      runKey: `wake:${head.wakeId}`,
      ledger: 'wakes',
      cooldownKey,
      wake: {
        claim: head.wakeId,
        coalesce,
        trigger: matched,
        ...(head.cause.kind === 'assigned' &&
        head.cause.subject !== undefined &&
        matched.field !== undefined
          ? {
              assignment: {
                subject: head.cause.subject,
                field: matched.field,
                agent: actor,
                trigger: head.trigger,
              },
            }
          : {}),
        admittedAt: head.admittedAt,
        deferredBefore: head.deferred,
      },
    });
  }

  // Even a paused or missing agent derives a due follow-up: claiming its
  // row is what durably cancels it, so filtering here would leave it waiting.
  for (const row of followups) {
    if (!followupDue(row, now)) continue;
    const owners = entries.filter(
      (entry) => isAgentEntry(entry) && agentRef(entry).actor === row.actor,
    );
    const owner = owners.length === 1 ? owners[0] : undefined;
    const key = `followup:${row.followupId}`;
    scheduled.push({
      kind: 'agent',
      path: owner?.path ?? '',
      key,
      runKey: key,
      title: owner?.title ?? row.actor,
      ledger: 'followup',
      cooldownKey: null,
      followup: row,
    });
  }

  // Every kind has a DISTINCT rank, and that is load-bearing for the tie-
  // break below: it sorts runKey DESCENDING as a string, and each kind's
  // keys have their own format (see `AgentJob.runKey`), so they only ever
  // compare within their own kind. Give two kinds one rank and the sort
  // silently orders by format. What the descending tie-break yields:
  // - `stale`: the LATEST recheck date first, so the longest-overdue
  //   concept goes last;
  // - `schema`: hash order — stable, but meaningless;
  // - `scheduled` / `agent`: the latest fire first. Woken runs are not
  //   compared by key: within `agent` they go before every fire, ordered by
  //   when their head wake was admitted, oldest first.
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
  const woken = (a: AgentJob, b: AgentJob): number =>
    a.wake !== undefined && b.wake !== undefined
      ? a.wake.admittedAt.localeCompare(b.wake.admittedAt)
      : a.wake !== undefined
        ? -1
        : b.wake !== undefined
          ? 1
          : 0;
  const later = (a: AgentJob, b: AgentJob): number =>
    a.followup !== undefined && b.followup !== undefined
      ? a.followup.dueAt.localeCompare(b.followup.dueAt) ||
        a.followup.followupId.localeCompare(b.followup.followupId)
      : a.followup !== undefined
        ? -1
        : b.followup !== undefined
          ? 1
          : 0;
  return [...scheduled, ...recheck].sort(
    (a, b) =>
      later(a, b) ||
      RANK[a.kind] - RANK[b.kind] ||
      woken(a, b) ||
      (a.wake !== undefined ? 0 : b.runKey.localeCompare(a.runKey)) ||
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

/**
 * The cause one job's run names (M56.7).
 *
 * - A woken run: null. Its cause is its wake's, which Rust cleaned and stored
 *   when the change was admitted (engine/wakes.ts names it), and a woken
 *   request that named another would be refused.
 * - A schedule's fire, a skill's or an agent's: `schedule`, its detail the
 *   record's `schedule:` and its due moment the fire key's instant.
 * - The recheck lanes: `maintenance`, the concept as subject, the lane's
 *   reason as detail.
 */
export function causeOfJob(job: AgentJob, schedule: unknown): RunCauseRequest | null {
  if (job.manual) {
    const due = job.ledger === 'skillRuns' ? fireKeyDate(job.runKey) : null;
    return {
      kind: 'manual',
      subject: job.path,
      ...(due === null ? {} : { detail: `in place of its run due ${localStamp(due)}` }),
    };
  }
  if (job.followup !== undefined)
    return { kind: 'followup', subject: job.followup.note, due_at: job.followup.dueAt };
  if (job.wake !== undefined) return null;
  if (job.kind === 'scheduled' || job.kind === 'agent') {
    const due = fireKeyDate(job.runKey);
    const said = scheduleText(schedule).trim();
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

/** The last unconsumed schedule firing, read exactly like the queue. */
export function dueFireKey(
  entry: Entry,
  skillRuns: Readonly<Record<string, string>>,
  now: Date,
): string | null {
  const schedule = parseScheduleSet(entry.properties.schedule);
  if (schedule === null) return null;
  const key = lastSetFireKey(schedule, now);
  return skillRuns[recordIdentity(entry)] === key ? null : key;
}
export function runNowJob(
  entry: Entry,
  { skillRuns, now }: { skillRuns: Readonly<Record<string, string>>; now: Date },
): AgentJob {
  const due = dueFireKey(entry, skillRuns, now);
  return {
    kind: 'agent',
    path: entry.path,
    title: entry.title,
    key: recordIdentity(entry),
    runKey: due ?? `manual:${now.toISOString()}`,
    ledger: due === null ? null : 'skillRuns',
    cooldownKey: null,
    manual: true,
  };
}
