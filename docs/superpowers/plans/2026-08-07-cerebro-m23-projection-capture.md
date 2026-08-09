# M23 — knowledge/ flips to projection-first; the capture valve

**Brief for the agent picking this up cold.** Written 2026-08-07. Read the
master roadmap D1, D4, D8, coverage matrix rows §14, §22, §32, §34, §64 (§22
and §32 are discharged by the projection flip itself), the M22 plan,
and the companion design
`../specs/2026-08-08-cerebro-m23-projection-capture-design.md`. The design owns
event/manifest semantics; this plan owns sequence and acceptance.

M23 is the inversion moment. After it, `knowledge/*.md` is a deterministic
projection of reducer state. Human edits are preserved by translating them into
canonical events; changing a manifest hash is never a substitute for capture.

---

## Where things stand (verify at start — refs drift)

- M22 landed body schema 1 under unchanged frame `v: 0`, tagged Observations,
  explicit Belief basis, positive independence facts, logical batches,
  conformance vectors, byte-stable `project()`, and append-once migration.
- M22's migrator is proven but not armed. `migration.completed` is a fast guard;
  deterministic per-output keys are restart/prefix guards.
- `write_concept` and `verify_concept` still mutate markdown. M21's watcher hash
  cache and shadow events remain active.
- M21 detects anchor/head anomalies but left the named reconciliation mode and
  exit actions to this milestone.

## Non-goals (defend these)

- No declarative policy, general risk ladder, or `submitProposal`. M24.
- No capture outside `knowledge/`; `records/` and `docs/` stay vault plane.
- No LLM edit classification. Parse/diff is deterministic; ambiguity refuses.
- No perfect restore claim. Detection is layered best effort.
- No MCP surface change. Same tools, argument schemas, and response prose.
- No UI beyond attestation rN state, assertion authority/correction affordances,
  and the reconciliation banner/actions.

## Rules that must survive implementation

**Capture is assertion plus effect.** Every structured human edit produces one
human Observation per epistemic effect and one Belief revision in a single M22
logical batch. Ordinary fields pair with revision patches; relations and alias
additions pair with their exact events and use the same revision's replacement
basis. The batch marker is fsynced before acknowledgement.

**Editorial is canonical projection state, never evidence.** An override must
reproduce the edited bytes and survive rebuild, but it cannot appear in
Observation lineage, Belief basis, support, or independence.

**Three-way reconciliation.** Every launch compares file (F), manifest (M), and
fresh reducer projection (R), including revision and generating event. File vs
manifest alone cannot detect a ledger-ahead crash.

**mtime is never evidence.** No capture/reconciliation branch reads it.

## Fixed M23 event and manifest contracts

Implement the exact design bodies for:

- `projection.overridden`: Belief/path, base revision/generating event,
  before/after projection hashes, origin, and tagged set-or-clear change. Set
  patches are restricted to projection-only pointers and contain typed
  before/after; clear names active override events. Belief revision marks an
  existing overlay stale rather than silently clearing it.
- `ledger.divergence`: stable detection key, closed signal list, current and
  surviving anchor heads, manifest/reducer digests, counts, sorted samples.
- `ledger.reconciliation_resolved`: active divergence ID, explicit action,
  sorted affected paths, capture batch IDs, nullable accepted-files digest, and
  resulting digest. For accept, the capture list is exactly the singleton current
  batch and accepted/resulting path digests match. For restore, the event is
  unbatched, the list is empty, and accepted-files digest is null.

All have M22 common body fields and use the M22 batch/idempotency rules. Add
index tables `projection_overrides` and `reconciliation_state`; both must rebuild
from the ledger. Reducer semantics are exact:

- override set/clear changes only the projection overlay;
- divergence opens one active reconciliation mode;
- resolution closes it only if it references that event and staged/current
  projection equality proves the declared result;
- uncommitted M23 batches do nothing.

Every valid `projection.overridden` set/supersede/clear increments the M22
`belief` target version once. Divergence/resolution mutate global reconciliation
state and have no registered-target version effect. Vectors assert those effects
and no-effects, including uncommitted/refused bodies.

The closed divergence signals are anchor regression, remembered-head
regression, manifest/reducer disagreement, mass projection mismatch,
`migration_source_changed`, and `migration_idempotency_conflict`. Migration
signals key detection from M22 epoch/source/key digests; before an initial
manifest exists they use its canonical empty digest.

Manifest format 1 entry:

```json
{
  "belief_id": "<id>",
  "projected_revision": 4,
  "belief_revision_event": "<belief-created-or-revised-event-id>",
  "generating_event": "<highest-seq projection-state transition event-id>",
  "projection_state_digest": "<canonical projection-state descriptor hash>",
  "content_hash": "<sha256>",
  "write_state": "complete",
  "previous_content_hash": null
}
```

Writes atomically store `pending` target + prior hash, write the file, then mark
`complete`. The projector returns bytes/hash plus belief ID, revision, revision
event, current generating event, projection-state descriptor/digest, and active
override IDs. The descriptor includes the current revision; review events;
relation transition heads, including removes; live alias events; active overrides;
and the latest override transition, including clear. Its highest-seq event is
`generating_event`, so a byte-identical attestation/relation/override transition
cannot rewind projection identity.

## Phases

One commit per phase, `type(scope): sentence (M23.n)`.

### M23.0 — Arm restart-idempotent migration

After ledger recovery on open:

1. use matching `migration.completed` as the fast no-op;
2. otherwise resume M22 migration via deterministic per-output `append_once`;
3. refuse a changed source digest/key conflict into reconciliation under its
   typed migration signal;
4. after completion, compare files to reducer projection before creating the
   initial complete manifest.

Kill after every output and after completed-marker fsync. Reopen must append
only missing outputs. If completion exists but initial manifest does not, build
it only when file/reducer bytes agree. Assert the first post-open scan queues no
distill work.

### M23.1 — M23 schema/reducer vectors + projection overlay

Add Rust bodies and reducer/index support for all three event kinds above.
Extend the TypeScript conformance reducer from the same vectors. Cover:

- override set, supersede, clear, wrong base, before mismatch, illegal pointer;
- override changes projected bytes but creates no basis/lineage/support;
- full projection identity after attestation, relation add/remove, alias add, and
  override set/supersede/clear, including byte-identical advances;
- divergence idempotency/open mode, including a second detection key absorbed
  by the already-open mode without a second mode entry;
- wrong/stale resolution refusal and valid close;
- action-specific resolution field/digest rules;
- every event uncommitted vs validly batch-committed, with its complete target-
  version map.

Extend `project()` to apply active presentation overlays after canonical Belief
rendering and return the full projection identity tuple. A rebuild must reproduce
the same overlay bytes and reconciliation state.

### M23.2 — Crash-recoverable manifest and three-way classifier

Implement projection-manifest parsing/atomic writes and the pending protocol:

1. manifest target tuple + `pending` + prior file hash;
2. projection file write;
3. manifest `complete`.

Build a pure F/M/R classifier with table-driven tests:

| Relationship | Result |
|---|---|
| F = M = R complete | match |
| pending M = R; F prior/missing | interrupted own write → regenerate |
| pending M = R; F target | interrupted finalize → mark complete |
| M = R; valid F differs | out-of-band edit |
| M is ancestor of R; F = M | ledger ahead → regenerate R |
| M is ancestor of R; F = R | ledger ahead → advance M |
| R exists; M/F absent | ledger ahead → create projection |
| non-ancestor/missing reducer or invalid F | divergence |

Unknown combinations classify as divergence. The classifier has no timestamp
input. Add a tripwire test that no capture/reconciliation module references
mtime metadata. Define `M ancestor R` by verified-prefix replay: M's generating
event must exist in the current chain and replay through it must reproduce M's
revision event, projection-state digest, and content hash. Revision-number
comparison alone is insufficient.

### M23.3 — `write_concept` flips

Preserve current validation and exact tool response; the compatibility adapter
stays draft-only through the M24 bridge (matrix §15 depends on that property
explicitly, not merely on preserved validation). Emit Belief create/revise
plus relation/alias events; use `append_batch` whenever the transition has
multiple events. Every revision declares M22 linked or unsupported basis.
Reduce, project, execute pending-manifest write, then acknowledge.

Alias additions emit M22 `entity.alias_added`. Alias removal has no v1 event and
returns typed `unsupported_alias_removal`; it is never hidden in a Belief patch,
override, or manifest update.

Crash after commit but before manifest/file must enter the tested ledger-ahead
branch and regenerate with zero human assertions. `generated` and current
verified rendering remain byte-identical and reducer-derived. This phase has one
hard-coded LOW-risk auto-apply decision only; do not create policy machinery.

### M23.4 — `verify_concept` emits attestation

Append `belief.attested` pinned to the reviewed current revision event ID and
matching content hash, reduce, and regenerate. Current/predating status compares
the pinned event ID, so a later basis-only revision with the same content still
invalidates `current`. The reducer must still reject attestation as lineage or
basis.

- attested revision ID = current revision ID: review renders current; Belief
  content is byte-identical;
- older attested revision ID: render `verified at r3; current is r5 — attestation
  predates revision`.

Add the new r3/r5 e2e without weakening existing literal assertions.

### M23.5 — IPC-boundary structured and editorial capture

At the in-app boundary, parse the requested projection change before any file
write.

Partition the edit into F ordinary fields, R relations, and A alias additions;
resolve the actor-bound M22 `human_actor` source registration and stage its
trusted append-once `source.registered` member first when absent. A staged
registration member uses its `source-register-v1:` key as its operation_key, so
the same registration is idempotent whether it arrives standalone or as a batch
member. Preallocate
F+R+A Observation IDs and one revision ID. Emit M22
`human_assertion/field_change`, `/relation_change`, or `/alias_add` respectively.
An ordinary field assertion's predicate is the field's canonical structured
path — the same normalized key its paired revision patch targets — so
predicate-specific authority routes get stable keys.
Each pins that registration and receives core-derived
`authority_provenance: trusted_human_capture`; projection bytes/callers cannot
author or upgrade it.
Create one Belief revision whose patches match only the F field assertions.
Because BeliefBasis is a complete replacement, preserve every still-admissible
prior link and add all new Observations as `supports` (replacing a prior
`unsupported` basis). Emit one exact relation/alias event per paired assertion.
When F=0, the changed basis makes the empty-patch revision valid. Commit
everything in one batch keyed by the UI request ID, then reduce/project/write
before responding.

Whole-batch refusal covers stale before values, mismatched assertion/effect or
basis, invalid scope, target, correction, relation/alias, and alias removal. UI
controls supply both `relationship_to_subject.role` and `assertion_basis`; each
defaults to `unknown` and never infers authority/firsthandness from actor identity.
Out-of-band capture uses the local-owner registration but defaults both fields
to `unknown`, so it cannot satisfy a privileged authority route accidentally.
M22 standalone human assertions remain valid root evidence but are not fabricated
from projection diffs and do not require patch/effect pairing.

For body/presentation-only change, emit the complete `projection.overridden`
set body, reduce it into overlay state, and project exact bytes. Generated,
verified, epistemic frontmatter, and relation pointers remain hard-refused.
Keep the existing refusal prose and mock parity; semantic capture stays vector-
driven.

### M23.6 — Launch reconciliation + circuit breaker

On open after recovery/migration, run the pure F/M/R scan. Execute safe match,
pending recovery, and ledger-ahead branches. Park individual valid out-of-band
edits until M23.7. Any unclassified state, anchor regression, or the fixed mass
threshold (at least 8 projections, at least 5 mismatches, and at least 25%
mismatched) emits one idempotent `ledger.divergence`, opens reconciliation mode,
suspends capture, and displays the banner.

Check both last git-anchored and app-data remembered heads, but label these as
best-effort corroboration. Test detectable restore cases. Also test/document that
a coherent restore rewinding ledger, manifest, files, and all anchors may be
undetectable; do not assert impossible universal detection.

### M23.7 — Out-of-band capture + reconciliation exits + valve

Activate capture for parked/live watcher diffs only after M23.6. Field-level
diffs use the same assertion+revision batch builder as IPC capture, with actor
`human:owner`, stable human source ID, relationship role `unknown`, assertion
basis `unknown`, and a deterministic key from path/base revision/old hash/new
hash/diff digest. Relation and alias-add diffs use their paired effect forms;
alias removal enters typed reconciliation refusal.

Prose defaults to override. If a changed span uniquely overlaps current-basis
Observation `extracted_text`, capture predicate `extracted_claim_text` and point
`corrects` to that Observation; the correction takes the `field_change` form
targeting the body, pairing with the body patch, so the closed union gains no
new kind. Ambiguous overlap enters reconciliation; never
ask an LLM or guess.

Open the capture valve: in-app projection edits now route through M23.5 instead
of `guard_human_write` refusal. Provenance forgery remains hard-refused.

Implement both reconciliation actions:

- **accept-current-files:** parse/diff every affected file, translate every
  representable epistemic diff to assertion+revision/effect and every editorial
  diff to override,
  prove staged projection equals all file bytes, then commit those events and
  `ledger.reconciliation_resolved` atomically before advancing the manifest.
  Any unparsable, forged, ambiguous, missing/non-ancestor, or non-reproducible
  file—or any alias removal—refuses the entire adoption; the manifest does not
  change. Resolution names exactly its own batch and matching accepted/resulting
  path digests.
- **restore-ledger-authority:** regenerate every affected path using pending
  entries, finalize the manifest, and recheck F=M=R; only then append the
  unbatched resolution with empty capture IDs/null accepted digest. A crash
  before the append keeps reconciliation active and resumes.

## Acceptance matrix

| Scenario | Must hold |
|---|---|
| migration crashes after any prefix | restart appends only missing keyed outputs |
| capture batch lacks marker | no assertion, revision, relation, or alias member affects state |
| human edits one field in-app | assertion + matching revision commit atomically |
| multi-field edit | N assertions + one revision; one committed batch |
| stale before/mismatched basis | whole capture batch refused |
| relation-only edit | paired relation assertion/event + basis-only revision |
| alias addition | paired alias assertion/event + basis-only revision |
| alias removal | typed refusal; never override or rebaseline |
| capture authority omitted | relationship role and assertion basis both `unknown` |
| first capture for the human source | trusted registration precedes assertions in the same atomic batch |
| caller/file forges registration or authority provenance | whole capture refused; no authority upgrade |
| typo/presentation edit | override changes projection; no evidence edge |
| override cleared | canonical projection returns; history/head/version advance |
| crash after ledger commit | F/M/R classifies ledger-ahead; zero recapture |
| crash at either manifest step | pending/prior hashes recover deterministically |
| out-of-band field edit | captured on scan/hash diff; mtime unread |
| extracted claim text edit | assertion correction when mapping is unique |
| ambiguous extracted-text edit | reconciliation/refusal, never guess |
| `accept-current-files` valid mixed diff | canonical capture events precede rebaseline |
| one adoption file unparsable/forged | entire action refused; manifest unchanged |
| `restore-ledger-authority` | exact reducer projections, then mode closes |
| detectable restore signature | one divergence event, named mode, no storm |
| all restore anchors rewind coherently | documented as possibly undetectable |
| 100-file regeneration | identical bytes, zero events/jobs |
| verified belief revised later | r3/r5 state renders; attestation persists |
| attestation/relation/alias changes projection | full state descriptor/head advances |
| CLI transcript before/after | byte-comparable responses |

## Traps

- Never update only manifest hashes in accept-current-files.
- Never treat file=manifest as sufficient; reducer may be ahead.
- The manifest needs revision, revision event, current projection-transition
  head, and full projection-state digest even when bytes are equal.
- A complete physical member frame is not a committed logical batch.
- Override bytes are durable state, but never evidence.
- Use scanner-normalized, bracket-stripped `entry.relationships` in diff tests.
- Regeneration must pre-mark hashes processed so the distiller queue stays cold.
- Preserve store-layer never-throw for new frontend actions.
- Use `pnpm test:run`, full Rust gate, isolated-port e2e, and never bypass hooks.

## Exit criteria

All acceptance rows green · structured capture assertion+revision atomic ·
editorial override rebuildable and evidence-excluded · three-way crash recovery
proven · adoption cannot rebaseline unexplained bytes · best-effort restore claim
honest · attestation history preserved · CLI surface unchanged · existing e2e
green plus new rN/reconciliation/capture coverage.
