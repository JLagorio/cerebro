# Follow-up: Knowledge read side and trust model (how verified knowledge can be overridden and what agents are served)

> Audit lens `gap:Knowledge read side and trust model (how verified knowledge can be overridden and what agents are served)` · critic-directed follow-up auditor, each finding adversarially verified

## Summary

Knowledge is written through a governed path but read from raw frontmatter.
- Trust comes from the file's `verified` stamp, not the ledger's attestation. A stamp the ledger refused still reads as human-reviewed everywhere.
- Retirement comes from the file's `supersedes` field. One unverified write_concept can retire a verified concept with no human gate, because a MEDIUM relation auto-applies and nothing checks the verified target.
- write_concept and cache_source ignore run write-scope and read-scope. Content fetched from the web can reach other agents' context with no provenance label, and during reconciliation agents are served the disputed bytes.
- Agent labels are inconsistent: a `trust` key that doesn't exist, lifecycle missing, inbound contradictions dropped.
- Whether the base is ever read is unmeasured. The only surviving transcript shows 6 writes and 0 knowledge_about calls, and 0 of 62 anchors in the live vault reach a record.

## Findings

| ID | Sev | Survived | Finding |
|---|---|---|---|
| F106 | high | yes | One unverified write_concept can retire a human-verified concept with no human gate. The read side treats a bare `supersedes:` field as retirement. |
| F107 | high | yes | Trust is read from the file's `verified` field, never from the ledger's attestation, so a stamp the ledger refused still reads as human-reviewed everywhere |
| F108 | high | yes | write_concept and cache_source bypass run write-scope and read-scope, so untrusted fetched content becomes knowledge that other agents read with no provenance |
| F109 | medium | yes | Agents get labels that are incomplete and contradictory: a `trust` key that doesn't exist, lifecycle dropped, and inbound contradictions dropped |
| F110 | medium | yes | While reconciliation is open, every agent read serves the disputed disk bytes and gives no signal |
| F111 | medium | yes | Nothing records whether the base is read. The one surviving transcript shows 6 writes and 0 knowledge_about calls, and no anchor in the live vault reaches a record. |
| F112 | medium | yes | Rust and TS concept semantics are hand-copied, and the copies already disagree |
| F113 | low | yes | Governed ledger state (superseded, archived, contested, qualification) never reaches any reader |

### F106 — One unverified write_concept can retire a human-verified concept with no human gate. The read side treats a bare `supersedes:` field as retirement.

- **Severity (claimed):** high
- **Category:** trust-model
- **Verification:** survived (confirmed/high, partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/ledger/concepts.rs:606-617`
  - `src-tauri/src/policy/expand.rs:1292-1300`
  - `src-tauri/src/policy/expand.rs:423`
  - `src-tauri/src/policy/interpreter.rs:51-59`
  - `src/engine/okf.ts:627-643`
  - `src/engine/okf.ts:692-697`
  - `src/agent/context.ts:285-291`
  - `src/agent/systemPrompt.ts:41`
  - `src-tauri/src/knowledge.rs:597-610`
  - `src-tauri/src/mcp.rs:2048-2052`
  - `src/engine/dossier.ts:60-63`
  - `src/engine/jobs.ts:174`
  - `src-tauri/src/ledger/migrate.rs:634-649`

**Evidence**

- The write_concept enrichment turns `supersedes` into an edit_relation op whose only target is the Relation (concepts.rs:606-617). Expansion only reads `to` and touches the Relation (expand.rs:1299-1300, 423).
- target_has_attestation checks Belief-class targets only (interpreter.rs:51-59). edit_relation is base_risk MEDIUM, which risk_ladder applies automatically (policy.v3.json). So the verified Belief never floors the change to HIGH.
- The governed op that would be gated, supersede_belief, is never emitted by write_concept.
- Every reader treats the field as retirement:
  - listConcepts sets supersededBy from any concept, verified or not (okf.ts:636-640).
  - reviewReasons returns [] (okf.ts:696).
  - dossier.ts:60-63 moves the concept to 'retired'.
  - jobs.ts:174 stops its rechecks.
  - The agent snapshot sorts it first (context.ts:291), and the prompt says 'Never present a claim marked supersededBy as current' (systemPrompt.ts:41).
  - knowledge_about prints 'Superseded by' (mcp.rs:2048).
- The only guard is against self-reference (okf.ts:638). A mutual A↔B `supersedes` retires both, and both leave the review queue and Home.
- The ledger records a relation only for an exact `[[stem]]` (migrate.rs:634-649, concepts.rs:271-289). The read side also accepts '/systems/a.md' (okf.test.ts:751-760), plain strings, titles and any case (wikilink.ts:58-74). Those forms retire a concept with no relation event at all.
- On the fallback path (write.rs:606-626) no policy runs.

**Impact**

An agent's unreviewed claim can override a claim a person verified, in the UI and in every other agent's context. The verified claim drops out of 'Known', its stale/deprecated review reasons disappear, and its rechecks stop. No card is ever shown to the human.

**Recommendation**

- Build retirement from the ledger's governed state, not from frontmatter.
- Route write_concept's `supersedes` through supersede_belief so an attested predecessor floors the change at HIGH, or add the `to` Belief to the edit_relation targets.
- Treat a supersession only as 'proposed' until the superseder is human-reviewed.
- Guard against cycles.
- Use one relation resolver shared by the ledger and the readers.

<details><summary>Verifier 1: confirmed (severity → high)</summary>

**Reasoning.** I could not refute it. The code works the way the claim says:
- **Write side:** `write_concept` passes `supersedes` through unchanged. `intended_relations` turns it into an `edit_relation` Add op. That op's only staged target is the Relation. The superseded (verified) Belief is never in the target set.
- **Expansion:** it checks that `from` and `to` exist, then records a relation and touches only `TargetClass::Relation`.
- **Policy:** the `target_has_attestation` escalator filters to `TargetClass::Belief` targets. So does `lineage_fan_in`. Neither fires. `edit_relation` has `base_risk` MEDIUM, and in policy.v3.json's risk ladder MEDIUM means auto-apply with a journal entry. `supersede_belief` is the gated op: it sits in `contradiction_addressing.required_for_ops`. `write_concept` never emits it.
- **Read side:** it works from frontmatter alone and has no trust check:
  - `listConcepts` sets `supersededBy` from any concept, whatever its trust, and only guards self-reference.
  - `reviewReasons` returns [] for a superseded concept.
  - `buildDossier` files it under `retired`.
  - `jobs.ts` skips its rechecks.
  - Rust `knowledge_about` builds `replaced_by` the same way and prints "Superseded by".
  - The agent prompt tells agents never to present a `supersededBy` claim as current.
- **Fallback path:** when the ledger writer is inactive, `vault/write.rs` writes the file and a shadow record with no policy at all.

Minor corrections:
1. The superseded Belief is NOT retired in the ledger. It stays live and attested there. The ledger records only an ungated relation edge. The retirement happens entirely in the frontmatter-derived projections (UI, dossiers, jobs, agent context, MCP output).
2. "No card" is true of the retirement, but the new superseding concept still shows up in the review queue as 'unverified'. The human does see the new concept. Nothing tells them it retires a verified claim, and the verified claim silently leaves review, Known and rechecks.

I kept the severity at high because this breaks the stated human-VERIFIED trust model, even though the writer is the user's own agent.

**Evidence checked.** - **src-tauri/src/mcp.rs:2486-2494:** copies `supersedes`/`refines`/`contradicts` from the agent's arguments into frontmatter. No check on what the target is or its trust.
- **src-tauri/src/ledger/concepts.rs:267-292 (`intended_relations`):** maps `supersedes` to `RelationKind::Supersedes` on an exact stem match only. :617-628 is create (target = `TargetClass::Relation` only). :697-728 is update (same, Relation target only).
- **src-tauri/src/policy/expand.rs:1291-1336:** `EditRelation` checks that `from`/`to` exist, then calls `relation_member`. :397-425 has `relation_member` touch only `TargetClass::Relation`.
- **src-tauri/src/policy/interpreter.rs:51-59:** `target_has_attestation` filters `target_class == Belief`. `lineage_fan_in` (L64-69) also counts Belief targets only.
- **shared/policy/policy.v3.json:**
  - `ops.edit_relation.base_risk` = "MEDIUM".
  - Escalators: `target_has_attestation` and `lineage_fan_in`, each with floor HIGH.
  - `risk_ladder.MEDIUM` = {apply: auto, journal: true}.
  - `supersede_belief` is listed in `contradiction_addressing.required_for_ops`.
- **src/engine/okf.ts:627-643:** `listConcepts` sets `replaced.supersededBy` for any resolving target; the only guard is self-reference. okf.ts:696: `reviewReasons` returns [] when `supersededBy`.
- **src/engine/dossier.ts:60-65:** superseded concepts go to `retired`.
- **src/engine/jobs.ts:174:** `continue` when `supersededBy`.
- **src/agent/context.ts:285-291:** carries `supersededBy` into the agent snapshot, weight 0.
- **src/agent/systemPrompt.ts:41:** "Never present a claim marked `supersededBy` as current".
- **src-tauri/src/knowledge.rs:597-612:** `replaced_by` is built from any concept's `supersedes` field. mcp.rs:2047-2051 prints "Superseded by".
- **src-tauri/src/vault/write.rs:600-626:** legacy fallback writes via `concept_write` + `shadow_write` with no policy evaluation.

**Correction.** The mechanism is real, with two clarifications:
- **The ledger does not retire the verified Belief.** It stays live and attested there. The ungated part is the relation edge, and every read-side projection (UI, dossier, jobs, agent context, knowledge_about) treats the frontmatter `supersedes` as retirement.
- **The human does see the new concept.** It enters the review queue as 'unverified'. They get no gated card about the retirement, and the verified concept silently loses its review reasons, its place in Known/current and its rechecks.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** The mechanism is real, and I checked each step:
- write_concept splits into one proposal per op (concepts.rs:414-483).
- The `supersedes` edge becomes an EditRelation proposal whose only target is the Relation (concepts.rs:617-627 on create, 697-723 on revise).
- Expansion looks the endpoints up with plan.belief(), which neither mutates nor calls touches(). Only the Relation gets touched (expand.rs:1299-1300, 423).
- target_has_attestation only fires when a Belief is one of the targets (interpreter.rs:51-59). So the verified concept never trips the escalator to HIGH.
- edit_relation has base_risk MEDIUM, and the risk_ladder sets MEDIUM to apply: auto (journal: true). The edge therefore commits with no human card.
- The read side trusts the bare field and ignores verification: listConcepts (okf.ts:627-643), reviewReasons returns [] (okf.ts:696), the dossier moves it to retired (dossier.ts:60-63), recheck jobs skip it (jobs.ts:174), knowledge_about prints "Superseded by" (knowledge.rs:597-610 feeding mcp.rs:2048), and the agent is told never to present it as current (systemPrompt.ts:41).
- resolveConcept accepts path forms such as '/systems/a.md' (okf.ts:724-730, okf.test.ts:751-760). The ledger's wikilinks() accepts only exact `[[stem]]` (migrate.rs:634-649). So some spellings retire a concept on the read side with no relation event at all.
- On the legacy fallback path (write.rs:606-626) no policy runs.

The claim is overstated in these ways:
1. It is latent in the live vault. /Users/joseflagorio/Documents/test/knowledge has zero `supersedes:` fields and zero `verified:` concepts, so nothing has been retired this way.
2. The tool is designed to invite this. The MCP description tells agents to use `supersedes` to replace concepts (mcp.rs:859-862). The defect is that the attestation escalator can be bypassed, not a hidden exploit.
3. "Retire" means read-side demotion only. The verified file and its belief.attested are untouched. The edge is journaled with one_click revert. The retired concept stays visible under "retired" with a "Replaced by" label, so "no card" is true but "no trace" is not.
4. Even the governed supersede_belief has base_risk MEDIUM. Its protection also depends only on the attestation escalator, so the gap is specifically that this escalator is blind to relation-only targets.
5. "Sorts it first" is wrong. A superseded note gets weight 0 and the ascending sort puts it first (context.ts:291, 300), so it does come first, but it is still labelled supersededBy.

Net: a real trust-model gap that goes against the "human-VERIFIED" invariant. Because it is dormant, reversible and visible, medium fits better than high.

**Evidence checked.** - src-tauri/src/ledger/concepts.rs:617-627: the relation op's targets are only TargetClass::Relation.
- src-tauri/src/ledger/concepts.rs:414-483: one ProposalV1 per op, declared_risk = table base_risk.
- src-tauri/src/policy/expand.rs:1292-1300: EditRelation calls plan.belief(from/to), which only looks the beliefs up (expand.rs:247-259, no touches); expand.rs:423 touches only the Relation.
- src-tauri/src/policy/interpreter.rs:51-59: target_has_attestation filters on target_class == Belief.
- shared/policy/policy.v3.json: ops.edit_relation.base_risk=MEDIUM; risk_ladder.MEDIUM.apply=auto; escalators[0] target_has_attestation floor HIGH; ops.supersede_belief.base_risk=MEDIUM.
- src/engine/okf.ts:633-641: supersededBy is set with no verified check; okf.ts:696 returns [] for a superseded concept; okf.ts:724-730 resolves path forms.
- src/engine/dossier.ts:60-63; src/engine/jobs.ts:174; src/agent/context.ts:291, 300 (weight 0, ascending sort).
- src-tauri/src/knowledge.rs:597-610; src-tauri/src/mcp.rs:2048-2052; src-tauri/src/mcp.rs:859-862 (tool description encourages supersedes).
- src-tauri/src/ledger/migrate.rs:634-649: exact `[[x]]` only.
- src-tauri/src/vault/write.rs:606-626: legacy path with no policy.
- Live vault: `grep ^supersedes: knowledge` returns nothing, and 0 files carry `^verified:`.

**Correction.** An unverified agent write_concept can add a `supersedes` edge to a human-verified concept. The edge is a MEDIUM, auto-applied edit_relation whose targets don't include the attested Belief, so the attestation escalator never fires and no human card is shown. On the read side the verified concept is then demoted to retired: dropped from review reasons and rechecks, and flagged supersededBy to agents. That demotion happens in the UI and agent context only. The verified file and its attestation are unchanged, and the edge is journaled, one-click revertible, and labelled "Replaced by". The live vault is not affected today because it has no verified concepts and no supersedes fields. Severity: medium, a latent trust-model gap.

</details>

### F107 — Trust is read from the file's `verified` field, never from the ledger's attestation, so a stamp the ledger refused still reads as human-reviewed everywhere

- **Severity (claimed):** high
- **Category:** trust-model
- **Verification:** survived (partially_confirmed/high, partially_confirmed/medium)
- **Locations:**
  - `src/engine/okf.ts:190-222`
  - `src-tauri/src/knowledge.rs:425-451`
  - `src-tauri/src/mcp.rs:1933`
  - `src/agent/context.ts:281-298`
  - `src-tauri/src/ledger/capture.rs:961-966`
  - `src/lib/mockIpc.ts:1035-1042`

**Evidence**

- reviewStatus and humanReviewed derive trust from parseVerified(entry.properties.verified) (okf.ts:190-222).
- Rust trust_tier returns 'human-reviewed' for any stamp whose `by` starts with 'human:' (knowledge.rs:428-451). get_note (mcp.rs:1933) and knowledge_about use it.
- BeliefChips carries no review axis (mockIpc.ts:1035-1042), so no surface reads belief.attested.
- A `verified` stamp added out of band is refused as 'provenance forgery' (capture.rs:961-966), but the bytes stay on disk and every reader honors them.
- okf.ts:177-183 says the file-side answer and the ledger-side answer are 'the same answer read from two places'. That stops being true once they diverge.
- Ways to plant a stamp are already confirmed: native Write/Edit (prior #6/#11) and the './knowledge'/'Knowledge/' prefix bypass through update_frontmatter (prior #13).

**Impact**

An agent can self-certify. Its concept leaves the review queue and Home, sorts as 'verified-and-settled' in other agents' snapshots, and knowledge_about calls it 'human-reviewed'. The ledger only notices at the next launch, and then only as the generic divergence banner.

**Recommendation**

Derive review state from the ledger's attestation (belief.attested plus the pinned content hash) and expose it through chips and knowledge_about. When the file's stamp and the ledger's attestation disagree, render 'unverified (disputed)'.

<details><summary>Verifier 1: partially_confirmed (severity → high)</summary>

**Reasoning.** - The main mechanism is real. Every reader decides trust from the file's `verified` frontmatter and checks nothing else. Nothing compares the stamp against the ledger's `belief.attested` or `dynamics::review::status_for`.
- TS: `reviewStatus` returns 'current' whenever `parseVerified` finds a stamp. `parseActor` makes any `human:*` string a human, so `humanReviewed` is true. That concept then leaves the review queue (`reviewReasons`) and the Home learned list, and sorts at weight 5 (most trusted) in the agent context snapshot.
- Rust: `trust_tier` returns 'human-reviewed' for any `by` that starts with 'human:'. It is used in `get_note`'s "Trust:" header and in `knowledge_about` (knowledge.rs:682).
- The ledger only catches this in `launch_scan`, which runs once when the vault activates (shadow.rs:144). There it refuses the stamp as "provenance forgery" (capture.rs:961-966) and opens the generic reconciliation mode. The bytes stay on disk and every reader keeps honoring them.
- One detail in the evidence is wrong. The ledger-derived review axis is not missing: the Rust `FacetChips` (dynamics/bundle.rs:85) and its TS mirror `FacetChips` (mockIpc.ts ~L1024) both carry `review: ReviewStatus` from the ledger, per facet inside `BeliefChips.facets`. It is computed and shipped but never rendered or read: `FacetChips.tsx` and `useBeliefChips.ts` never touch `.review`, and every `ReviewChip` takes `concept.review`, which comes from the file. So the precise wording is "the ledger review axis exists in the payload but no surface consumes it."
- The okf.ts:176-177 comment ("the same answer read from two places") is exactly the assumption that breaks under divergence.
- The live incident did not plant a `verified` stamp; the Aug 17 edits changed `generated`. The impact is therefore a demonstrated capability, not an observed exploit. The bypass path it relies on (agents writing knowledge files outside the ledger) is proven by that same incident.
- Severity stays high: it breaks the "agent-written, human-VERIFIED" invariant, and other agents are served the forged tier.

**Evidence checked.** - src/engine/okf.ts:150-155: `parseVerified` reads `entry.properties.verified` and nothing else.
- okf.ts:56-67: `parseActor` treats any 'human:' prefix as kind human.
- okf.ts:190-222: `reviewStatus` returns 'current' if any stamp parses; `humanReviewed` = current && human.
- okf.ts:669 and 698: Home filter and `reviewReasons` both drop `humanReviewed` concepts.
- src/agent/context.ts:281-298: snapshot weight 5 when `review === 'current'` and `reviewedBy === 'human'`.
- src-tauri/src/knowledge.rs:428-451: `trust_tier` checks `by.starts_with("human:")`. It is used at knowledge.rs:682 (knowledge_about) and mcp.rs:1933 (get_note "Trust:" header).
- src-tauri/src/ledger/capture.rs:961-966: a changed generated/verified stamp returns Err "provenance forgery".
- src-tauri/src/ledger/shadow.rs:144: `launch_scan` runs only at activation.
- Correction evidence:
  - src-tauri/src/dynamics/bundle.rs:85,151: `FacetChips.review = review::status_for(belief, …)`, the ledger-derived review.
  - src/lib/mockIpc.ts ~1010-1024: TS `ReviewStatus` plus `FacetChips.review`.
  - grep shows src/knowledge/FacetChips.tsx and useBeliefChips.ts never read `.review`.
  - ReviewChip call sites (EntityDossier.tsx:72, KnowledgePanel.tsx:283, LearnedCard.tsx:74, RelatedKnowledge.tsx:159) all pass `concept.review`, which is file-derived.

**Correction.** The core claim is correct. Trust and review status come only from the file's `verified` field, in both TS (okf.ts) and Rust (`trust_tier`), so a forged `human:` stamp that the ledger refused still reads as human-reviewed on every surface and in agent-facing MCP output until someone resolves reconciliation. One detail is wrong: `BeliefChips` does carry a ledger-derived review axis, as `facets[].review` (`FacetChips.review`, bundle.rs:85 and mockIpc.ts ~1024). It is computed and sent to the UI, but no component reads it. The defect is "ledger review computed but unused", not "absent". No forged `verified` stamp exists in the live vault; the Aug 17 bypass changed `generated`, so this is a proven capability, not an observed exploit.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - Read side confirmed: TS reviewStatus/reviewedBy/humanReviewed read only `entry.properties.verified`. parseStamp needs only a `by` and never checks revision, hash or ledger. Rust trust_tier returns 'human-reviewed' for any `by` starting with 'human:', and get_note (mcp.rs:1933) and knowledge.rs:682 serve it to agents. No reader consults belief.attested.
- The ledger notices only at launch, as claimed: capture_out_of_band_with has one caller, launch_scan (reconcile.rs:320), which runs from shadow.rs:144 when the writer opens. The refusal ("provenance forgery", capture.rs:961-966) leaves the bytes on disk, and readers keep honoring them.
- Reachable in code, but only through other defects:
  - Native Write/Edit are granted only when shell is on. Shell defaults off (uiStore.ts:844), and internal runs disallow file tools.
  - The update_frontmatter guard (knowledge.rs:215 → is_knowledge_path, a plain `starts_with("knowledge/")`) does not strip './', while safe_join accepts CurDir components. So `./knowledge/x.md` gets past the guard, with no shell needed. The scope check (mcp.rs:159) does normalize './', which shows the guard's gap is an inconsistency.
  - The other doors refuse the stamp: propose_* rejects any serialized "verified" (mcp.rs:1527), and write_concept and create_note refuse it too.
- Overstated as high: this is the read-side amplifier of separate write-side bypasses, not a standalone hole, and nothing like it has happened in the live vault. No file in /Users/joseflagorio/Documents/test/knowledge has a `verified:` field. The Aug 17 incident changed `generated` stamps, not `verified`. The ledger has zero belief.attested events. So the current banner is not caused by this.

**Evidence checked.** - src/engine/okf.ts:135-155: parseStamp/parseVerified check only `by`, no ledger tie. Lines 190-222: reviewStatus, reviewedBy and humanReviewed read the file only. Lines 176-177 carry the "same answer read from two places" comment.
- src-tauri/src/knowledge.rs:428-451: trust_tier does a string prefix check on `human:`. It is called at knowledge.rs:682 and mcp.rs:1933.
- src-tauri/src/ledger/capture.rs:961-966: forgery refusal. The only caller of capture_out_of_band_with is reconcile.rs:320, reached from launch_scan, which shadow.rs:144 calls. There is no watcher-time capture.
- src-tauri/src/knowledge.rs:30-31,215-219: is_knowledge_path is a raw prefix check with no './' strip.
- src-tauri/src/vault/write.rs:167-171: safe_join allows Component::CurDir.
- src-tauri/src/mcp.rs:159: scope_admits strips './'. mcp.rs:2419: tool_update_frontmatter relies on guard_agent_write. mcp.rs:1527: propose_* refuses "verified".
- src-tauri/src/agent/mod.rs:580-585,622-634,660-677: Write/Edit are granted only when shell is on, internal runs disallow them, and non-internal runs use acceptEdits.
- src/stores/uiStore.ts:844: shell defaults off.
- Live vault: `grep -rl '^verified:' knowledge` finds nothing. Ledger event kinds: no belief.attested. The 3 divergent files differ only by `generated: {by: claude-code}`.

**Correction.** Accurate: trust is read only from the file's `verified` field, so a stamp the ledger refused as forgery still reads as human-reviewed in the TS review queue and in the Rust trust_tier served to agents, until someone restores at the next launch. Planting such a stamp needs one of two things: shell access turned on (off by default), or the `./knowledge/` spelling that gets past guard_agent_write in update_frontmatter. propose_*, write_concept and create_note all refuse it. It has not happened in the live vault: no `verified` stamps, no attestations. The Aug 17 divergence came from changed `generated` stamps, not `verified`. Severity is medium, as the read-side amplifier of a write-side bypass. Fix the ./ normalization in is_knowledge_path first.

</details>

### F108 — write_concept and cache_source bypass run write-scope and read-scope, so untrusted fetched content becomes knowledge that other agents read with no provenance

- **Severity (claimed):** high
- **Category:** write-path-bypass
- **Verification:** survived (partially_confirmed/medium, partially_confirmed/medium)
- **Locations:**
  - `src-tauri/src/mcp.rs:1328-1349`
  - `src-tauri/src/mcp.rs:1246-1256`
  - `src-tauri/src/mcp.rs:1370-1373`
  - `src-tauri/src/mcp.rs:3663-3667`
  - `src-tauri/src/mcp.rs:2608-2665`
  - `src-tauri/src/ingest/taint.rs:14-19`
  - `src/lib/prompts.ts:255`
  - `src-tauri/src/vault/write.rs:606-626`

**Evidence**

- write_target has no entry for write_concept or cache_source (mcp.rs:1246-1256), so scope is never checked for them.
- The exemption's stated reason, 'knowledge/ has its own guard (knowledge.rs)' (mcp.rs:3665), is false. guard_agent_write only stops OTHER tools from writing knowledge/.
- A record declaring `scope: []` means 'no writes' (mcp.rs:638-641) but can still create or replace any concept. The prompt says so openly (prompts.ts:255).
- read_target checks only get_note and knowledge_about (mcp.rs:1370-1373). A run that cannot read knowledge/ can still overwrite concepts blind: the tool replaces the whole concept, and nothing enforces 'only assert a relation whose target you read'.
- cache_source writes sources/ directly: no policy op and no taint assessment. source_taint_assessments has 0 rows in the live runtime.db.
- taint.rs:14-19 claims 'Source bytes have no direct mutator. Agents emit serde-valid proposals or nothing'. That is false for the served tools.
- The attestation HIGH gate exists only on the ledger path. The fallback (write.rs:606-626) replaces verified concepts with no gate, and it was the active path on Aug 17.
- Downstream: knowledge_about (knowledge.rs:489-513) and KnowledgeNote (context.ts:80-101) carry no `sources` and no `generated.by`.

**Impact**

A narrowly scoped or unattended run that reads a hostile web page or issue can rewrite any unverified concept and assert supersedes or contradicts against verified ones. When no ledger writer is active, it can overwrite verified concepts too. Other agents then consume that output as base knowledge and cannot tell that it came from external content.

**Recommendation**

- Give knowledge writes their own grant axis: an allowed-folders list under knowledge/, empty meaning none.
- Require read permission on the concept being replaced.
- Refuse write_concept when no ledger writer is active.
- Surface `sources` and `generated.by` in knowledge_about and the snapshot.
- Mark concepts that cite sources/ as external-derived.
- Fix the false taint.rs and exemption comments.

<details><summary>Verifier 1: partially_confirmed (severity → medium)</summary>

**Reasoning.** Parts of the mechanism are real:
- **Scope is not checked for these two tools.** `write_target` only recognises create_note, update_frontmatter and append_to_note. write_concept and cache_source get no folder-scope check. This is a deliberate, commented exemption (M17.13 comment, and the tripwire test's exempt list).
- **Read-scope is not checked either.** It is only checked for get_note and knowledge_about. A run that cannot read knowledge/ can still overwrite a concept without seeing it.
- **cache_source skips review.** It writes sources/ directly, with no policy op and no taint assessment.
- **The legacy path does not protect verified concepts.** When `shadow::with_writer` returns None, `vault::write::write_concept` overwrites the concept with no HIGH gate. Because the frontmatter is rebuilt without `verified`, the overwrite also silently removes the human's verification.
- **A self-declared relation is served without qualification.** An unverified concept that declares `supersedes` or `contradicts` against a verified one shows up in knowledge_about's `superseded_by` / `contradicts` for that verified concept. Nothing there says the declaring concept is unverified.

Parts of the claim are overstated or wrong:
1. **"No provenance" is false at the file level.** Both tools stamp `generated: {by: actor, at}` on the server, and the model cannot choose that value. write_concept also stores `sources`. What IS missing is narrower: knowledge_about (`AboutConcept`) and `KnowledgeNote` do not pass `generated.by` or `sources` on to the agents that read them. They do pass `trust`, so a reader can see a concept is "unverified", but not that it came from fetched content.
2. **"Unattended run" is wrong for Cerebro's own unattended runs.** Ingest and maintain runs are held by tests to never receive write_concept or cache_source. Those tests explain that a cached source would re-enter the next window at owner authority; ingest uses the reviewed propose_cache_source channel instead. So taint.rs's "no direct mutator" statement holds inside the ingest pipeline it describes. The gap applies to panel and vault-agent runs whose `allowedTools` is null, which is the default in useJobRunner and useAgentChat.
3. **"The knowledge guard is false" is overstated.** There is a real guard, just not a scope guard: knowledge/-only paths, governed-type refusal, `verified` never accepted from the agent, server-stamped `generated`, and on the ledger path a HIGH queue for rewriting a verified concept. The per-run tool allowlist also still applies to both tools.
4. **"Overwrite verified concepts" happens only on the fallback path.** On the ledger path that write queues as HIGH (concepts.rs:19-21; test at ~1211-1236). On the fallback the overwrite also drops the concept to "unverified", so readers are not served attacker text marked as verified.

Net: this is an integrity and prompt-injection risk for user-launched and vault-agent runs, bounded by the unverified trust tier. It is real but medium severity, not high.

**Evidence checked.** - `src-tauri/src/mcp.rs:1246-1256`: `write_target` has no arm for write_concept or cache_source, so both resolve to None (no scope check).
- `src-tauri/src/mcp.rs:1328-1334`: comment deliberately exempts both tools ("have their own guards (M17.1)").
- `src-tauri/src/mcp.rs:3663-3672`: the tripwire test's exempt list.
- `src-tauri/src/mcp.rs:1370-1373`: `read_target` covers only get_note and knowledge_about.
- `src-tauri/src/mcp.rs:2446-2520` (`tool_write_concept`):
  - knowledge/-only path check
  - governed_type_refusal
  - `generated` stamped server-side
  - `sources` stored when the agent passes it
  - `verified` never accepted
- `src-tauri/src/mcp.rs:~2600-2650` (`tool_cache_source`): stamps `generated.by` and calls `write_source` directly (write.rs:666-683), with no policy op and no taint call.
- `src-tauri/src/vault/write.rs:606-626`: legacy fallback when `ledger::concepts::write_concept` returns None.
  - `concept_write` (write.rs:629-657) rebuilds frontmatter with no verified check, so it replaces the concept and drops `verified`.
  - `ledger/shadow.rs` `with_writer` returns None for a refused ledger, a lost lock, or a different vault.
- `src-tauri/src/ledger/concepts.rs:19-21` and test ~1211-1236: on the ledger path, rewriting a verified concept is queued as HIGH (`queued_for_review`).
- `src-tauri/src/knowledge.rs:489-513` and 600-690: `AboutConcept` has `trust` but no `generated`/`sources`. `superseded_by` and `contradicts` are built from any concept's declared fields, with no trust filter on the declaring concept.
- `src/agent/context.ts` `KnowledgeNote`: `review` and `reviewedBy`, but no `sources` or `generated.by`.
- `src-tauri/src/ingest/spawn.rs:252-258` and `src-tauri/src/maintain/live.rs:181-188`: tests assert unattended internal runs never get write_concept or cache_source (propose_cache_source is the reviewed channel). So taint.rs:14-19 holds for its own pipeline.
- `src/agent/useJobRunner.ts:499`: `allowedTools: agent?.allowedTools ?? null`, so vault agents are unrestricted by default.
- `src-tauri/src/agent/mod.rs:1570-1574`: test asserts cache_source is always available to the panel.
- `src/lib/prompts.ts:255`: the prompt tells the agent that write_concept is not affected by scope.
- Live runtime.db: `source_taint_assessments` has 0 rows. This is consistent with no ingest runs having run, not proof that taint checks are bypassed.

**Correction.** write_concept and cache_source are deliberately exempt from folder scope and from read-scope, and cache_source writes sources/ with no review or taint check. That holds only for panel and vault-agent runs whose allowedTools is null (the default); Cerebro's own unattended ingest and maintain runs are barred from both tools. Provenance IS recorded: `generated.by` is stamped by the server on both tools, and write_concept stores `sources` when given. But knowledge_about and KnowledgeNote serve other agents only the trust tier, not `generated.by` or `sources`, so a reader can see a concept is unverified but not that it came from fetched external content. An unverified concept's self-declared `supersedes`/`contradicts` shows on verified concepts with no trust qualifier. Rewriting a verified concept queues as HIGH on the ledger path. Only the legacy fallback (no active ledger writer) overwrites it without a gate, and that overwrite silently removes the human's verification rather than serving the new text as verified.

</details>

<details><summary>Verifier 2: partially_confirmed (severity → medium)</summary>

**Reasoning.** - **Confirmed: scope is not checked for these two tools.** write_target only matches create_note, update_frontmatter and append_to_note, so write_concept and cache_source skip the folder-scope check. This is a documented design choice (the comment at mcp.rs:1328-1334 and the exemption table at 3663-3670).
- **Confirmed: the stated reason is false.** guard_agent_write in knowledge.rs only stops OTHER tools from writing knowledge/. write_concept itself is bounded by just three things: the path must be inside knowledge/, governed types are refused, and `verified` is never accepted from the agent.
- **Confirmed: read-scope does not bound it.** read_target covers only get_note and knowledge_about, so a run that cannot read knowledge/ can still replace a whole concept blind.
- **Confirmed: the fallback has no gate.** The legacy file-first path (write.rs:610-626) has no policy or attestation gate. When a ledger writer is active, write_concept goes through the policy table instead (concepts.rs route()), and policy.v3 raises target_has_attestation to a HIGH floor.
- **Overstated: "no provenance".** The server stamps `generated.by` itself (the model cannot set it), and `sources` is accepted and stored in the file. The live file shows both. Consumers are not blind either: knowledge_about returns lifecycle and trust, and KnowledgeNote returns review and reviewedBy. So other agents can tell a concept is unverified and agent-written. What they cannot see is that it came from external content, because `sources` and `generated.by` are not carried in those payloads.
- **Overstated: "narrowly scoped".** Scope is only the folder axis. The per-run tools allowlist (ungranted_tool_refusal, checked before any tool body runs) can leave out write_concept or cache_source, and then those calls are refused. So it is wrong that every narrowly scoped run can do this; only the folder scope is bypassed.
- **Not reachable in the live vault so far:**
  - There is no sources/ folder, so cache_source has never run.
  - No concept carries a `verified` stamp, so "overwrite verified concepts" has not happened.
  - The 0 rows in source_taint_assessments reflect that no ingest ran, not that one was bypassed. The taint.rs claim is about ledger Source/Observation bytes and M26 ingest proposals, not the sources/ markdown cache.
- **Aug 17 path is plausible but not proven.** It may well have been the legacy write_concept fallback: `generated.by` is claude-code (= DEFAULT_ACTOR), and there are auto-appended log Update lines. But the task facts do not rule out the other route.
- **Not the weakest point.** In shell mode an agent also gets Write, Edit and Bash, which bypass every Cerebro guard anyway.
- **Net:** a real design gap (no scope or read-scope on concept writes, and no gate on the fallback), but the "no provenance" impact and the verified-overwrite impact are overstated. Medium, not high.

**Evidence checked.** - **Scope check skips both tools.** src-tauri/src/mcp.rs:1246-1256: write_target matches only create_note, update_frontmatter and append_to_note; anything else returns None, which means no scope check. The exemption comment is at mcp.rs:1328-1334, and the test's exemption table at mcp.rs:3663-3670 says "knowledge/ has its own guard (knowledge.rs)".
- **The knowledge.rs guard does not bound write_concept.** src-tauri/src/knowledge.rs:215-220: guard_agent_write refuses knowledge/ paths so that other tools must use write_concept. It puts no limit on write_concept itself.
- **Reads are checked for two tools only.** mcp.rs:1370-1373: read_target covers get_note and knowledge_about.
- **Tools allowlist can still refuse them.** mcp.rs:1360-1362: ungranted_tool_refusal runs before any tool body, so a `tools` grant can exclude write_concept or cache_source.
- **Provenance is stamped by the server.** mcp.rs:2446-2505: tool_write_concept stamps `generated: {by: actor, at}` itself and accepts `sources`. mcp.rs:2608-2650: cache_source stamps `generated` too.
- **Fallback has no gate; ledger path does.** src-tauri/src/vault/write.rs:610-626: the legacy fallback writes file-first with no policy step. src-tauri/src/ledger/concepts.rs:324-380 and route() at ~389: the ledger path goes through PolicyTable. shared/policy/policy.v3.json:~122: escalator target_has_attestation → floor HIGH.
- **Consumers see trust but not origin.** knowledge.rs AboutConcept (~496-513) has lifecycle and trust but no sources or generated. src/agent/context.ts:80-101 KnowledgeNote has review and reviewedBy but no sources.
- **Live vault state:**
  - /Users/joseflagorio/Documents/test/sources does not exist.
  - Grepping knowledge/ for `verified` finds only prose, no `verified:` frontmatter field.
  - knowledge/decisions/gcs-5-supervision-ratio.md has `generated.by: claude-code`, and its `sources` points to inbox/capture-2026-08-16-1231.md.
  - runtime.db source_taint_assessments has 0 rows.
- **Actor and agent-profile defaults.** mcp.rs:42 has DEFAULT_ACTOR = "claude-code". agent/mod.rs tool_policy gives Bash, Read, Write and Edit when shell is on. demo-vault agents declare `tools: safe`, which means no shell (src/engine/libraryDraft.ts:131).

**Correction.** write_concept and cache_source do skip folder write-scope, and write_concept also skips read-scope. So an agent whose tools grant includes write_concept can create or blindly replace any unattested concept, including under `scope: []`. It can also set supersedes or contradicts against any concept. The legacy file-first fallback (write.rs:610-626) has no attestation gate. On the ledger path, revisions of attested beliefs are raised to HIGH by policy.

The claim overstates two things:
- **Provenance:** `generated.by` is stamped by the server and `sources` is stored in the file. Consumers do receive the trust or review state, so other agents know a concept is unverified agent output. They are not told it came from external content.
- **Tools allowlist:** a `tools` grant can exclude write_concept or cache_source entirely.

Reachability in the live vault: cache_source has never been used (no sources/), and no concept carries a verified stamp. Severity: medium.

</details>

### F109 — Agents get labels that are incomplete and contradictory: a `trust` key that doesn't exist, lifecycle dropped, and inbound contradictions dropped

- **Severity (claimed):** medium
- **Category:** parity
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src/agent/systemPrompt.ts:41`
  - `src/agent/context.ts:80-101`
  - `src/agent/context.ts:276-285`
  - `src-tauri/src/knowledge.rs:425-428`
  - `src-tauri/src/knowledge.rs:967`
  - `src/engine/okf.ts:172`
  - `src-tauri/src/mcp.rs:2020-2064`

**Evidence**

- The prompt says to weigh by `trust` ('human-reviewed' / 'unverified'), but the snapshot has only `review` ('unreviewed'|'current'|'predates_current') and `reviewedBy`.
- knowledge_about still speaks the retired three-rung vocabulary. trust_tier's doc says it 'Mirrors `trustTier` in src/engine/okf.ts', which M27.5c deleted (okf.ts:172), and the test `trust_tier_matches_the_typescript_engine` asserts against nothing. It collapses predates_current to 'unverified'.
- KnowledgeNote has no `lifecycle`. A `deprecated` concept (which write_concept defines as 'no longer true') and every `draft` (write_concept's default) are served as live claims, while dossier.ts:60 treats deprecated as retired.
- `contradictedBy` is the concept's own OUTBOUND `contradicts`, as raw targets (context.ts:276). A concept contradicted from the other end carries nothing. Rust about() (knowledge.rs:595-610) and readThread read both ends.
- Neither tool says whether a superseder is itself verified.

**Impact**

The panel agent can quote a deprecated or contradicted claim as current. It is told to read a field that isn't present. It sees two different trust vocabularies for the same concept, depending on whether it read the snapshot or called knowledge_about.

**Recommendation**

Define one agent-facing concept label: review, reviewedBy, lifecycle, both-direction contradictions, supersededBy with the superseder's review, and sources. Generate it from Rust and serve it to both the snapshot and knowledge_about. Fix the prompt text, and delete trust_tier and its stale mirror claim.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - Every cited defect is real, and the code that shows it is reachable from the panel. AiPanel.tsx:265/399 builds `concepts` and passes them in, and AiPanel.tsx:373 declares the `knowledge` capability, so the prompt line and the snapshot both reach the agent.
- **`trust` key that doesn't exist:** systemPrompt.ts:41 tells the agent to weigh claims by `trust` (`human-reviewed` / `unverified`). KnowledgeNote (context.ts:80-101) has no such field. It carries `review` ('unreviewed' | 'current' | 'predates_current') and `reviewedBy`.
- **Two trust vocabularies:** knowledge_about prints the old three-rung `trust_tier` (knowledge.rs:682, mcp.rs:2041). Its doc says it mirrors `trustTier` in okf.ts, but okf.ts:172 says `trustTier` was folded into ReviewState, and grep finds no `trustTier` in src/. So the parity test at knowledge.rs:967 checks against nothing.
- **`predates_current` collapses to 'unverified':** in that state `verified` is a string notice, not a stamp list. `trust_tier` finds no `by` and returns 'unverified'. This is defensible, since okf.ts says such a concept "still reads as unverified", but it is a different label from the snapshot's.
- **Lifecycle dropped:** KnowledgeNote has no lifecycle, and knowledgeFor (context.ts:262-285) never filters or flags `deprecated`. dossier.ts:60/63 and jobs.ts:174 do treat deprecated as retired. So a deprecated concept reaches the panel as a live claim. write_concept defaults to `draft` (mcp.rs:2497), and drafts are served with no marker either.
- **Inbound contradictions dropped:** context.ts:276 uses `concept.relations.contradicts`, which comes from parseRelations(entry) (okf.ts:620) and holds only the concept's own outbound links, as raw targets. Rust about() (knowledge.rs:~595-660) builds a reverse `contradicted_by` map and merges both ends. The snapshot does neither.
- **Superseder's own verification:** neither the snapshot nor mcp.rs:2044-2049 says whether the superseding concept is verified. This is minor.
- **Severity:** medium stands. These are reachable prompt and labelling defects that can mislead the agent (deprecated or one-sidedly contradicted claims shown as current). They do not corrupt data and are not tied to the divergence incident.

**Evidence checked.** - src/agent/systemPrompt.ts:41 (the "Weigh it by `trust` — `human-reviewed` ... `unverified`" line, gated on capabilities.includes('knowledge') at L33)
- src/agent/context.ts:81-101 (KnowledgeNote: review, reviewedBy, contradictedBy?, supersededBy?, stale?; no trust, no lifecycle)
- src/agent/context.ts:276-285 (`const contradicted = concept.relations.contradicts`; no lifecycle handling)
- src/engine/okf.ts:620 (relations: parseRelations(entry) — outbound only)
- src/engine/okf.ts:172 ("subsumes the old three-rung `trustTier`"; grep finds no trustTier symbol in src/)
- src-tauri/src/knowledge.rs:425-450 (trust_tier: string `verified` → no `by` → "unverified")
- src-tauri/src/knowledge.rs:595-660 (contradicted_by reverse map merged into contradicts)
- src-tauri/src/knowledge.rs:682 (trust: trust_tier(entry))
- src-tauri/src/knowledge.rs:967 (trust_tier_matches_the_typescript_engine)
- src-tauri/src/mcp.rs:2030-2064 (knowledge_about prints lifecycle and trust; superseded_by without verification state)
- src-tauri/src/mcp.rs:2497 (lifecycle defaults to "draft")
- src/engine/dossier.ts:60,63 and src/engine/jobs.ts:174 (deprecated treated as retired)
- src/agent/AiPanel.tsx:265,373,399 (reachability)

</details>

### F110 — While reconciliation is open, every agent read serves the disputed disk bytes and gives no signal

- **Severity (claimed):** medium
- **Category:** invariant-violation
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src-tauri/src/mcp.rs:1754`
  - `src-tauri/src/mcp.rs:1916-1921`
  - `src-tauri/src/mcp.rs:1972-1976`
  - `src/agent/AiPanel.tsx:375-400`
  - `src-tauri/src/knowledge.rs:571-697`

**Evidence**

- get_vault_context, get_note, search_notes and knowledge_about all call vault::scan::scan_vault on disk. mcp.rs never mentions reconciliation or the manifest.
- The panel snapshot is built from the scanned entries.
- In the live vault, the 3 divergent files (gcs-5-supervision-ratio, the two tx-6 risks) are served as ordinary 'stable' concepts. Their bytes don't match the manifest, and the ledger refused them.
- Combined with the trust finding: a disputed file's `verified` stamp would be served as 'human-reviewed'.
- Prior #78 covers the UI side only.

**Impact**

For 39 days, agents built on claims the system itself flags as unexplained, and wrote new concepts on top of them. That grows the dispute the banner asks the human to settle.

**Recommendation**

Have ledger_status' divergence sample paths flow into the read tools. Mark those concepts as 'disputed: file differs from recorded history' in knowledge_about, get_note and the snapshot, or serve the recorded projection with the disk version attached.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** Code check: the claim holds. mcp.rs has no reference to reconciliation or the projection manifest; its only "manifest" hits are the assembly WorkingMemoryManifest. The read tools route through call_tool at mcp.rs:1398-1401 to vault::scan::scan_vault on disk (mcp.rs:1754, 1916, 1972-1976). knowledge::about (knowledge.rs:571-697) derives lifecycle and trust only from frontmatter. None of src/agent (AiPanel.tsx, context.ts, useJobRunner.ts) reads ledgerStatus or reconciliation state. So while reconciliation is open, agents are served the disputed bytes with no signal.

Impact check: the impact is not supported by the data.
- Ledger: of the events from seq 178 onward, 94 are vault.write, 1 is projection.overridden and 1 is ledger.divergence. The writes from seq 181 to 273 touch only collection.yml, bets.list.yml, types/*.md, records/* and home/untitled.md. None touch knowledge/.
- Vault git: `git log --since=2026-08-17T11:58 -- knowledge` is empty.
- Disk: `find knowledge -newermt '2026-08-17 12:00'` is empty.
So "agents wrote new concepts on top of them for 39 days" did not happen. Also, gcs-5-supervision-ratio.md and the two tx-6 risk files have no `verified:` key. trust_tier (knowledge.rs:428-450) therefore returns "unverified", and the "served as human-reviewed" add-on does not apply to these files. The disputed bytes are also the agent's own Aug 17 output, stamped generated.by claude-code, so an agent reading them sees its own unverified work. That is a real gap to close, since reads should carry a disputed marker, but it is low severity as observed.

**Evidence checked.** - src-tauri/src/mcp.rs:1398-1401: dispatch to tool_vault_context / tool_search / tool_get_note / tool_knowledge_about.
- mcp.rs:1754 and :1916: scan_vault(vault).
- mcp.rs:1928-1929: Trust header from knowledge::trust_tier.
- mcp.rs:1972-1976: scan_vault then filter by grant.
- grep -i reconcil on mcp.rs, knowledge.rs, src/agent/*: no reconciliation gating. The only hits are unrelated comments at AiPanel.tsx:307, context.ts:48 and useJobRunner.ts:93.
- src-tauri/src/knowledge.rs:428-450: trust_tier returns "unverified" when there is no `verified` key.
- knowledge.rs:~655: lifecycle defaults to "stable".
- /Users/joseflagorio/Documents/test/knowledge/decisions/gcs-5-supervision-ratio.md frontmatter: lifecycle: stable, generated.by claude-code 2026-08-17T11:52:02Z, no verified field. The same holds for the two tx-6 risk files (grep for verified/generated finds only `generated:`).
- Ledger d62256b3...0001.ndjsonl.open, events from seq 178 onward: Counter{vault.write:94, projection.overridden:1, ledger.divergence:1}. Paths for seq 181-273 are all outside knowledge/.
- `git log --since=2026-08-17T11:58 -- knowledge` in the live vault: empty.
- `find knowledge -newermt '2026-08-17 12:00'`: empty.

**Correction.** The mechanism is real. Agent read tools (get_vault_context, search_notes, get_note, knowledge_about) and the panel snapshot serve disk bytes and never mention reconciliation, so agents get no signal that 3 concepts are disputed. The claimed impact is overstated on two counts. (1) Nothing was built on top of the disputed files: after the divergence at seq 180 there are no knowledge/ writes in the ledger, no vault git commits touching knowledge/, and no knowledge/ file changed after 2026-08-17 12:00. (2) The disputed files have no `verified` field, so trust_tier serves them as "unverified", not "human-reviewed". They also do show "lifecycle: stable", but that comes from the files' own frontmatter. What remains is a latent design gap with no observed harm in the live vault.

</details>

### F111 — Nothing records whether the base is read. The one surviving transcript shows 6 writes and 0 knowledge_about calls, and no anchor in the live vault reaches a record.

- **Severity (claimed):** medium
- **Category:** data-quality
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src-tauri/src/mcp.rs:277-308`
  - `src-tauri/src/assembly/ask.rs:272`
  - `src-tauri/src/runtime/governance.rs:470-512`
  - `src/lib/prompts.ts:15-35`
  - `src/lib/prompts.ts:82-87`

**Evidence**

- runtime.db, read-only: 19 runs (2026-08-15 to 08-30), all lane=agent/attended. run_cost_components 0 rows, assembly_metrics 0, working_memory_manifests 0.
- note_tool_call counts are drained only by the attended assembly path (ask.rs:272), which has 0 runs. Every other run's counts are discarded (forget_tool_calls) or never drained.
- The meter drops the CLI's `tool_uses`: all 19 operational_log rows read 'usage fields this build does not read: ... tool_uses'.
- The only persisted transcript (~/.claude/projects/-Users-joseflagorio-Documents-test/638cbe80….jsonl, Aug 16–30): write_concept 6, knowledge_about 0, get_vault_context 1, search_notes 6, get_note 2.
- Live vault: 0 of 62 `about` anchors resolve to any note outside knowledge/. knowledge_about(record), the snapshot's knowledge list and RelatedKnowledge are empty for every record.
- distillPrompt never names knowledge_about, although askBasePrompt's own comment (prompts.ts:82-87) says keyword search misses anchored concepts.

**Impact**

The base is written (paid, unattended) but in practice never read back. The app has no metric that could show this: 'reads vs writes' is unmeasured, not zero.

**Recommendation**

- Persist per-tool counts for every run, e.g. a run_tool_calls table drained at run finalize.
- Read `tool_uses` in the meter.
- Name knowledge_about in distillPrompt and the lane prompts.
- Reject or warn on `about` anchors that don't resolve to a vault note.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** - **What holds:**
  - The code says what the claim says. `note_tool_call` counts every loopback dispatch per run in memory (`mcp.rs:1326`). `take_tool_calls` is drained by `assembly/ask.rs:272` only; every other production caller is `forget_tool_calls` at eviction (`mcp.rs:218`) or a test.
  - The runtime.db copy shows 19 runs, all lane=agent and mode=attended. `assembly_metrics`, `run_cost_components` and `working_memory_manifests` are all 0. So the attended assembly drain never fired, and nothing persisted which tools any run called.
  - The one persisted transcript shows write_concept 6, search_notes 6, get_note 2, get_vault_context 1, knowledge_about 0. `knowledge_about` was loaded into that session (deferred_tools_delta) and never called. Its subagent made only `Read` calls.
  - `distillPrompt` never names `knowledge_about`. Its step 2 says "Search the bundle", which is exactly the keyword search that `askBasePrompt`'s comment (prompts.ts:82-87) calls lossy.
  - All 62 `about` anchors resolve inside `knowledge/` or not at all: 54 point to other concepts, 8 point to nothing.
- **What is wrong or overstated:**
  1. **Meter detail is wrong.** Only 5 of the 19 operational_log rows list `tool_uses` among the usage fields this build does not read. The other 14 list only inference_geo, iterations or speed. It is not "all 19".
  2. **The anchor finding comes from the test vault, not the design.** The live vault has only 16 notes outside `knowledge/`, and they are stubs (untitled, test, kk, new-agent, inbox captures). The domain content (decisions/risks/programs/systems) was itself written as concepts inside `knowledge/`, so there are no real records to anchor to. "Empty for every record" reflects a vault with no records, not a read-path defect.
  3. **"Never read back" rests on one session.** That session came from 1 of 19 runs, and the other transcripts are gone. It is suggestive, not established. The UI read path (RelatedKnowledge, EntityDossier, `askBasePrompt`) exists and is wired.
- **What survives:** a real observability gap. Reads versus writes are unmeasured for every run type except the attended assembly path, and that path has zero runs. By the project's own "absent is never zero" rule this is a missing metric, not a correctness bug. It is low severity, not medium.

**Evidence checked.** - `src-tauri/src/mcp.rs:277-283`: `note_tool_call`.
- `src-tauri/src/mcp.rs:285-298`: `take_tool_calls`, whose doc comment says it is drained by the attended assembly path "and by nothing else".
- `src-tauri/src/mcp.rs:218`: `forget_tool_calls` on eviction. The only other callers are tests (`mcp.rs:3295-3338`).
- `src-tauri/src/assembly/ask.rs:272`: the single production drain.
- `src-tauri/src/runtime/governance.rs:470-512`: `log_tool_call_breakdown`, reached only from `record_from_assembly`.
- runtime.db copy (read-only):
  - `runs`: 19 rows, 2026-08-15T14:43Z to 2026-08-30T23:26Z, lane agent=19, mode attended=19.
  - `assembly_metrics`, `run_cost_components` and `working_memory_manifests`: 0 rows each.
  - `operational_log`: 19 rows, all agent.usage/capability_unavailable. Only 5 name `tool_uses` ("inference_geo, duration_ms, tool_uses, total_tokens, iterations, speed"), 12 name "inference_geo, iterations, speed" and 2 name "inference_geo".
- Transcript `~/.claude/projects/-Users-joseflagorio-Documents-test/638cbe80-b476-4eb1-b067-7dc76d8b89e3.jsonl`: tool_use counts search_notes 6, write_concept 6, Read 5, get_note 2, open_note 2, get_vault_context 1, knowledge_about 0. `knowledge_about` appears only in a deferred_tools_delta. The subagent transcript has Read 11.
- `src/lib/prompts.ts:15-35`: `distillPrompt` has no `knowledge_about`. `prompts.ts:82-97`: `askBasePrompt` names it first.
- Live vault: 62 `about` links in `knowledge/**`, 0 resolve outside `knowledge/`, 54 resolve inside it, 8 are unresolved (kos-3.2, mb-boot, mpm-410, sib-220). Only 16 .md files exist outside `knowledge/` and dotdirs, all stubs (e.g. `records/tasks/kk.md`, `records/bets/test.md`, `home/untitled.md`). `knowledge/decisions/gcs-5-supervision-ratio.md` anchors to [[compass-gcs-5]] and to itself.

**Correction.** - Nothing persists per-tool read counts except the attended assembly path (`ask.rs:272`), which has 0 runs. So reads versus writes are unmeasured for every run in runtime.db (19 runs, all agent/attended).
- The one surviving transcript shows 6 write_concept calls and 0 knowledge_about calls, even though the tool was loaded. `distillPrompt` does not name `knowledge_about`.
- The meter drops `tool_uses` on 5 of the 19 runs, not all 19.
- No anchor reaches a record because the live vault has essentially no records outside `knowledge/` (16 stub notes). Its domain objects were all authored as concepts inside `knowledge/`, so the empty `knowledge_about`(record) result reflects the vault's contents, not a broken read path.
- "Never read back" is an inference from one session and is not established.
- Real finding: a missing read metric. Severity low.

</details>

### F112 — Rust and TS concept semantics are hand-copied, and the copies already disagree

- **Severity (claimed):** medium
- **Category:** parity
- **Verification:** survived (confirmed/medium)
- **Locations:**
  - `src-tauri/src/knowledge.rs:49-116`
  - `src/engine/okf.ts:847-869`
  - `src/engine/okf.ts:636-640`
  - `src-tauri/src/knowledge.rs:687`
  - `src-tauri/src/ledger/concepts.rs:266-289`
  - `src/engine/wikilink.ts:58-74`

**Evidence**

- Near-duplicates:
  - Rust compares `about` as lowercased literal strings (normalize_anchor, knowledge.rs:110). TS resolves anchors to paths (okf.ts:852, 863). `[[Compass GCS-5]]` and `[[compass-gcs-5]]` are one anchor in the UI and two in the write-time warning.
  - Rust doesn't exclude pairs that already declare a relation (TS does, okf.ts:857-859), so write_concept tells the agent to 'set supersedes' even when it already did.
  - The Rust doc claims it 'Mirrors titleOverlap'.
- Supersession: TS keeps a single supersededBy, and the last declarer wins (okf.ts:639). Rust keeps a Vec (knowledge.rs:687).
- Relation resolution comes in three forms: ledger exact-case `[[stem]]` only; TS resolveTarget (case-insensitive stem, then project folder, then title, plus path and plain-string forms); Rust TargetIndex.
- Stale has three definitions (prior #61, not repeated).

**Impact**

The warning an agent gets at write time and the pair the UI shows disagree. A relation the UI shows may not exist in the ledger. A second superseder is hidden in the UI but listed to agents.

**Recommendation**

Move concept semantics to one place: Rust-derived, served over IPC, or a shared data table with goldens, like shared/policy. Delete the TS/Rust twins, or add parity vectors like conformance/.

<details><summary>Verifier 1: confirmed (severity → medium)</summary>

**Reasoning.** - Every cited site exists and is live. The Rust copies carry "Mirrors X in okf.ts" doc comments but behave differently from the TS they claim to mirror.
- **Near-duplicates:** Rust `normalize_anchor` compares lowercased literal strings with the brackets stripped. TS resolves each anchor through `resolveTarget` (stem, then project folder, then title) and compares the resolved paths. So `[[Compass GCS-5]]` (a title) and `[[compass-gcs-5]]` (a stem) are one anchor in the UI but two in Rust.
- TS drops pairs that already declare a relation (`conceptEdges`); Rust never does. Reachable: mcp.rs:2531 runs it on every new `write_concept`, and mcp.rs ~2555 then tells the agent to "set `supersedes`" even if the args already do.
- **Supersession:** TS has one `supersededBy` slot, overwritten in the second pass. Concepts are sorted by id, so the last declarer by id wins and earlier ones are hidden. Rust `about()` (served to agents) collects every declarer into a Vec. Confirmed.
- **Relation resolution:** the ledger's `intended_relations` looks up the raw `[[...]]` inner text as an exact-case key in a stem map. There is no lowercasing and no title or folder fallback, and anything unmatched is silently skipped.
  - TS `resolveTarget` is case-insensitive and checks stem, then folder, then title; `resolveConcept` also accepts path forms.
  - So a relation the UI draws (e.g. `[[Some Title]]` or wrong case) never becomes a ledger relation.
  - Rust `resolve_concept` uses `TargetIndex`, a third implementation.
- **Minor overstatements:**
  - TS's "last declarer wins" is deterministic (last by id), not arbitrary.
  - The near-duplicate mismatch only changes an advisory warning, not a write.
  - The stronger part of the finding is the ledger's exact-case relation lookup, which silently drops relations that are meant to exist.
- Medium severity stands. This is also the twin-implementation pattern AGENTS.md warns about, though it is in concept semantics rather than `shared/policy`.

**Evidence checked.** - `src-tauri/src/knowledge.rs:49-116`: `near_duplicates` and `normalize_anchor` (trim, strip `[[ ]]`, lowercase). There is no exclusion for related pairs.
- `src-tauri/src/knowledge.rs:129`: "Mirrors `titleOverlap` in src/engine/okf.ts — the UI shows the same pairs this warns about".
- `src/engine/okf.ts:847-869`: anchors resolved via `resolveTarget(t, entries)?.path ?? t`; `related` built from `conceptEdges` and filtered out.
- `src-tauri/src/mcp.rs:2518-2536, ~2550-2557`: `near_duplicates` called for new concepts; the warning text says "set `supersedes` on this one if it replaces them".
- `src/engine/okf.ts:627-642`: `listConcepts` sorted by id; the second pass sets `replaced.supersededBy = concept.entry.path`, overwriting any earlier value.
- `src-tauri/src/knowledge.rs:597-612, 687`: `replaced_by: BTreeMap<String, Vec<String>>`, with `superseded_by` taken from that Vec.
- `src-tauri/src/ledger/concepts.rs:266-289`: `intended_relations` builds `stems` from `stem_of(path)` and does an exact `stems.get(&link)` lookup.
- `src-tauri/src/ledger/migrate.rs:634-654`: `wikilinks` only strips brackets; there is no case folding.
- `src/engine/wikilink.ts:58-74`: `resolveTarget` lowercases and checks stem, then `project.md` folder, then title.
- `src/engine/okf.ts:718-733`: `resolveConcept` handles path forms, then falls back to `resolveTarget`.
- `src-tauri/src/knowledge.rs:537-556`: Rust `resolve_concept` falls back to `TargetIndex::resolve`.

</details>

### F113 — Governed ledger state (superseded, archived, contested, qualification) never reaches any reader

- **Severity (claimed):** low
- **Category:** parity
- **Verification:** survived (partially_confirmed/low)
- **Locations:**
  - `src-tauri/src/ledger/reduce.rs:457-474`
  - `src-tauri/src/ledger/reduce.rs:501-512`
  - `src-tauri/src/ledger/reduce.rs:4140-4205`
  - `src-tauri/src/policy/expand.rs:358-395`
  - `src/lib/mockIpc.ts:1035-1042`

**Evidence**

- The projection is current fields plus the review overlay plus overrides (reduce.rs:457-474). The descriptor comment admits 'the digest advances even when the rendered bytes do not' for lifecycle changes.
- apply_relation never touches fields.
- retire() and supersede_members emit lifecycle and relation events only.
- No TS code reads governance.lifecycle or contest state (grep).
- It is latent: the proposal surface is off in the live config (agentProposalsEnabled:false), so write_concept's enrichment is the only proposal source today.

**Impact**

Once proposals are on, a human-approved HIGH or CRITICAL deprecate, supersede, archive or contest changes nothing in the UI, knowledge_about or the agent context. The approved retirement is invisible, while an ungoverned frontmatter `supersedes` is visible.

**Recommendation**

Project governed lifecycle and contest state, into the file (a reserved key) or into belief chips, before enabling the proposal surface. Make it the single source that the retirement rules read.

<details><summary>Verifier 1: partially_confirmed (severity → low)</summary>

**Reasoning.** The claim that governed state "never reaches any reader" is false. Several Rust readers consume it, and they are wired to the UI.
- Lifecycle (superseded or archived) reaches the Validity chip. `dynamics/validity.rs` `lifecycle_of` feeds `validity_of`, which the `belief_chips` IPC calls. The TS side renders it through `useBeliefChips` → `FacetChips` in EntityDossier and KnowledgePage.
- Lifecycle, qualification and contest open/close all show up as `ChangeKind`s in `convergence/diff.rs`. The `converge` IPC carries them to BaseItself.tsx as "became contested" and similar lines.
- Qualification also drives the `attention_lanes` reliance index, which BaseItself consumes.
- Lifecycle selects retired beliefs for the assembly Historical intent. An open contest gates maintain candidates.

What the claim gets right:
- `overlaid()` and `projected_bytes()` render only the current fields, the review overlay and the overrides. So an approved archive, supersede or contest never changes the projected markdown.
- File-driven readers (`knowledge.rs` concept graph, `knowledge_about`, MCP concept context) read frontmatter `supersedes`/`contradicts`, not ledger lifecycle.
- The Validity chip's "contested" comes from contradiction edges and live `contradicts` relations, not from `open_contest_event`. A governed `belief.contested` event therefore does not turn the chip to contested; it only shows as a change entry.

The grep claim "no TS reads lifecycle/contest" is technically true, but misleading: Rust pre-composes the text and TS renders it verbatim, by design. The issue is latent because proposals are off, so low severity is correct.

**Evidence checked.** - src-tauri/src/ledger/reduce.rs:457-468: `overlaid()` uses current fields + `apply_review_overlay` + override ops only. No lifecycle, contest or qualification, so file bytes ignore governed state (confirmed).
- src-tauri/src/dynamics/validity.rs:116-131: `conflict_of` uses `contradiction_edges` + `Contradicts` relations and ignores `open_contest_event`. validity.rs:133-143: `lifecycle_of` maps Superseded/Archived. validity.rs:96-99: `describe()` names lifecycle when not active.
- src-tauri/src/dynamics/bundle.rs:133: calls `validity_of`. src-tauri/src/lib.rs:605: `belief_chips` IPC. src/lib/ipc.ts:362. src/knowledge/useBeliefChips.ts:52. src/knowledge/FacetChips.tsx:92-94 renders `validity_text`, used by EntityDossier.tsx:139 and KnowledgePage.tsx:33.
- src-tauri/src/convergence/diff.rs:362-375: QualificationChanged, LifecycleChanged, ContestOpened/Closed. attention/status.rs:260-261. lib.rs:563 `converge` IPC → ipc.ts:380 → src/knowledge/BaseItself.tsx.
- src-tauri/src/attention/lanes.rs:785: reads qualification. `attention_lanes` IPC → ipc.ts:372 → BaseItself.tsx.
- src-tauri/src/assembly/assemble.rs:402: reads lifecycle. src-tauri/src/maintain/candidates.rs:242: reads `open_contest_event`.
- src-tauri/src/knowledge.rs:585-605: concept graph reads frontmatter `supersedes`/`contradicts` only (the part of the claim that holds).
- src-tauri/src/policy/expand.rs:358-395: `retire()` emits only `BeliefLifecycleChanged` (confirmed).

**Correction.** Governed lifecycle and qualification do reach readers:
- The Validity chip shows superseded or archived.
- The converge changes view lists lifecycle, qualification and contest changes.
- Attention lanes read qualification.
- Assembly's Historical intent reads lifecycle.
- Maintain candidates read open contests.

They do not reach three places:
- The projected markdown bytes.
- The file-frontmatter-driven concept graph, knowledge_about and the MCP concept context, which still read frontmatter `supersedes`/`contradicts`.
- The Validity chip's "contested" flag, which ignores governed `belief.contested` events and only reflects contradiction edges and `contradicts` relations.

So a governed retirement changes chips and change feeds, but not the file or what agents are served from files.

</details>
