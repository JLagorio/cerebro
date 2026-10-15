import type { ActivityWrite, AppSessionSpan, ConceptEvent } from '@/engine/activity';
import type {
  ChangesView,
  FleetRun,
  FleetRunDetail,
  LanesView,
  PipelineOverview,
  ReviewCard,
  RevertableApplication,
  RunWrite,
} from './mockIpc';

/**
 * The background concurrency ceiling's two ends (M33b.2), mirroring
 * `runtime::settings::{AMBIENT_CONCURRENCY_DEFAULT, AMBIENT_CONCURRENCY_MAX}`
 * — the maximum being Rust's `agent::MAX_CONCURRENT_RUNS`.
 *
 * They live in this module, which imports nothing at runtime, because both
 * the fixture below and the mock's own refusal in `mockIpc.ts` need them and
 * `mockIpc` already imports from here: one copy on this side of the wire, no
 * cycle. Writing the cap out twice in TypeScript is the twin-constant defect
 * `shared/policy/README.md` exists to prevent, and a real backend never reads
 * either of these — it sends its own value on `pipelineOverview`.
 */
export const AMBIENT_CONCURRENCY_DEFAULT = 1;
export const AMBIENT_CONCURRENCY_MAX = 4;

/**
 * The operational half of the golden corpus (M33.10).
 *
 * `demo-vault/` is a story about a team shipping guided onboarding, and every
 * RECORD surface reads against it. The operational surfaces had no such
 * corpus: `runs`, the review queue and the budget meter live in SQLite, which
 * the browser does not have, so the mock answered every one of them with an
 * empty array. That was defensible while those surfaces were doors — a door
 * looks the same whether or not anything is behind it — and stopped being
 * defensible the moment M33 turned them into bodies. A hub whose five
 * sections all say "nothing yet" cannot be evaluated, designed against, or
 * demoed.
 *
 * **These fixtures are chosen to exercise every state the UI must render**,
 * not to look impressive. Specifically each of the following appears exactly
 * because some component has a branch for it:
 *
 * - a run with `actor: null` → "unattributed" (a row written before M33.1)
 * - a run with `cause: null` → "why not recorded" (a row from before M56.7),
 *   and a scheduled run that started 45 minutes after it was due → "ran 45m
 *   late"
 * - a run with `usage_state: 'unknown'` → "unknown", never its zero columns
 * - a run with no cost rows → "not recorded", never $0
 * - a run whose proposal counters were never booked (`null`, pre-M49.9) →
 *   "proposals not recorded", never "0 applied"
 * - a run WITH cost rows, one of them `estimated` → the estimate marked
 * - a run with proposals still undecided → the door to the needs section
 * - all three constructs, so the actor filter has real options
 * - a `quota_failed` and an `abandoned_usage_unknown`, so outcome styling is
 *   visible without contriving one
 * - an addressed turn of the Knowledge agent that applied two concepts → the
 *   run, the agent's page and each concept's "Written by" telling one story
 *   (M52.3): the concepts are stamped `process:knowledge` at the times this
 *   run spans, as Rust stamps a run's writes with the run's actor
 * - a HIGH card whose target moved → the stale warning before anyone clicks
 * - a CRITICAL card → the diff-review mark
 * - a MEDIUM card the high-stakes rule holds → why it waits, beyond its risk
 * - an applied-but-undoable change → the revert list
 * - a scheduled run that was refused twice, with a model and a transcript
 *   (`demoTranscripts.ts`), and runs whose model was never recorded → the
 *   run detail's Model, Transcript and Refused rows (M56.9)
 *
 * **The dates are VAULT_TODAY's.** The corpus is read on 2026-07-28 (see
 * `e2e/boot.ts`), so these sit in the hours before it. A fixture stamped
 * "now" would drift out of the story the rest of the vault tells.
 */

/** The day the demo corpus is written to be read on, matching `e2e/boot.ts`. */
const DAY = '2026-07-28';

const at = (time: string) => `${DAY}T${time}:00Z`;

export function demoFleetRuns(): FleetRun[] {
  return [
    {
      run_id: 'run-assembly-1',
      actor: 'agent:m26-synthesis',
      vault_id: 'demo',
      mode: 'attended',
      lane: 'agent',
      started_at: at('11:42'),
      ended_at: at('11:43'),
      outcome: 'succeeded',
      usage_state: 'exact',
      input_tokens: 18_400,
      output_tokens: 1_120,
      proposals_submitted: 0,
      applied: 0,
      rejected: 0,
      parent_run_id: null,
      cause: {
        kind: 'assembly',
        why: 'assembling an answer',
        subject: null,
        detail: null,
        due_at: null,
      },
      cli_session_id: null,
    },
    {
      // Left work on the table: two of its three proposals are still waiting,
      // which is what earns the detail panel's door to the needs section.
      run_id: 'run-scout-1',
      actor: 'process:release-scout',
      vault_id: 'demo',
      mode: 'ambient',
      lane: 'scheduled',
      started_at: at('09:15'),
      ended_at: at('09:19'),
      outcome: 'succeeded',
      usage_state: 'exact',
      input_tokens: 12_060,
      output_tokens: 880,
      proposals_submitted: 3,
      applied: 1,
      rejected: 0,
      parent_run_id: null,
      // A schedule's fire at 08:30 that ran at 09:15 (M56.7): the fleet and
      // the agent's Runs tab say why, and that it ran 45m late.
      cause: {
        kind: 'schedule',
        why: 'its schedule came due',
        subject: null,
        detail: 'weekdays 08:30',
        due_at: '2026-07-28T08:30:00.000Z',
      },
      // Synthetic, in the shape Claude Code's stream names a session.
      cli_session_id: '00000000-0000-4000-8000-000000000001',
    },
    {
      // The Knowledge agent, asked in the panel (M52.3) — it is off duty in
      // the demo, so an addressed chat turn is the only way it runs. Its two
      // applied proposals are the two concepts stamped `process:knowledge`,
      // written at 09:05 and 09:26. The id predates the reattribution and is
      // kept: specs open this run by it.
      run_id: 'run-ingest-2',
      actor: 'process:knowledge',
      vault_id: 'demo',
      mode: 'attended',
      lane: 'agent',
      started_at: at('09:00'),
      ended_at: at('09:27'),
      outcome: 'succeeded',
      usage_state: 'exact',
      input_tokens: 9_240,
      output_tokens: 610,
      proposals_submitted: 2,
      applied: 2,
      rejected: 0,
      parent_run_id: null,
      cause: { kind: 'attended', why: 'you asked', subject: null, detail: null, due_at: null },
      cli_session_id: null,
    },
    {
      // The CLI died without reporting usage. Its token columns are zero and
      // that is NOT a measurement — the surface has to say "unknown".
      run_id: 'run-ingest-1',
      actor: 'agent:m26-ingest',
      vault_id: 'demo',
      mode: 'ambient',
      lane: 'behind',
      started_at: at('07:55'),
      ended_at: at('08:06'),
      outcome: 'abandoned_usage_unknown',
      usage_state: 'unknown',
      input_tokens: 0,
      output_tokens: 0,
      proposals_submitted: 0,
      applied: 0,
      rejected: 0,
      parent_run_id: null,
      cause: {
        kind: 'ingest',
        why: 'background ingest of new material',
        subject: null,
        detail: null,
        due_at: null,
      },
      cli_session_id: null,
    },
    {
      run_id: 'run-maint-1',
      actor: 'agent:m26-maintenance',
      vault_id: 'demo',
      mode: 'ambient',
      lane: 'stale',
      started_at: at('06:10'),
      ended_at: at('06:11'),
      outcome: 'succeeded',
      usage_state: 'exact',
      input_tokens: 4_300,
      output_tokens: 260,
      proposals_submitted: 1,
      applied: 0,
      rejected: 1,
      parent_run_id: null,
      cause: {
        kind: 'maintenance',
        why: "Cerebro's upkeep",
        subject: null,
        detail: null,
        due_at: null,
      },
      cli_session_id: null,
    },
    {
      run_id: 'run-chat-1',
      actor: null,
      vault_id: 'demo',
      mode: 'attended',
      lane: 'agent',
      started_at: at('05:48'),
      ended_at: at('05:49'),
      outcome: 'succeeded',
      usage_state: 'exact',
      input_tokens: 6_100,
      output_tokens: 540,
      proposals_submitted: 0,
      applied: 0,
      rejected: 0,
      parent_run_id: null,
      cause: { kind: 'attended', why: 'you asked', subject: null, detail: null, due_at: null },
      cli_session_id: null,
    },
    {
      // A row from before M33.1 added the column: nothing attributed it, and
      // nothing ever will. It renders "unattributed", which is the truth.
      // Nor did anything book its proposal counters (pre-M49.9), so they are
      // null — not recorded — rather than the zeros the row was inserted with.
      run_id: 'run-legacy-1',
      actor: null,
      vault_id: 'demo',
      mode: 'ambient',
      lane: 'refresh',
      started_at: at('04:20'),
      ended_at: at('04:21'),
      outcome: 'quota_failed',
      usage_state: 'exact',
      input_tokens: 800,
      output_tokens: 0,
      proposals_submitted: null,
      applied: null,
      rejected: null,
      parent_run_id: null,
      // Nor did anything record why it started (pre-M56.7): "why not recorded".
      cause: null,
      cli_session_id: null,
    },
  ];
}

/**
 * What each run changed in Knowledge (M50.3), keyed by run — one per state
 * the run detail renders: the Knowledge agent's turn that applied two
 * concepts names them, the synthesis run that applied nothing is
 * measured-at-zero, and every other run is absent, which is "not recorded",
 * never "changed nothing".
 */
export function demoRunWrites(): Record<string, RunWrite[]> {
  return {
    'run-ingest-2': [
      { path: 'knowledge/playbooks/warehouse-cutover.md', state: 'applied' },
      { path: 'knowledge/systems/pick-queue-drain.md', state: 'applied' },
    ],
    'run-assembly-1': [],
  };
}

export function demoFleetDetails(): Record<string, FleetRunDetail> {
  const runs = demoFleetRuns();
  const find = (id: string) => runs.find((r) => r.run_id === id) as FleetRun;
  return {
    // M31.6 measured this one. Five of its ten components, not all ten: the
    // panel has to read correctly for a partial recording too, and a fixture
    // that always carried the full set would never exercise that.
    'run-assembly-1': {
      run: find('run-assembly-1'),
      cost_components: [
        {
          component: 'uncached_input_tokens',
          unit: 'tokens',
          model_id: 'claude-opus-5',
          quantity: 3_900,
          observed_cost_micros: 58_500,
          estimated: false,
          pricing_snapshot_id: 'snap-2026-07',
          recorded_at: at('11:43'),
        },
        {
          component: 'cache_read_tokens',
          unit: 'tokens',
          model_id: 'claude-opus-5',
          quantity: 14_500,
          observed_cost_micros: 4_350,
          estimated: false,
          pricing_snapshot_id: 'snap-2026-07',
          recorded_at: at('11:43'),
        },
        {
          component: 'output_tokens',
          unit: 'tokens',
          model_id: 'claude-opus-5',
          quantity: 1_120,
          observed_cost_micros: 84_000,
          estimated: false,
          pricing_snapshot_id: 'snap-2026-07',
          recorded_at: at('11:43'),
        },
        {
          component: 'retrieval_calls',
          unit: 'calls',
          model_id: null,
          quantity: 6,
          observed_cost_micros: null,
          estimated: false,
          pricing_snapshot_id: null,
          recorded_at: at('11:43'),
        },
        {
          // Derived, not measured — and the surface says so rather than
          // letting it read as a reading.
          component: 'selected_context_tokens',
          unit: 'tokens',
          model_id: 'claude-opus-5',
          quantity: 8_800,
          observed_cost_micros: null,
          estimated: true,
          pricing_snapshot_id: null,
          recorded_at: at('11:43'),
        },
      ],
      assembly: {
        manifest_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        intended_stakes: 'MEDIUM',
        source_count: 6,
        evidence_item_count: 11,
        context_bytes: 42_880,
        retrieval_query_count: 4,
        blocked_intent_count: 0,
        answer_latency_micros: 3_412_000,
        recorded_at: at('11:43'),
      },
      model_id: 'claude-opus-5',
      refusals: [],
      refusals_total: 0,
      // An answer writes no page, and its writes were booked: measured.
      wrote: { state: 'recorded', writes: [] },
    },
    // Ambient runs are outside M31.6's attended writer, so nothing recorded
    // their cost. "Not recorded" — never $0.
    //
    // release-scout's run was refused twice (M56.9): a write outside its
    // scope, and a built-in its grant does not hold. Both are rows recorded
    // with its run id, as Rust's scope check and permission sink write them.
    // The one page it did write, inside its scope, is booked (M58.1b).
    'run-scout-1': {
      ...unrecorded(find('run-scout-1'), 'claude-opus-5'),
      refusals: [
        {
          code: 'write_outside_scope',
          surface: 'create_note',
          detail: 'This run is scoped to records/risks and cannot write to records/work.',
          rule: null,
          recorded_at: '2026-07-28T09:18:00.000Z',
        },
        {
          code: 'capability_unavailable',
          surface: 'agent.permission',
          detail: 'the CLI denied 1 call(s) this run: Bash',
          rule: null,
          recorded_at: '2026-07-28T09:18:30.000Z',
        },
      ],
      refusals_total: 2,
      wrote: {
        state: 'recorded',
        writes: [
          {
            kind: 'vault.write',
            path: 'records/risks/risk-scanner-delivery.md',
            to: null,
            at: '2026-07-28T09:17:00.000Z',
            approved_by: null,
          },
        ],
      },
    },
    'run-ingest-2': unrecorded(find('run-ingest-2'), 'claude-opus-5'),
    // The CLI died before its stream named a model: not recorded.
    'run-ingest-1': unrecorded(find('run-ingest-1'), null),
    'run-maint-1': unrecorded(find('run-maint-1'), 'claude-opus-5'),
    'run-chat-1': unrecorded(find('run-chat-1'), 'claude-opus-5'),
    // From before anything recorded a model: not recorded.
    'run-legacy-1': unrecorded(find('run-legacy-1'), null),
  };
}

/**
 * The row a mock run books when its shell ceiling is Ask and nobody can
 * answer it (M57.2): the run, and its detail with the one
 * `capability_unavailable` row under `agent.ask` that Rust's meter writes,
 * naming the tools it went without. No seeded fleet holds one; a mock run
 * books it as it starts (`agentIpc.runAgent`).
 */
export function withheldRun(fields: {
  runId: string;
  actor: string | null;
  mode: string;
  lane: string;
  sessionId: string;
  at: string;
  detail: string;
}): FleetRunDetail {
  const run: FleetRun = {
    run_id: fields.runId,
    actor: fields.actor,
    vault_id: null,
    mode: fields.mode,
    lane: fields.lane,
    started_at: fields.at,
    ended_at: null,
    outcome: 'running',
    // The browser counts no tokens: unknown, never zero.
    usage_state: 'unknown',
    input_tokens: 0,
    output_tokens: 0,
    proposals_submitted: null,
    applied: null,
    rejected: null,
    parent_run_id: null,
    cause: null,
    cli_session_id: fields.sessionId,
  };
  return {
    ...unrecorded(run, null),
    refusals: [
      {
        code: 'capability_unavailable',
        surface: 'agent.ask',
        detail: fields.detail,
        rule: null,
        recorded_at: fields.at,
      },
    ],
    refusals_total: 1,
  };
}

/** A browser pre-run check: one booked row, with no invented usage or model. */
export function conditionRun(fields: {
  runId: string;
  vault: string;
  actor: string;
  at: string;
  cause: FleetRun['cause'];
  parent: string | null;
}): FleetRunDetail {
  const detail = withheldRun({
    runId: fields.runId,
    actor: fields.actor,
    mode: 'ambient',
    lane: 'agent',
    sessionId: fields.runId,
    at: fields.at,
    detail: '',
  });
  return {
    ...detail,
    run: {
      ...detail.run,
      vault_id: fields.vault,
      parent_run_id: fields.parent,
      ended_at: fields.at,
      outcome: 'succeeded',
      cause: fields.cause,
    },
    refusals: [],
    refusals_total: 0,
    wrote: { state: 'recorded', writes: [] },
  };
}

/** A detail with no cost or assembly rows recorded, nothing refused, and
 * writes not booked: every demo run but two is from before M58.1 booked
 * them, and a mock run's writes are logged under its attach id, never under
 * its fleet row's. */
function unrecorded(run: FleetRun, model: string | null): FleetRunDetail {
  return {
    run,
    cost_components: null,
    assembly: null,
    model_id: model,
    refusals: [],
    refusals_total: 0,
    wrote: { state: 'not_recorded' },
  };
}

export function demoReviewCards(): ReviewCard[] {
  return [
    {
      submitted_at: '2026-07-28T11:58:00Z',
      proposal_id: 'p0000000000000000000000000000001',
      commit_set_id: 'c0000000000000000000000000000001',
      run_id: 'run-scout-1',
      actor: 'process:release-scout',
      op: 'update_belief',
      effective_risk: 'HIGH',
      review: null,
      queued_for: ['high_stakes_verification_required'],
      intended_use_kind: 'ReversibleWork',
      intended_use_stakes: 'HIGH',
      transition_cause: 'new_evidence',
      evidence_refs: ['e1', 'e2', 'e3'],
      coverage_refs: ['c1'],
      authority_refs: [],
      targets: [
        {
          target_class: 'belief',
          target_id: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1',
          expected_version: 3,
          // Moved underneath the proposal while it waited: the card has to
          // say so BEFORE anyone clicks approve.
          current_version: 4,
          stale: true,
          // The concept it is (M50.3) — the card names it and opens it.
          path: 'knowledge/systems/offline-guarantee.md',
        },
      ],
      // About the concept it targets (M52.5): its reason was the sync error
      // rate's, on a card that revises the offline guarantee.
      reason: 'three field reports show devices syncing after four days offline, not three',
      set_members: ['p0000000000000000000000000000001'],
      set_ready: true,
    },
    {
      submitted_at: '2026-07-28T11:58:00Z',
      proposal_id: 'p0000000000000000000000000000002',
      commit_set_id: 'c0000000000000000000000000000002',
      run_id: 'run-scout-1',
      actor: 'process:release-scout',
      op: 'tombstone_belief',
      effective_risk: 'CRITICAL',
      // The CRITICAL rung's review mode: this one is read as a diff.
      review: 'diff',
      queued_for: [],
      // Codes the schema can hold (M52.4): `IntendedUseKind` and
      // `TransitionCause` have no `IrreversibleWork` or `superseded`, and a
      // fixture that invented them showed words no real card could carry.
      intended_use_kind: 'ProductionRelease',
      intended_use_stakes: 'CRITICAL',
      transition_cause: 'new_evidence',
      evidence_refs: ['e4'],
      coverage_refs: [],
      authority_refs: ['a1'],
      targets: [
        {
          target_class: 'belief',
          target_id: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
          expected_version: 1,
          current_version: 1,
          stale: false,
          path: 'knowledge/metrics/webinar-attendance.md',
        },
      ],
      reason: 'the onboarding walkthrough this described was replaced in the Q3 rewrite',
      set_members: ['p0000000000000000000000000000002'],
      set_ready: true,
    },
    {
      submitted_at: '2026-07-28T11:58:00Z',
      proposal_id: 'p0000000000000000000000000000003',
      commit_set_id: 'c0000000000000000000000000000003',
      run_id: 'run-maint-1',
      actor: 'agent:m26-maintenance',
      // A real op (`add_relation` is not one — linking is `edit_relation`),
      // at the table's MEDIUM base risk. It waits anyway: it is meant for an
      // operational decision at HIGH stakes, so the high-stakes rule queues
      // it — the demo's one MEDIUM chip, and a card that waits for a reason
      // other than its risk.
      op: 'edit_relation',
      effective_risk: 'MEDIUM',
      review: null,
      queued_for: ['high_stakes_verification_required'],
      intended_use_kind: 'OperationalDecision',
      intended_use_stakes: 'HIGH',
      transition_cause: 'maintenance',
      evidence_refs: ['e5', 'e6'],
      coverage_refs: ['c2', 'c3'],
      authority_refs: [],
      // A link between two concepts the demo holds, named at both ends
      // (M52.5) — the card read "Change a link" and named neither. Its
      // targets are Rust's (`policy::review` builds an `edit_relation` card
      // this way): both linked beliefs, sorted by id, each naming its
      // concept file, then the relation itself — so each end's page and row
      // shows the card, as they do against the real queue.
      targets: [
        {
          target_class: 'belief',
          target_id: 'b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4',
          expected_version: 1,
          current_version: 1,
          stale: false,
          path: 'knowledge/systems/pick-queue-drain.md',
        },
        {
          target_class: 'belief',
          target_id: 'b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5',
          expected_version: 1,
          current_version: 1,
          stale: false,
          path: 'knowledge/playbooks/warehouse-cutover.md',
        },
        {
          target_class: 'relation',
          target_id: 'r3r3r3r3r3r3r3r3r3r3r3r3r3r3r3r3',
          expected_version: null,
          current_version: null,
          stale: false,
          link: {
            action: 'add',
            relation: 'refines',
            from_path: 'knowledge/systems/pick-queue-drain.md',
            to_path: 'knowledge/playbooks/warehouse-cutover.md',
          },
        },
      ],
      reason:
        'the cutover window is sized by how long the pick queue takes to drain, so the drain time narrows the playbook',
      set_members: ['p0000000000000000000000000000003'],
      set_ready: true,
    },
  ];
}

/** A revise already applied and still undoable, naming the concept it
 * changed (M52.5), as Rust's `revertable` does. The demo has no churn
 * concept, and "corrected the churn definition" named nothing on screen. */
export function demoRevertables(): RevertableApplication[] {
  return [
    {
      proposal_id: 'p0000000000000000000000000000009',
      op: 'update_belief',
      applied_event_id: 'e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9',
      reason: 'counted only conflicts a person still has to resolve',
      path: 'knowledge/metrics/sync-error-rate.md',
    },
  ];
}

/**
 * A day with real spend on it, one open notice, and nothing held.
 *
 * The ceiling is deliberately `under_budget` with visible usage: a meter
 * pinned at zero cannot show whether its bars work, and one pinned at the
 * ceiling would make the ordinary case look like the alarming one.
 */
export function demoPipelineOverview(lanes: string[]): PipelineOverview {
  return {
    global_pause: false,
    // The shipped ceiling, because the demo shows the app as it arrives
    // (M33b.2) — a demo vault with the concurrency already raised would be
    // showing a decision nobody made.
    ambient_concurrency: AMBIENT_CONCURRENCY_DEFAULT,
    ambient_concurrency_max: AMBIENT_CONCURRENCY_MAX,
    runtime_status: 'ready',
    meter: {
      window_start_utc: `${DAY}T00:00:00.000Z`,
      window_end_utc: '2026-07-29T00:00:00.000Z',
      timezone_id: 'UTC',
      ceiling_state: 'under_budget',
      ceiling_reasons: [],
      accounting_state: 'exact',
      runs_started: 7,
      max_daily_runs: 20,
      tokens_used: 51_760,
      max_daily_tokens: 200_000,
      output_tokens_used: 3_410,
      max_daily_output_tokens: 40_000,
      reserved_total_tokens: 0,
      reserved_output_tokens: 0,
    },
    lanes: lanes.map((lane, priority) => ({ lane, priority, enabled: true })),
    // The fleet section owns run history now (M33.4/M33.5); the overview's
    // own activity list stays empty rather than becoming a second one.
    activity: [],
    banners: [
      {
        kind: 'ingestion',
        // The count is the banner's to say, once: "two notes … — 2 items"
        // said it twice.
        detail: 'notes that could not be parsed were left alone',
        count: 2,
      },
    ],
    held: { baseline_held: 0, recovery_held: 0, pending_review: 3, pending: 0 },
  };
}

/** Ledger ids are 32 hex characters, never slugs (M52.4): a fixture that
 * named an entity `sync-error-rate` let the surface pass by matching a file
 * name the real wire never sends. These pair with each concept's `path`. */
const SYNC_BELIEF = 'b'.repeat(32);
const SYNC_ENTITY = 'e1'.repeat(16);
const ONBOARDING_ENTITY = 'e2'.repeat(16);

/**
 * The four attention lanes, with one item where it teaches something.
 *
 * Every sentence here is normally COMPOSED IN RUST, beside the rule that
 * produced it — `reason_text`, `scope_text`, `reliance_text`, `empty_text`.
 * The fixture repeats those sentences VERBATIM rather than inventing a
 * UI-side vocabulary: the lane words are `attention::status::lane_words`,
 * character for character (M52.3), because a mock that phrased these itself
 * would be the twin-implementation defect — the surface would look right here
 * and wrong against the real command. Until M52.3 it did exactly that: "Gone
 * stale" and "Owed work" here, "Stale understanding" and "Epistemic debt"
 * there.
 *
 * Three lanes are deliberately EMPTY. A lane that only appeared when it had
 * contents would make "no coverage gaps" and "coverage was never computed"
 * the same screen, and the empty sentence is each lane's own words.
 */
export function demoLanes(): LanesView {
  const lane = (
    id: string,
    label: string,
    blurb: string,
    emptyText: string,
    isProtected: boolean,
    items: LanesView['lanes'][number]['items'] = [],
    withheld = 0,
  ) => ({ id, label, blurb, empty_text: emptyText, protected: isProtected, items, withheld });

  return {
    rule_version: 'lanes-v1',
    lanes: [
      lane(
        'contradiction',
        'Contradictions',
        'Two things Knowledge holds that cannot both be true.',
        'No open contradictions.',
        true,
      ),
      lane(
        'blindness',
        'Gaps',
        'Where Knowledge looked for evidence and found none, and how much nobody has checked yet.',
        'No gaps.',
        true,
      ),
      lane(
        'staleness',
        'Due a recheck',
        'Past the date it was due to be rechecked. Not wrong — unchecked.',
        'Nothing is due a recheck.',
        false,
        [
          {
            lane: 'staleness',
            belief_id: SYNC_BELIEF,
            entity_id: SYNC_ENTITY,
            path: 'metrics/sync-error-rate.md',
            predicate: 'ci_status',
            state_stage: 'implemented',
            // Its belief's only facet, so no scope: Rust's `view` leaves a
            // sole facet's unsaid (M52.5) — the belief's scope is its own.
            scope_text: null,
            reasons: ['freshness_stale'],
            reason_text: 'past its recheck date',
            reliance: ['qualified'],
            reliance_text: 'Relied on — it is no longer a draft',
            edge_id: null,
            relation_id: null,
          },
        ],
      ),
      lane(
        'epistemic_debt',
        'Taken on trust',
        'What Knowledge is relied on for but cannot yet back with evidence.',
        'Nothing is taken on trust.',
        false,
      ),
    ],
    // Nothing held back: with the default attention settings a lane holds
    // back only past its first ten, and this one lists one. "2 more not
    // shown" beside a single row was a count no real answer could carry.
    withheld: 0,
    incomplete: [],
  };
}

/** A window in which two things actually moved. `quiet: false` is M26's own
 * answer to "did anything move", not a recount of the sections below it.
 *
 * Rust's shape, verbatim (M52.4): all five of `attention::status::
 * change_sections`' sections in its order, under its labels and empty lines,
 * and lines whose text Rust can compose — a predicate that follows the
 * concept's name. Until M52.4 this sent three sections, one of them an id
 * Rust has never had ("coverage"), with sentences no `match` arm writes. */
export function demoChanges(): ChangesView {
  return {
    changed_at: '2026-07-28T09:26:00.000Z',
    schema_version: 'convergence-v1',
    window: { from_seq: 118, to_seq: 147 },
    quiet: false,
    sections: [
      {
        id: 'material',
        label: 'Concepts that changed',
        empty_text: 'No concept changed.',
        lines: [
          {
            // Revised + QualificationChanged, joined as Rust joins them.
            text: 'was revised, changed its draft status',
            belief_id: SYNC_BELIEF,
            entity_id: SYNC_ENTITY,
            path: 'metrics/sync-error-rate.md',
          },
        ],
      },
      {
        id: 'blindness',
        label: 'What came into and out of view',
        empty_text: 'Nothing changed about what can be seen.',
        lines: [
          {
            // Entity-only, as `SubjectNoLongerBlind` is: the path is the
            // entity's projected concept, which the surface names.
            text: 'is no longer a gap — 2 checks now cover it',
            belief_id: null,
            entity_id: ONBOARDING_ENTITY,
            path: 'metrics/onboarding-completion.md',
          },
        ],
      },
      { id: 'staleness', label: 'Evidence', empty_text: 'No evidence moved.', lines: [] },
      { id: 'certainty', label: 'Support', empty_text: 'No support changed.', lines: [] },
      {
        id: 'contestation',
        label: 'New contradictions',
        empty_text: 'No new contradictions opened.',
        lines: [],
      },
    ],
  };
}

/** The demo's History lanes (M64.2), as runtime.db's `vault_writes` and
 * `app_sessions` would hold them. `content` is left to the mock, which sets
 * it from `CONTENT_KINDS` as Rust does. */
export interface DemoActivity {
  writes: Omit<ActivityWrite, 'content'>[];
  sessions: AppSessionSpan[];
}

/**
 * When Cerebro had the demo vault open, and who wrote what (M64.2).
 *
 * Each row is here because History has a branch for it:
 *
 * - Cerebro open 2026-07-20 to 07-24 and on 07-27, 08:00–18:00Z, and on
 *   07-28 from 08:00Z, still open (the mock reads it up to its clock), so
 *   07-25 and 07-26 read "not recorded";
 * - recording begins 07-21 with an edit whose writer nobody stamped (a row
 *   from before M58.1), so 07-20 reads "not recorded" though Cerebro was open,
 *   and 07-22 to 07-24 read "no edits";
 * - two of your sessions on 07-27, eight minutes apart, so the fold splits
 *   them;
 * - on 07-28 the Knowledge agent's addressed turn (run-ingest-2) writes its
 *   two concepts at the times `demoFleetRuns` gives them, and the release
 *   scout's run (run-scout-1) writes the risk page its run detail names.
 *
 * These rows stay out of the mock's live write log (`__cerebroMockWrites`),
 * so a page's last change (M58.1b) reads only what a spec wrote.
 */
export function demoActivity(): DemoActivity {
  const row = (
    path: string,
    actor: string | null,
    runId: string | null,
    firstAt: string,
    at: string,
  ): Omit<ActivityWrite, 'content'> => ({
    kind: 'vault.write',
    path,
    to: null,
    actor,
    run_id: runId,
    approved_by: null,
    first_at: firstAt,
    at,
  });
  const span = (day: string): AppSessionSpan => ({
    opened_at: `${day}T08:00:00.000Z`,
    until: `${day}T18:00:00.000Z`,
    precision: 'clean_exact',
  });
  return {
    writes: [
      row(
        'records/risks/risk-scanner-delivery.md',
        'process:release-scout',
        'run-scout-1',
        '2026-07-28T09:16:00.000Z',
        '2026-07-28T09:18:00.000Z',
      ),
      row(
        'knowledge/systems/pick-queue-drain.md',
        'process:knowledge',
        'run-ingest-2',
        '2026-07-28T09:26:00.000Z',
        '2026-07-28T09:26:00.000Z',
      ),
      row(
        'knowledge/playbooks/warehouse-cutover.md',
        'process:knowledge',
        'run-ingest-2',
        '2026-07-28T09:05:00.000Z',
        '2026-07-28T09:05:00.000Z',
      ),
      row(
        'delivery/delivery.md',
        'human:me',
        null,
        '2026-07-27T14:20:00.000Z',
        '2026-07-27T14:31:00.000Z',
      ),
      row(
        'records/risks/risk-rollback-unrehearsed.md',
        'human:me',
        null,
        '2026-07-27T14:00:00.000Z',
        '2026-07-27T14:12:00.000Z',
      ),
      row(
        'delivery/how-we-schedule.md',
        null,
        null,
        '2026-07-21T10:00:00.000Z',
        '2026-07-21T10:04:00.000Z',
      ),
    ],
    sessions: [
      {
        opened_at: '2026-07-28T08:00:00.000Z',
        until: '2026-07-28T08:00:00.000Z',
        precision: 'open',
      },
      span('2026-07-27'),
      span('2026-07-24'),
      span('2026-07-23'),
      span('2026-07-22'),
      span('2026-07-21'),
      span('2026-07-20'),
    ],
  };
}

/**
 * What the demo's ledger recorded about two concepts (M64.2b), for a
 * concept page's History. The browser keeps no ledger, so these stand in for
 * `page_activity`'s Knowledge lane: the Knowledge agent's addressed turn
 * (run-ingest-2) created both, at the times `demoActivity` writes them, and
 * its proposals applied. Every other bundle path reads not recorded.
 */
export function demoConceptHistory(): Record<string, ConceptEvent[]> {
  const created = (id: string, at: string): ConceptEvent[] => [
    {
      event_id: `demo-created-${id}`,
      kind: 'created',
      revision: null,
      state: null,
      actor: 'process:knowledge',
      run_id: 'run-ingest-2',
      at,
    },
    {
      event_id: `demo-proposal-${id}`,
      kind: 'proposal',
      revision: null,
      state: 'applied',
      actor: 'process:knowledge',
      run_id: 'run-ingest-2',
      at,
    },
  ];
  return {
    'knowledge/playbooks/warehouse-cutover.md': created(
      'warehouse-cutover',
      '2026-07-28T09:05:00.000Z',
    ),
    'knowledge/systems/pick-queue-drain.md': created(
      'pick-queue-drain',
      '2026-07-28T09:26:00.000Z',
    ),
  };
}
