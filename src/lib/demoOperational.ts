import type {
  ChangesView,
  FleetRun,
  FleetRunDetail,
  LanesView,
  PipelineOverview,
  ReviewCard,
  RevertableApplication,
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
 * - a run with `usage_state: 'unknown'` → "unknown", never its zero columns
 * - a run with no cost rows → "not recorded", never $0
 * - a run WITH cost rows, one of them `estimated` → the estimate marked
 * - a run with proposals still undecided → the door to the needs section
 * - all three constructs, so the actor filter has real options
 * - a `quota_failed` and an `abandoned_usage_unknown`, so outcome styling is
 *   visible without contriving one
 * - a HIGH card whose target moved → the stale warning before anyone clicks
 * - a CRITICAL card → the diff-review mark
 * - an applied-but-undoable change → the revert list
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
    },
    {
      run_id: 'run-ingest-2',
      actor: 'agent:m26-ingest',
      vault_id: 'demo',
      mode: 'ambient',
      lane: 'filed',
      started_at: at('08:30'),
      ended_at: at('08:32'),
      outcome: 'succeeded',
      usage_state: 'exact',
      input_tokens: 9_240,
      output_tokens: 610,
      proposals_submitted: 2,
      applied: 2,
      rejected: 0,
      parent_run_id: null,
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
    },
    {
      // A row from before M33.1 added the column: nothing attributed it, and
      // nothing ever will. It renders "unattributed", which is the truth.
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
      proposals_submitted: 0,
      applied: 0,
      rejected: 0,
      parent_run_id: null,
    },
  ];
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
    },
    // Ambient runs are outside M31.6's attended writer, so nothing recorded
    // their cost. "Not recorded" — never $0.
    'run-scout-1': { run: find('run-scout-1'), cost_components: null, assembly: null },
    'run-ingest-2': { run: find('run-ingest-2'), cost_components: null, assembly: null },
    'run-ingest-1': { run: find('run-ingest-1'), cost_components: null, assembly: null },
    'run-maint-1': { run: find('run-maint-1'), cost_components: null, assembly: null },
    'run-chat-1': { run: find('run-chat-1'), cost_components: null, assembly: null },
    'run-legacy-1': { run: find('run-legacy-1'), cost_components: null, assembly: null },
  };
}

export function demoReviewCards(): ReviewCard[] {
  return [
    {
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
        },
      ],
      reason: 'the sync error rate has been above its threshold for six days, not two',
      set_members: ['p0000000000000000000000000000001'],
      set_ready: true,
    },
    {
      proposal_id: 'p0000000000000000000000000000002',
      commit_set_id: 'c0000000000000000000000000000002',
      run_id: 'run-scout-1',
      actor: 'process:release-scout',
      op: 'tombstone_belief',
      effective_risk: 'CRITICAL',
      // The CRITICAL rung's review mode: this one is read as a diff.
      review: 'diff',
      queued_for: [],
      intended_use_kind: 'IrreversibleWork',
      intended_use_stakes: 'CRITICAL',
      transition_cause: 'superseded',
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
        },
      ],
      reason: 'the onboarding walkthrough this described was replaced in the Q3 rewrite',
      set_members: ['p0000000000000000000000000000002'],
      set_ready: true,
    },
    {
      proposal_id: 'p0000000000000000000000000000003',
      commit_set_id: 'c0000000000000000000000000000003',
      run_id: 'run-maint-1',
      actor: 'agent:m26-maintenance',
      op: 'add_relation',
      effective_risk: 'MEDIUM',
      review: null,
      queued_for: [],
      intended_use_kind: 'ReversibleWork',
      intended_use_stakes: 'LOW',
      transition_cause: 'freshness_recheck',
      evidence_refs: ['e5', 'e6'],
      coverage_refs: ['c2', 'c3'],
      authority_refs: [],
      targets: [
        {
          target_class: 'relation',
          target_id: 'r3r3r3r3r3r3r3r3r3r3r3r3r3r3r3r3',
          expected_version: null,
          current_version: null,
          stale: false,
        },
      ],
      reason:
        'the retention metric and the activation metric move together in every window measured',
      set_members: ['p0000000000000000000000000000003'],
      set_ready: true,
    },
  ];
}

export function demoRevertables(): RevertableApplication[] {
  return [
    {
      proposal_id: 'p0000000000000000000000000000009',
      op: 'update_belief',
      applied_event_id: 'e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9e9',
      reason: 'corrected the churn definition to exclude trialists',
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
        detail: 'two notes could not be parsed and were left alone',
        count: 2,
      },
    ],
    held: { baseline_held: 0, recovery_held: 0, pending_review: 3, pending: 0 },
  };
}

/**
 * The four attention lanes, with one item where it teaches something.
 *
 * Every sentence here is normally COMPOSED IN RUST, beside the rule that
 * produced it — `reason_text`, `scope_text`, `reliance_text`, `empty_text`.
 * The fixture repeats that shape rather than inventing a UI-side vocabulary,
 * because a mock that phrased these itself would be the twin-implementation
 * defect: the surface would look right here and wrong against the real
 * command.
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
        'Two things this base believes that cannot both be true.',
        'Nothing is contested.',
        true,
      ),
      lane(
        'blindness',
        'What it cannot see',
        'Questions this base has no evidence either way about.',
        'No gaps it can name.',
        true,
      ),
      lane(
        'staleness',
        'Gone stale',
        'Beliefs past the freshness their own rule asked for.',
        'Nothing has gone stale.',
        false,
        [
          {
            lane: 'staleness',
            belief_id: 'b'.repeat(32),
            entity_id: 'sync-error-rate',
            path: 'metrics/sync-error-rate.md',
            predicate: 'ci_status',
            state_stage: 'implemented',
            scope_text: 'ci_status at implemented',
            reasons: ['freshness_stale'],
            reason_text: 'past its freshness rule',
            reliance: ['qualified'],
            reliance_text: 'relied on: promoted past draft',
            edge_id: null,
            relation_id: null,
          },
        ],
        2,
      ),
      lane(
        'epistemic_debt',
        'Owed work',
        'What was accepted on the promise of evidence that never came.',
        'Nothing is owed.',
        false,
      ),
    ],
    withheld: 2,
    incomplete: [],
  };
}

/** A window in which two things actually moved. `quiet: false` is M26's own
 * answer to "did anything move", not a recount of the sections below it. */
export function demoChanges(): ChangesView {
  return {
    schema_version: 'convergence-v1',
    window: { from_seq: 118, to_seq: 147 },
    quiet: false,
    sections: [
      {
        id: 'material',
        label: 'Beliefs that moved',
        empty_text: 'No beliefs moved.',
        lines: [
          {
            // The surface prints the entity ahead of this line, so the line
            // does not restate it — "sync-error-rate the sync error rate was
            // …" is what happens when a fixture forgets that.
            text: 'was promoted from draft to implemented on two new measurements',
            belief_id: 'b'.repeat(32),
            entity_id: 'sync-error-rate',
          },
        ],
      },
      {
        id: 'contestation',
        label: 'New contradictions',
        empty_text: 'No new contradictions opened.',
        lines: [],
      },
      {
        id: 'coverage',
        label: 'What it can now see',
        empty_text: 'No coverage changed.',
        lines: [
          {
            text: 'gained a second independent source, classified firsthand',
            belief_id: 'c'.repeat(32),
            entity_id: 'activation-rate',
          },
        ],
      },
    ],
  };
}
