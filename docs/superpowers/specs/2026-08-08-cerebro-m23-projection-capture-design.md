# Cerebro M23 — knowledge/ Flips to Projection-First; the Capture Valve — Design

**Date:** 2026-08-08
**Status:** Derived from the accepted Rev 3 roadmap (D1/D4/D8) and the frozen
coverage matrix (rows §14, §34, §64). For owner review.
**Scope:** The inversion moment: `knowledge/*.md` becomes a deterministic
projection of ledger state; the migrator arms; in-app and out-of-band human
edits become committed state transitions; and the divergence circuit breaker's
active half goes live.
**Companion plan:** `../plans/2026-08-07-cerebro-m23-projection-capture.md`
sequences implementation. Where the two disagree, this spec wins.

## Context

M22 proved the tagged schema, reducer/index, crash-safe logical batches,
conformance vectors, byte-stable `project()`, and restart-idempotent migrator.
Files are still authoritative. M23 flips only `knowledge/`, the subtree already
guarded as agent-written and human-verified. `records/` and `docs/` stay vault
plane.

The trust ritual is the acceptance test. A projection is a byte-stable function
of reducer state, so its git diff remains the review artifact. Projection format
v1 is current OKF v0.2 byte-for-byte.

## Governing invariants

1. **Regeneration emits nothing.** Rendering is not an epistemic act. Any
   regeneration burst produces zero Observations, revisions, overrides,
   promoted shadow events, or distill jobs.
2. **mtime is never evidence (D4).** Catch-up is scan + content hash + reducer
   comparison. Filesystem timestamps never classify an edit.
3. **Capture changes canonical state before acknowledgement.** A structured edit
   commits its human Observation and matching Belief revision in one M22 logical
   batch. There is no state where the assertion exists without its revision or
   the revision exists without its stated basis.
4. **Editorial is durable but not evidence.** Presentation/body rewrites become
   `projection.overridden`. The reducer applies the overlay during projection,
   but the event cannot enter lineage, Belief basis, or support calculations.
5. **The MCP surface is unchanged.** Tool names, argument schemas, and response
   prose remain byte-compatible.
6. **Restore detection is best effort.** Git anchors, the remembered app-data
   head, manifest/reducer disagreement, and mass mismatch are corroborating
   signals. A coherent restore that rewinds every anchor can be undetectable;
   product language and tests must not claim otherwise.

## M23 event bodies

All bodies include the M22 common `schema`, `batch_id`, `idempotency_key`, actor,
and content-time fields. The frame remains envelope `v: 0`.

### `projection.overridden`

```text
projection.overridden = {
  ...common,
  belief_id: <stable-id>, path: <knowledge-relative path>,
  base_belief_revision: <reducer revision>,
  base_belief_revision_event: <belief.created|belief.revised event-id>,
  base_generating_event: <current projection-state head event-id>,
  before_projection_hash: <sha256>, after_projection_hash: <sha256>,
  origin: "in_app" | "out_of_band" | "reconciliation_adoption",
  change: {
    action: "set",
    patch: [{ field_path: <projection JSON Pointer>,
              before: TypedValue, after: TypedValue }, ...],
    supersedes_override_event_ids: [<event-id>...]
  } | {
    action: "clear",
    override_event_ids: [<event-id>...],
    reason: <non-empty string>
  }
}
```

Projection pointers are restricted to `/body` and explicitly declared
presentation-only fields. Generated/verified provenance, epistemic frontmatter,
and relation fields are illegal override targets. A set patch is non-empty,
matches the base projection, and reproduces `after_projection_hash` exactly. A
clear references active overrides. The reducer stores an ordered overlay per
Belief; `project()` renders canonical Belief state and then applies that overlay.
A later set may supersede prior overlays, and M26 maintenance can clear one.
An underlying Belief revision does not silently clear a human overlay: the
overlay remains active and is marked stale against its base revision.

This event changes `projection_overrides` and the projected content hash. It
creates no Observation, revision, basis link, lineage edge, support, or
independence fact. That exclusion is a reducer rule and a conformance vector,
not a comment convention.

### `ledger.divergence`

```text
ledger.divergence = {
  ...common,
  detection_key: <stable hash of the detected condition>,
  signals: ["git_anchor_regression" | "remembered_head_regression"
          | "manifest_reducer_disagreement" | "mass_projection_mismatch"
          | "migration_source_changed" | "migration_idempotency_conflict"],
  ledger_head: <hash>, git_anchored_head: null | <hash>,
  remembered_head: null | <hash>, manifest_digest: <sha256>,
  reducer_projection_digest: <sha256>,
  mismatch_count: <integer>, projection_count: <integer>,
  sample_paths: [<knowledge-relative path>...]
}
```

`detection_key` is also the append idempotency key, so the same unresolved
condition emits one event across launches. A different detection_key arising
while reconciliation is already open appends its own divergence event — still
append-once per detection_key — without creating a second mode entry: the open
mode absorbs it and lists every unresolved detection key. The reducer opens
reconciliation mode and records the active divergence event. Samples are sorted and bounded;
the complete path set stays derived from manifest/reducer/file scan.
Migration signals include the M22 epoch's source/key digests in
`detection_key`; manifest/projection digests describe the state available at
detection time and may use the canonical empty digest before an initial
manifest exists.

### `ledger.reconciliation_resolved`

```text
ledger.reconciliation_resolved = {
  ...common,
  divergence_event_id: <active ledger.divergence event-id>,
  action: "accept_current_files" | "restore_ledger_authority",
  affected_paths: [<sorted paths>...],
  capture_batch_ids: [<batch-id>...],
  accepted_files_digest: null | <sha256>,
  resulting_projection_digest: <sha256>
}
```

The reducer closes reconciliation mode only when the referenced divergence is
active and staged/current projection hashes prove every affected path equals the
declared resulting digest. A prose-only resolution event cannot bless bytes
that were never translated into ledger state.

The action-specific contract is closed. `affected_paths` is non-empty, sorted,
and duplicate-free. Define `path_digest` as SHA-256 of canonical JSON for the
path-sorted array `[{ "path": path, "content_hash": SHA-256(bytes) }]`.

- `accept_current_files` is a member of the same logical batch as every adoption
  event. Its common `batch_id` is non-null, `capture_batch_ids` is exactly the
  singleton `[batch_id]`, `accepted_files_digest` is the `path_digest` of the
  bytes being adopted, and `resulting_projection_digest` is the same digest over
  the staged reducer projections. The two digests must match before commit.
- `restore_ledger_authority` is appended unbatched only after files and complete
  manifest entries equal the current reducer projections. Its `batch_id` is
  null, `capture_batch_ids` is empty, `accepted_files_digest` is null, and
  `resulting_projection_digest` is the current reducer projection `path_digest`.

Any other nullability, count, batch relationship, or digest combination is
refused.

## The projection manifest

`<vault>/.cerebro/projection-manifest.json` travels with the vault and remains
covered by `.cerebro/` gitignore/self-heal.

```json
{
  "format": 1,
  "entries": {
    "knowledge/example.md": {
      "belief_id": "<id>",
      "projected_revision": 4,
      "belief_revision_event": "<current belief revision event-id>",
      "generating_event": "<highest-seq projection-state transition event>",
      "projection_state_digest": "<canonical projection-state descriptor hash>",
      "content_hash": "<intended projected bytes>",
      "write_state": "complete",
      "previous_content_hash": null
    }
  }
}
```

`projected_revision` and `belief_revision_event` identify the current Belief
revision. The projector constructs this canonical descriptor:

```text
ProjectionStateDescriptor = {
  belief_revision_event,
  review_event_ids: [<attestation event IDs read by the renderer, seq order>...],
  relation_transition_heads: [
    { relation_id, event_id: <latest add/remove event> }, ... sorted by relation_id
  ],
  alias_event_ids: [<live subject-alias event IDs sorted by normalized alias>...],
  active_override_event_ids: [<event IDs in application order>...],
  override_head_event_id: null | <latest set/supersede/clear event ID>
}
```

`projection_state_digest` is SHA-256 of its M21-canonical JSON.
`generating_event` is the highest-`seq` non-null event in the descriptor, not
merely the newest active byte producer. Thus a review-state change, relation
remove, alias addition, or override clear/supersession advances identity even
when the resulting bytes equal an older projection. `base_generating_event`
uses this same head, closing byte-identical stale-edit races. Any later event
kind that affects projection bytes or disables a prior projection effect must
add an explicit descriptor component and conformance vector before it emits.
Content hash alone cannot reveal that the ledger advanced to byte-identical
state.

Projection writes use a recoverable manifest-first protocol:

1. Compute the exact projection from reducer state.
2. Atomically store an entry with target tuple, `write_state: pending`, and the
   prior file hash in `previous_content_hash`.
3. Atomically write the projection file.
4. Atomically mark the entry `complete` and clear `previous_content_hash`.

Thus a pending entry plus the old/missing file means regenerate; pending plus the
target file means finalize the manifest. The manifest is the only capture-path
self-write marker. M21's watcher cache remains a UI-refresh optimization.

## Arming the migrator (M23.0)

On vault open, after ledger recovery:

- a matching `migration.completed` is the fast no-op;
- otherwise M22 migration resumes through deterministic per-output
  `append_once` keys, even if a durable prefix exists;
- a changed migration source digest or idempotency conflict enters
  reconciliation under its closed migration signal rather than duplicating
  output;
- after completion, create the initial complete manifest only after current
  files byte-match reducer projections.

If migration completed but the process died before manifest creation, the
three-way launch scan reconstructs it when files match reducer state. Migration
never relies on the completed marker as its sole prefix guard.

## Canonical write paths

### Agent writes

`write_concept` validates exactly as today, emits `belief.created` or
`belief.revised` plus any relation/alias events, commits multi-event changes with
M22 `append_batch`, reduces, renders, and runs the manifest-first file protocol.
The Belief body declares linked or explicitly unsupported basis as required by
M22. The `write_concept` compatibility adapter stays draft-only through the M24
bridge — matrix §15 depends on that property explicitly, not merely on the
preserved validation that implies it. The hard-coded LOW-risk decision is
replaced by M24 policy; M23 does not grow a proto-policy engine.

An alias addition uses M22 `entity.alias_added` and therefore participates in
the projection descriptor. Alias removal has no v1 event: `write_concept`, live
capture, and reconciliation adoption return a typed
`unsupported_alias_removal` refusal rather than hiding it in a Belief patch,
override, or manifest rebaseline.

A crash after ledger commit but before the manifest update is a normal
**ledger-ahead** state. Launch reconciliation projects the reducer state; it
does not recapture the old file as a human assertion.

`verify_concept` appends `belief.attested` pinned to the reviewed revision event
ID and matching content hash, then regenerates. When that revision is current,
the Belief's epistemic content remains byte-identical while review metadata
renders current. When it predates the current revision, render `verified at r3;
current is r5 — attestation predates revision`. The event ID, not content
equality, decides current versus predating; attestation remains illegal as
evidence basis.

### Structured human capture

For an in-app edit, the IPC boundary has actor, belief, field pointer/effect, and
typed before/after where the effect is a field patch. For an out-of-band edit,
the parser and deterministic differ derive the same values. Partition one edit
into F ordinary field changes, R relation changes, and A alias additions:

1. Resolve the actor-bound M22 `human_actor` source registration. If absent,
   stage its trusted append-once `source.registered` member first. The staged
   member uses its `source-register-v1:` key as its operation_key, so the same
   registration is idempotent whether it arrives standalone or as a batch
   member. Preallocate F+R+A Observation IDs and one revision ID.
2. Create one `human_assertion/field_change` per ordinary field, one
   `human_assertion/relation_change` per relation effect, and one
   `human_assertion/alias_add` per alias addition. Every Observation carries the
   stable human `source_id`, the matching registration event ID,
   core-derived `authority_provenance: trusted_human_capture`, target,
   predicate/value/scope, both human-selected authority fields, and optional
   correction pointer/reason. An ordinary field change's predicate is the
   field's canonical structured path — the same normalized frontmatter key its
   paired revision patch targets — so D11/M24/M27 predicate-specific authority
   routes key on stable names, never display labels. Relation/alias typed
   values are the canonical
   effect objects fixed by M22. Neither IPC arguments nor projection bytes may
   supply the registration/provenance tag.
3. Create one `belief.revised`. Its patches match only the F field-change
   assertions one-to-one. Its BeliefBasis is a complete replacement: preserve
   every still-admissible prior link and add all F+R+A new Observations as
   `supports` (converting a prior `unsupported` basis to `linked`). Emit one exact
   `belief.relation` per relation assertion and one exact `entity.alias_added` per
   alias assertion. If F is zero, the changed basis makes the empty-patch revision
   a valid support-only revision.
4. Commit every member under one `batch.committed`, using the UI request ID or
   deterministic out-of-band diff key as operation idempotency key.
5. Reduce, project, and update/write through the manifest protocol before the
   IPC request acknowledges.

Batch validation requires each field assertion to match exactly one revision
patch, each relation assertion to match exactly one relation event, each alias
assertion to match exactly one alias event, and every new assertion to appear in
the replacement basis. No effect may satisfy two assertions. Any stale `before`,
malformed predicate/scope, illegal target, invalid relation/alias, or alias
removal refuses the whole batch. Separate UI controls supply
`relationship_to_subject.role` and `assertion_basis`; both default to `unknown`,
and neither may infer `project_owner`, `responsible_owner`, or `firsthand` from
the actor. Out-of-band capture uses the local-owner registration but defaults
both authority fields to `unknown`, so it cannot satisfy a privileged authority
route merely by being captured as human-authored.

M22 `human_assertion/standalone` remains valid root evidence but is not fabricated
from a projection diff and has no mandatory patch/effect pairing. If a later
operation links it to a Belief, that operation obeys the normal complete-basis
replacement rule.

For prose, ambiguity defaults to editorial override. The sole epistemic carveout
is a diff span overlapping `extracted_text` reachable from the current Belief's
basis: it becomes predicate `extracted_claim_text`, value = the typed replacement,
and `corrects` points to that Observation when the mapping is unique. The
correction takes the `field_change` form targeting the body, pairing with the
body patch, so the closed observation-kind union is not silently extended. An
ambiguous overlap is not guessed; live capture enters reconciliation and
`accept-current-files` refuses it until resolved.

### Editorial capture

Body or presentation-only changes create `projection.overridden`, are reduced
into projection overlay state, and are then projected back to the exact edited
bytes. In-app capture commits before writing. For an out-of-band file already on
disk, capture commits, confirms `project()` equals those bytes, then advances the
manifest. A crash after commit is recognized as ledger-ahead, not captured twice.

## Three-way launch reconciliation

On open, compare all three authorities for every path:

- **F:** actual file hash/parse result;
- **M:** manifest belief/revision/revision-event/generating-event/state-digest,
  hash, and write state;
- **R:** the same reducer identity tuple plus a freshly projected hash.

| State | Classification and action |
|---|---|
| F = M = R, manifest complete | match; no-op |
| manifest pending = R; F is previous/missing | interrupted own write; regenerate |
| manifest pending = R; F is target | interrupted finalize; mark complete |
| M = R; F differs and parses | genuine out-of-band edit; capture |
| M is an ancestor of R; F = M | ledger ahead; regenerate R, zero capture |
| M is an ancestor of R; F = R | ledger ahead; advance manifest, zero capture |
| reducer has Belief, entry/file missing | ledger ahead; create projection |
| file/manifest refers to missing or non-ancestor reducer state | divergence |
| file is unparsable or forges provenance | divergence; never adopt silently |
| anchor regression or mismatch threshold reached | divergence circuit breaker |

Any mixed state not proven by these rules is divergence, not human intent. The
scan reads no mtime. The mass-mismatch signal is fixed at projection count ≥ 8,
mismatch count ≥ 5, and mismatches ≥ 25% of projections; smaller vaults rely on
surviving anchors and explicit non-ancestor states.

The circuit breaker records one idempotent `ledger.divergence`, opens a named
reconciliation mode, suspends automatic capture, and shows a banner. Regular
agent writes remain available. Detection is best effort: anchor regression is
detectable only when a git or remembered head survived the restore; a mass
mismatch is a signature, not proof.

`M is an ancestor of R` is not inferred from revision number alone. The current
ledger must contain `M.generating_event`, and replaying the reducer only through
that event must reproduce M's full revision event, projection-state digest, and
content hash. R is the projection at the current verified prefix. Failure to
reproduce the historical tuple is non-ancestor divergence.

## Reconciliation exits

**accept-current-files** is adoption through the capture valve, not manifest
rebaselining:

1. Parse every affected file and mechanically diff it against reducer
   projection state.
2. Translate every epistemic diff to human assertion(s) + matching Belief
   revision/effect events, and every editorial diff to `projection.overridden`.
   Alias additions use their exact paired event; any alias removal refuses the
   action.
3. Refuse the entire action if any file is unparsable, forges provenance, has an
   ambiguous claim mapping, targets missing/non-ancestor state, or cannot be
   reproduced byte-for-byte by staged reducer projection.
4. Commit all adoption events plus `ledger.reconciliation_resolved` in one
   logical batch. Only after the marker fsync and reducer equality may the
   manifest be advanced.

This path never changes a manifest hash without a canonical event that explains
the bytes.

**restore-ledger-authority** regenerates every affected projection with the
pending-manifest protocol, finalizes all manifest entries, and rechecks F=M=R.
Only then does it append the unbatched `ledger.reconciliation_resolved`. A crash
before that append leaves reconciliation active and resumable; after it, the
restore is complete.

## Reducer/index behavior

M23 adds `projection_overrides` and `reconciliation_state` tables. Both rebuild
from events. `projection.overridden` mutates only the projection overlay;
`ledger.divergence` opens the active mode; a valid
`ledger.reconciliation_resolved` closes it. M22 logical-batch rules apply, so an
uncommitted capture/adoption batch has no state effect.

The M22 version registry remains closed: every valid `projection.overridden`
set, supersede, or clear increments the named `belief` once because canonical
projection state changed. `ledger.divergence` and
`ledger.reconciliation_resolved` mutate only global reconciliation state and
have no registered-target version effect. Capture Observations, revisions,
relations, and aliases use M22's existing rows. Vectors assert the full version
map for all three M23 event kinds, including refused/uncommitted cases.

The projector returns `{ bytes, content_hash, belief_id, projected_revision,
belief_revision_event, generating_event, projection_state_digest,
projection_state_descriptor, active_override_event_ids }`. Manifest and
reconciliation use that complete result, never a file hash alone.

## Error handling

| Failure | Behavior |
|---|---|
| crash before capture batch marker | whole batch ignored; edit request not acknowledged |
| crash after marker, before file/manifest | ledger-ahead; regenerate/advance, no recapture |
| crash after pending manifest, before file | previous hash proves interrupted own write |
| crash after file, before manifest complete | target hash proves interrupted finalize |
| missing/forged human source registration | whole capture/adoption refused; no assertion or manifest advance |
| git checkout changes mtimes only | zero events and jobs |
| coherent restore with surviving anchor/signature | one divergence event; explicit reconciliation |
| coherent restore rewinds every anchor consistently | may be undetectable; no stronger claim |
| accept-current-files has one bad file | refuse whole adoption; manifest unchanged |
| regeneration burst exceeds watcher cache | manifest/reducer hashes still recognize it |

## Conformance and integration tests

- Full M23 event-body encode/decode and reducer vectors: override set/replace/
  clear, illegal override pointer, override excluded from evidence, divergence
  open, a second detection key absorbed by the already-open mode, wrong-event
  resolution refusal, valid close, action-specific resolution
  nullability/digests, and every target-version effect/no-effect.
- Capture vectors: assertion+revision committed together; no marker; stale
  before; mismatched assertion/patch; canonical field-path predicates;
  multiple field assertions with one
  revision; relation/alias assertion-to-effect pairing; relation/alias-only
  basis revision; alias-removal refusal; both authority defaults; first-source
  registration in the same batch; forged registration/provenance refusal;
  extracted-text correction; editorial-only override.
- Three-way reconciliation table vectors, including both ledger-ahead cases.
- Projection identity vectors cover current/predating attestation, relation
  add/remove, alias add, override set/supersede/clear, and byte-identical state
  advances; historical-prefix replay must prove ancestry.
- `accept-current-files` fixtures for mixed epistemic/editorial changes and
  atomic refusal on unparsable, forged, ambiguous, or non-reproducible input.
- Kill points before/after batch marker and every manifest/file step.
- 100-file regeneration soak: identical bytes, zero epistemic/shadow promotion,
  zero distill jobs.
- CLI transcript before/after flip byte-comparable.
- e2e adds attestation r3/r5 and reconciliation exits; existing literal-content
  specs remain unchanged. Frontend actions preserve store-layer never-throw.
- Wikilink tests use scanner-normalized `entry.relationships` values without
  brackets on both projection and diff sides.

## Non-goals

No general policy/risk engine (M24) · no capture outside `knowledge/` · no LLM
edit classification · no claim-granularity resolver · no promise of perfect
rollback detection · no UI beyond rN attestation, reconciliation banner/actions,
and assertion authority/correction affordances.

## Acceptance

A structured human edit commits an assertion and matching revision atomically;
an editorial edit durably changes projection state but never evidence;
regeneration produces zero phantom events; the manifest/reducer/file comparison
recovers ledger-ahead crashes; adoption never rebaselines unexplained bytes;
attestation survives revision; detectable divergence produces one event and a
tested exit; CLI surface remains byte-compatible; full gates pass.
