# `shared/policy/` — mutation governance as data (M24)

These files are **the** policy. Rust compiles them in with `include_str!`
(`src-tauri/src/policy/`); TypeScript imports the identical files through vite
(`src/lib/policy/`). Neither language holds a rule the other has to be trusted
to have copied correctly.

**The house rule: a policy rule implemented as twin Rust and TS code is a
review-blocking defect.** If a rule cannot be expressed in the table, the table
format grows. Parity is the shared artifact plus the shared goldens — never
review of two hand-mirrored implementations. (Escape hatch if interpreter drift
ever appears: compile the Rust policy crate to WASM for the mock. Not
preemptively.)

## The files

| File | What it is |
| --- | --- |
| `policy.v3.json` | **The table** (`format: 3`, M27.4): target classes, predicates, transitions, rejection destinies, escalators, capability gates, silence/absence/high-stakes/preventive-ancestry/contradiction-addressing rules, the risk ladder, and one row per op. |
| `policy.v3.sha256` | SHA-256 of `policy.v3.json`'s bytes. Rust and TS each hash what they loaded and compare against this file — the only way two processes in two languages assert the *same* bytes rather than each asserting self-consistency. |
| `policy.v2.json` + `.sha256` | **Frozen** (`format: 2`, M26). The negative control for M27.4's contradiction-preservation gate: a table that parses cleanly, binds `open_contradictions_addressed` to the same five ops, and simply predates `contradiction_edges` being available. Registration against it refuses BY NAME. |
| `policy.v1.json` + `.sha256` | **Frozen** (`format: 1`, M24–M25). Not history for its own sake: it is the negative control for M26.3's live-registration gate — a table that parses cleanly and simply predates `no_self_ancestry`. All loaders still read it, and nothing edits it. |
| `authority-routes.v1.json` | The current predicate- and stage-specific authority routes (D11). |
| `authority-routes/<hash>.json` | Immutable content-addressed snapshots. A queued proposal pins `(route_id, rule_version, artifact_hash)`, so an approval tomorrow is evaluated against the rule the agent was actually shown. |
| `independence-rules.v1.json` + `.sha256` | The two deterministic positive-independence predicates (M25.5), loaded by `src-tauri/src/ingest/independence.rs`. `rule_version` is bumped by ANY predicate change and pinned into every event the producer emits. |
| `freshness.v1.json` + `.sha256` | When a claim goes stale, by predicate class (M27.1) — `time_basis`, `staleness`, and whether an attestation may anchor. Loaded by `src-tauri/src/dynamics/freshness.rs`. `rule_version` is stamped into every `freshness.transitioned` event. |
| `coverage-fold.v1.json` + `.sha256` | The Coverage dimension precedence and summary fold (M27.2). Loaded by `src-tauri/src/dynamics/coverage.rs`; `fold_rule_version` is carried on every folded answer. |
| `staleness.v1.json` | When a concept is stale (M49.8): inclusive of its `stale_after` date, and a value that is not exactly a YYYY-MM-DD date (a non-string included) reads as stale — an unknown horizon is surfaced, never treated as "never". Read by `knowledge::is_stale` (Rust) and `staleFrom` (src/engine/okf.ts); both replay its `cases`, so the two evaluators cannot drift, and Rust also checks that `validate_stale_after` refuses every malformed case. |
| `links.v1.json` | Where the webview may go (M53.12): its entry document (`tauri://localhost` at one of `entry.paths`, or the devUrl under `tauri dev`, with no credentials and no query) loads, an `external_schemes` address leaves for the system browser, and everything else is refused. A path or query on the app's own origin is refused too, because tauri's asset fallback serves `index.html` for any path it cannot find (tauri-2.11.5 manager/mod.rs:405-425), so following one reloads the app and drops unsaved state. Read by `shell::links` (Rust), which routes every navigation and every new-window request through it, and by `isWebUrl` (src/mermaid/flowchart/linkTargets.ts) for the scheme list; both replay its `cases`, and Rust also checks the artifact is closed and canonical. |
| `agent-links.v1.json` | Open with's agent links (M55.9): four targets in menu order, each an id, a label, a base and a query param, and `max_url_bytes` (8192, the whole URL). A link is the base, `?`, the param, `=` and the prompt percent-encoded with `encodeURIComponent`'s set; a longer one is never opened and the prompt is copied instead. Rust (`shell::open`) builds every URL, checks the cap and replays the `cases`; TypeScript (`OpenWithMenu`) reads only the ids and labels and never builds a URL or checks a length, so no rule is twinned. No digest, like `links.v1.json`. |
| `run-options.v1.json` | What a run may ask Claude Code for (M56.5): the five `effort_levels` 2.1.250's `--effort` takes, with labels; the model-name shape (`max_chars`, an ASCII letter or digit `first`, then the `also` characters); the `model_suggestions` the pickers offer; the refusal `messages` and `value_chars`, the cut a refused value is quoted at. Absent or blank is unset, which passes no flag. Read by `agent::run_options` (Rust, strict parse), which refuses a run before it starts in `run_agent`, `hand_to` and `spawn_run`, and by `src/engine/runOptions.ts`, which draws the agent page's rows and the composer's picker and gives the browser mock Rust's refusals word for word; both replay its `cases`. No digest, like `links.v1.json`. |
| `lanes.v1.json` + `.sha256` | The four attention lanes (M27.6): lane order, the reason codes each lane may emit and their within-lane order, the reliance vocabulary, whether the debt lane requires reliance, and (M27.7) which lanes are PROTECTED under §33. Loaded by `src-tauri/src/attention/lanes.rs`, which refuses to start if the artifact and the code disagree about EITHER set — a lane or reason declared with no code behind it renders as permanently empty, which reads as "nothing here" — and refuses an artifact that protects nothing, because a firewall with no protected class is a comment. M27.9 added the three §78/§80 hygiene reasons to the debt lane — `dynamics::hygiene` had computed them since M27.2 with no caller, which is the same as not computing them. M49.10 (K31) stopped emitting `coverage_unassessed` as a lane item: no coverage assessor has shipped, so it pinned every belief in the protected blindness lane. It stays declared for the day an assessor leaves only some beliefs unassessed; until then the lanes COUNT unassessed beliefs (`Lanes::unassessed`) and the view says so — in the empty blindness lane's line, or in `incomplete` when the lane holds assessed items — so an empty lane never reads as "no coverage gaps". |
| `critical-attention.v1.json` + `.sha256` | §8's bypass (M27.7): the deliberately small, complete inventory of deterministic signals that must not wait in a lane. Each trigger declares its required typed fields, the comparison operators and durations, and the copy key; the artifact declares the replacement relation and its DIRECTION. Interpreted by `src-tauri/src/attention/critical.rs` and `src/lib/attention/critical.ts` — two interpreters, one artifact, and no rule written in either language. **Adding a trigger is an artifact change plus a vector change, never hidden code.** |
| `goldens-critical/*.json` | The bypass's parity mechanism, replayed by `cargo test` and `pnpm test:run` from the same bytes. Every shipped trigger has five: positive, boundary, replaced, wrong-environment, malformed — and BOTH suites assert that all five exist for every trigger, so a new trigger without vectors fails the build rather than shipping unchecked. |
| `trigger-registry.v1.json` + `.sha256` | The M28 deferral registry's evaluable half: the fourteen R1–R14 entries, each gate key's required evaluation variant, scope, and parent rule, the metric name/unit tables, and the measurable protocols' floors. (R15–R17, registered 2026-08-14 by M31.8, deliberately postdate v1 — see the trigger-registry judgment calls below.) Interpreted by `src-tauri/src/trigger/registry.rs` and `src/lib/trigger/registry.ts` — two interpreters, one artifact. A combination the artifact does not name resolves to nothing, which IS the refusal. R14's `registered_connectors` is the one deliberately empty list: no connector qualifies yet, and a fake registration to satisfy a validator would be worse. |
| `goldens-trigger/*.json` | The trigger registry's parity mechanism (M28.0), replayed by `cargo test` and `pnpm test:run` from the same bytes. Each golden is a full `TriggerEvaluation` record (sometimes with its parent) and the outcome both validators must land on: `accepted`, or a refusal named by its CLOSED code — codes are the contract, prose is not. Both suites also assert every refusal code has at least one golden, so a code with no fixture fails the build. Accepted goldens carry ids that genuinely recompute (`sha256(domain\0gate\0scope\0rule_version\0snapshot_hash)`). |
| `goldens/*.json` | Proposal + preconditions → expected verdict + destiny. Replayed by `cargo test` and `pnpm test:run` from these same files. A fixture may declare `signals` (server-derived escalators), `versions` (`"<class>/<id>": n`, the M22 `state_versions` its expected-version CAS runs against), `ancestry` (the support graph M26.3's preventive walk runs over), and `table` (a FROZEN table to replay against — `"v1"` or `"v2"` — for a refusal the shipped table can no longer produce; M27.4 made every shipped capability available, so `capability_unavailable` lives on against v2 rather than losing its shared fixture). Declaring either state field requires `rust_only: true` — both read reducer state that is out of the mock's scope by declaration, so the TS runner skips the *verdict replay* loudly rather than the directory quietly missing the case. It still asserts the artifact half of every such file: that the op declares the code possible, and that the code declares a destiny. |
| `concept-types.v1.json` + `.sha256` | The words the agent may type a concept with (M33a.1), and a one-line hint for each. Loaded by `src-tauri/src/knowledge.rs`; the tool manifest's one token, `{{concept_types}}`, renders it into `write_concept`'s type description. Rust-only for now: the read side (`okf.ts`) resolves a concept's type against the vault's own catalog and tolerates unknown values by OKF §4.1, so there is no twin to disagree with. |
| `tools.v1.json` + `.sha256` | **The tool manifest** (M54.1): one row per hand-written MCP tool in served order — title, kind, idempotence, door, grant axis and target argument, picker summary and toolset, renderer, fold phrases (M56.8), icon, whether an ask-first agent's call waits for the person (`confirmable`, M57.4), search hint, description and input schema — the facts every generated `propose_<op>` tool shares, the picker's toolsets, and the CLI's own built-ins in argv order, each with its tool-approval `family` and the input field its card names it by (`subject`, M57.2). Read by `src-tauri/src/policy/tools.rs`: `mcp.rs` serves `tools/list` from it with annotations, and derives the scope and read targets, the open-page announcements and the read-to-replace guard; `tool-approval.v1.json` plans the CLI's built-ins by its family column. TS reads the same file through `src/lib/policy/tools.ts` (M54.2), refusal for refusal, and derives the picker's toolsets, summaries and writes flags, the transcript's icons, write cards, row renderers and read folds (M56.8), the turn checkpoint's trigger and the run log's paths from it. Both sides hash against `tools.v1.sha256`, and both replay `src-tauri/fixtures/tool-cases.json`, its shared case file. navigate's `to` enum is `src/engine/destinations.ts`'s ids plus view, held there by `destinations.test.ts`; Rust refuses any `to` the served enum doesn't list (M59.1). |

| `tool-approval.v1.json` + `.sha256` | **What Claude Code may run** (M57.2): for each tool family of the manifest, in its order, a grid of run kind (attended, unattended, internal) by ceiling (`none`, or the shell's off, ask and on) to one of six decisions, the read scope's overrides, the permission modes, a card (title, kind and the answers it offers) on every family that asks and a message on every family that refuses (a `deny` cell says it too, where the family has one), and the words the model and the person read. Since M57.3 the question family (AskUserQuestion) asks on an attended run with a `question` card and is denied wherever nobody watches. Since M57.4 it also decides an ask-first agent's page writes: the `confirmable` family, whose members are the manifest's confirmable rows, is read by the agent's `ask_first` (yes or no) where the other families read a ceiling, and the `ask_first` block holds the record key and the values a record may hold. Since M57.4c an unattended ask-first write queues for Review (`queue`, the ask-first family's alone) within `queue_limits`. Interpreted by `src-tauri/src/policy/tool_approval.rs` (argv, the init's mode check and the ask gate's `host_answer`) and `src/lib/policy/toolApproval.ts` (the mock, the panel's prompts), refusal for refusal. Both hash against the `.sha256`. |
| `goldens-tool-approval/*.json` | The table's parity mechanism, replayed by `cargo test` and `pnpm test:run` from the same bytes: one plan golden per run kind × shell ceiling, two read-scoped and two narrowed ones, five ask-first ones (M57.4; the unattended one waits in Review since M57.4c) (each pinning the mode, both lists, the gate's matcher, what is withheld and every tool's decision), and `host-answers.json`, the gate's answer for single calls, beside the two question files (`question-attended-asks.json`, `question-unattended-denied.json`, M57.3). Both suites assert every cell and every host outcome has a golden. |

**Three of these are Rust-only, and that is not an exemption from the house
rule.** `freshness`, `coverage-fold` and `lanes` are read by no TypeScript
because the browser holds no ledger to evaluate them against — so there is no
twin to disagree with. If a surface ever needs one of these rules on the TS
side, it loads the same file; it does not reimplement the rule.

The whole directory is `.prettierignore`d: the bytes are hashed, and a
formatter that reflowed them would break the anchor.

## Twin registry

A rule both languages hold outside a hashed artifact is held by one shared
case file, which cargo and vitest both replay. The registry starts with
M69.1's; the twins that predate it (`source-slugs.json`, `note-targets.json`,
`tool-cases.json` and others under `src-tauri/fixtures/`) are not listed yet.

| Twin | Rust replay | TS replay | Held by | Since |
| --- | --- | --- | --- | --- |
| connector approvals (`src-tauri/fixtures/connector-approvals.json`) | `src-tauri/src/connectors.rs` | `src/engine/connectors.test.ts` | `replays_the_shared_connector_approvals` / `replays the shared connector approvals` | M69.1 |
| edit_note's quote rules (`src-tauri/fixtures/quote-cases.json`) | `src-tauri/src/vault/quote.rs` | `src/engine/quote.test.ts` | `replays_the_shared_quote_cases` / `replays the shared case` | M55.5 |
| the agent comment tools' quote filter and words (`src-tauri/fixtures/comment-tools.json`) | `src-tauri/src/comment_tools.rs` | `src/engine/quote.test.ts`, `src/lib/mockIpc.test.ts` | `replays_the_shared_quote_filter`, `replays_the_shared_comment_tool_cases` / `comment quotes (M70.3)`, `replays comment-tools.json` | M70.3 |

**The D3 ruling (owner, 2026-10-12), recorded once here.** Rust may twin a
TS vault semantic (what a wikilink means, how a quote matches, a filter, a
field kind, a date) as long as the twins are framed as vault semantics and
held together by one shared case file both suites replay, never by review
alone. `src-tauri/src/vault/link.rs` (wikilink targets, against
`src/engine/wikilink.ts`) is the precedent, and M55.8's
`wikilink-targets.json` is its case file; `src-tauri/src/vault/quote.rs` with
`quote-cases.json` (M55.5) follows it. A twin's grammar starts narrow and grows only with new cases. Where
offsets differ (Rust bytes, TS UTF-16 units), the cases pin what both can
say alike: lines and code-point contexts.

## Regenerating

Each is a deliberate act, so each is an `#[ignore]`d test rather than something
the suite does on its own:

```sh
cd src-tauri
# after ANY edit to policy.v3.json
cargo test --lib policy::table::tests::write_policy_digest -- --ignored
# after an edit to authority-routes.v1.json (bump artifact_version and every
# changed route's authority_rule_version first; the prior snapshot stays)
cargo test --lib policy::authority::tests::write_authority_snapshot -- --ignored
# after an edit to freshness.v1.json / coverage-fold.v1.json / lanes.v1.json
cargo test --lib dynamics::freshness::tests::write_freshness_digest -- --ignored
cargo test --lib dynamics::coverage::tests::write_coverage_fold_digest -- --ignored
cargo test --lib attention::lanes::tests::write_lanes_digest -- --ignored
# after an edit to critical-attention.v1.json
cargo test --lib attention::critical::tests::write_critical_digest -- --ignored
# after an edit to trigger-registry.v1.json
cargo test --lib trigger::registry::tests::write_trigger_registry_digest -- --ignored
# after an edit to concept-types.v1.json
cargo test --lib knowledge::tests::write_concept_types_digest -- --ignored
# after an edit to tools.v1.json
cargo test --lib policy::tools::tests::write_tools_digest -- --ignored
# after an edit to tool-approval.v1.json (bump artifact_version, set
# rule_version to tool-approval/<date>, and rewrite the goldens it changes)
cargo test --lib policy::tool_approval::tests::write_tool_approval_digest -- --ignored
```

A new snapshot must also be added to `RESOLVABLE_ARTIFACTS` in
`src-tauri/src/policy/authority.rs`, or `snapshots_on_disk_are_all_compiled_in`
fails — a snapshot no build can read is a rule a proposal can pin and nothing
can evaluate.

## Ordering is canonical, not cosmetic

Every closed list is non-empty, duplicate-free, and in canonical order, because
two artifacts that mean the same thing must not be able to differ.

- In `policy.v3.json`, canonical means **sorted**. `unbound_rejections` is the
  one list allowed to be *empty*, and format 2 emptied it (see below).
- In `authority-routes.v1.json`, canonical means the **enum declaration order**
  the M22 schema fixes: `planned … shipping` reads as reality moving forward,
  `project_owner … unknown` as authority descending. Load reports the expected
  order when it refuses.

`evaluation_order` is the exception — it *is* an order. Precedence between
refusals is policy ("does an unavailable capability outrank an understated
risk?"), so it lives in the artifact rather than in whichever `if` happens to
come first in each language.

`tools.v1.json` holds two more orders of that kind: its `tools` are in served
order and its `cli_tools` in argv order, so neither is sorted.

## Judgment calls recorded here

- **`thresholds.lineage_fan_in_high = 5`.** The design fixes the *mechanism*
  (fan-in above a named threshold floors risk at HIGH) and leaves the number
  open. Five is the line at which a belief is load-bearing enough that editing
  it deserves a person's eyes. It is data precisely so it can be retuned
  without touching either interpreter — but retuning it changes what
  auto-applies, so move it deliberately and re-run the goldens.
- **`silence.allowed_transitions` is an allowlist**, not a forbidden list, so a
  transition added in a later milestone is forbidden under silence *by default*.
  "Quiet for 30 days → probably resolved" is the easiest regression a future
  maintenance pass can introduce; the safe direction is the one where
  forgetting to think about it refuses.
- **Operational vs ledger destiny.** `capability_unavailable` is operational:
  an agent asking for something this build cannot do yet is not epistemic
  history. When in doubt the answer is operational — promoting a code into the
  ledger requires a coverage-materiality argument in review, because the
  alternative is an append-only ledger that fills with "Claude forgot a
  required field 92,000 times."

- **`lineage_fan_in` counts INCOMING live relations.** The design fixes the
  mechanism and leaves the measure to the server. Incoming edges are the ones
  a reader actually follows, so they are what "much depends on this" means;
  outgoing edges are the record's own claims about others and say nothing
  about who would be surprised by a change. Written once, in
  `policy/interpreter.rs`.
- **Precondition precedence is the op's `requires` order.** Which
  state-dependent predicates run, and in what order, comes off the table row
  rather than out of whichever `if` an interpreter writes first — the same
  reasoning that put `evaluation_order` in the artifact. `requires` is sorted,
  so "sorted" is the declared precedence until someone has a reason to make it
  something else.
- **A predicate the table requires and nothing evaluates is a rule that looks
  like protection.** `PREDICATE_OWNERS` in `policy/preconditions.rs` names
  every predicate and the phase that implements it, and a tripwire proves that
  list and the table's `predicates` are the same set. Gaps are written down,
  not inferred from a missing branch.

- **A qualification profile's required roles come off the TYPE DOC, never off
  the proposal.** The proposal carries a `QualificationProfileRef`, but it is a
  claim: the server derives the real profile from the type doc at the current
  head and refuses `policy_precondition_stale` unless the two agree exactly.
  Trusting the submitted `required_roles` would let a proposal name a weaker
  gate than the one that exists, and the ledger event would then record a rule
  nobody applied. Implemented once, in `policy/qualification.rs`.
- **`type_schema_hash` covers the role assignment, not the whole type doc.**
  The pin exists so a type-doc edit cannot retroactively re-decide a promotion,
  which means it must cover which field carries which role — and nothing else.
  Hashing the whole doc would make recolouring a status option invalidate every
  promotion in flight, and a gate that cries stale for cosmetic edits is one
  people learn to route around.
- **An unknown `role:` annotation refuses rather than being ignored.**
  `role: onwer` silently reading as "no role here" is the worst outcome
  available: the type doc still *looks* like it protects something. The gate
  fails closed for that type and names the annotation.
- **Parked promotions are operational.** Every column is recomputable from the
  vault's records plus the type docs, so by the standing when-in-doubt rule the
  worklist lives in `runtime.db`, not the ledger. The refusal itself is
  ledger-destined — "this item is not ready" is epistemic history; "here is the
  worklist" is a cache.
- **A refusal names the predicate that refused.** `Rejection.rule` takes the
  failing predicate's own name (a `RuleCode` may be a predicate) instead of the
  code→rule fallback, so a card says `qualification_roles_present` rather than
  `commit_set`. The fallback remains for table-decidable refusals, which have
  no predicate to name.

- **A candidate receipt's id digests the SEARCH, never the dispositions.**
  What the server found is the server's and is sealed; what it means
  (`update | qualify | distinct`) is the proposer's and must stay free to
  change. An id covering the judgement could not survive a proposer
  disagreeing with a default, and one covering less than the legs would let a
  fabricated search wear a real one's id. It is also what makes
  `candidate_unconsidered` distinguishable from
  `candidate_receipt_caller_authored`: stripping the judgement leaves the
  search intact.
- **`candidate_receipt_missing` and `candidate_unconsidered` are POLICY
  refusals, not schema errors.** Both were checked in
  `ledger/schema/proposal.rs` until M24.7 and therefore surfaced as
  `schema_invalid` — operational — which put "the agent created without
  searching" in the log with the typos instead of in the epistemic record.
  The schema layer checks a receipt's SHAPE; the policy layer checks it
  against the world. A create with no receipt now becomes a durable proposal
  and is refused in the ledger, because a ledger refusal needs a proposal to
  point at.
- **The scoped/temporal leg is "every live Belief about this subject."**
  Tombstoned ones are excluded — they are not something a create could have
  been an update to — but superseded and archived ones are not: "there is
  already a retired belief about this" is exactly the context a reviewer
  wants. `scope` and `valid_interval` stay empty because a create's payload
  carries no scope to search within; writing a guess would make the receipt
  claim a narrower search than it ran.
- **The receipt rules have no goldens.** They are decided against reducer
  state and a vault index, which the mock has no counterpart for — the same
  boundary the CAS fixtures declared with `rust_only`. Unlike CAS there is no
  TS-side receipt validation at all to drift from, so the honest artifact is
  the Rust test set, not a fixture the mock would skip.

- **The high-stakes rule's queue is a VERDICT, its refusals are
  preconditions.** `high_stakes_route_satisfied` is the one rule with three
  outcomes, and the table fixes which shape gets which: absent or
  insufficient coverage/authority queues with `queue_rejection`, a malformed
  reference rejects with `malformed_rejection`, a resolved-then-moved one
  rejects with `stale_rejection`. The refusals run in `preconditions::check`
  like every other predicate; the queue is applied where verdicts are
  decided, so "structurally valid but unverified" cannot become a rejection
  at one call site and a queue at another.
- **`proposal.queued` carries `queued_for`.** A card that cannot say why it
  is waiting is a card nobody can act on, and the answer is not recomputable
  — the world moves, and "why was this queued" is a question about the world
  as it was. Effective risk alone does not carry it either: a HIGH card from
  lineage fan-in and a MEDIUM card held by the stopping rule ask a human for
  different things.
- **Unverifiable is not verified.** Route criteria are matched over what the
  reducer exposes today (observation kind, authority capability, assertion
  basis, source registration kind). A criterion that also demands a
  relationship ROLE, a cached artifact hash, or a raw pointer cannot be
  settled until M25 registers those, so it does not match and the proposal
  queues. The opposite default would make the rule decorative in exactly the
  cases it exists for.
- **`coverage_assessments` ships empty on purpose.** M24.8's rules are
  written and tested against the real M25 record shape rather than a
  `todo!()`, which is what makes "no coverage" a resolvable question. For the
  whole of M24 the map is empty, so every high-stakes proposal queues — the
  behaviour the spec asks for, arrived at by the rule rather than by a
  special case.

- **The REDUCER does not load `independence-rules.v1.json`.** It validates
  that a proof carries a non-empty `rule_version` and nothing more. Making
  reducer validation depend on the artifact's CONTENTS would make every
  conformance vector's expected refusals artifact-version-dependent, so a
  rule-version bump would rewrite the parity contract for reasons that have
  nothing to do with parity. The artifact governs PRODUCTION; the vectors
  govern agreement. This is the one place a shared artifact is deliberately
  read by one side only, and it is why.
- **A missing independence domain is unknown, not "probably different".**
  Both distinctness predicates require the field present on BOTH endpoints
  and different. Two exports of one upstream system are two files and one
  observation; letting an absent domain pass would let a copy vouch for its
  original, which is the failure independence exists to prevent.
- **`human_confirmed` stays refused, for a new reason.** M22 wrote "reserved
  until M24 ships"; M24 shipped. What makes the proof true is that a specific
  HIGH proposal was APPROVED by a person, and that is reducer state rather
  than body shape — so the body-level validator refuses it and says why,
  rather than accepting two ids as evidence that somebody agreed.

- **The absence rule's required dimensions stayed at five.** M25.4 gave
  assessments all seven dimensions, and the table still requires
  `index_current, retention_known, retrieval_attempted, scope_accessible,
  scope_known` for a formal absence claim. Connection and health are about
  whether the source could be reached AT ALL, which the other five already
  fail without; adding them would refuse absence claims that are genuinely
  complete. What DID change is the meaning of "established": a dimension
  counts only when it says `yes`, because `unknown` is an answer and it is
  not "we checked and it holds".

## Format 2 — the preventive anti-self-ancestry binding (M26.3)

- **`no_self_ancestry` binds to exactly the two ops that carry a
  `BeliefBasis`** — `create_belief` and `update_belief`. Those are the only
  payloads that can introduce a support Observation, so they are the only ones
  the walk can ever refuse. Binding it to `split_belief` or
  `merge_beliefs_exact` would read as broader protection and provide none:
  those redistribute evidence a Belief already rests on. `ancestry.rs`'s
  `basis_target` is an exhaustive match with no wildcard arm, so an op variant
  added later that *does* carry a basis cannot reach the table without the
  compiler asking about this list first.
- **Which ops run the gate is DATA, in a `preventive_ancestry` block.** The
  walk is code — it reads reducer state — but "an op that changes what a
  Belief rests on must run it" is a policy statement, and one hand-listed
  inside the registration gate would be the second inventory the parity rules
  forbid. The block is shaped like `contradiction_addressing`, and load proves
  the three facts agree in both directions: every listed op `requires` the
  predicate and declares the rejection, and no unlisted op requires it. So "is
  the gate bound?" is one question with one answer.
- **Format 2 without the block fails the load.** A version bump whose whole
  content is optional would let a v2 table look modern and gate nothing.
- **`unbound_rejections` may now be empty, and is.** It names the codes
  registered in the destiny registry that no op can yet produce; format 2
  bound the last one. Refusing an empty list would mean keeping a fake
  reservation alive to satisfy a validator.
- **Both loaders read formats 1 *and* 2.** v1 is not kept for nostalgia: it is
  the negative control proving M26.3's registration gate refuses for the right
  reason. Pointed at v1, `ancestry::table_binding` must fail on the *absent
  binding*, not on an unknown code — the wrong-reason failure would evaporate
  the day somebody registered the code without wiring the walk. A hand-written
  stub could not prove that, because a stub is written by whoever wants the
  test to pass.
- **The self-ancestry goldens are `rust_only`, and that is not a gap.** The
  walk reads reducer state the mock has no counterpart for, so only Rust
  replays the verdict. What the TS runner still asserts over those files is
  the half parity is actually about: that the shared table declares
  `self_ancestry` possible for the ops that produce it, and routes it to the
  ledger. The fixtures pin the BINDING; the walk's own five vectors (direct,
  transitive, old-revision, cycle, unrelated control) live in `ancestry.rs`,
  where the graph can be built in code.

## Mint-time refusals (M26.2)

- **`mint_rejections` is a fourth registry beside transport and writer**, and
  it exists because `semantic_search_unavailable` fails at a fourth place. A
  transport code fails on the wire; a writer code fails at the ledger; an op's
  `possible_rejections` fail during policy evaluation. This one fails while
  the server is MINTING a candidate-search receipt — before any proposal
  exists — so no op may list it, and load enforces that alongside the other
  three.
- **Its destiny is operational, and that is not the timid default.** No
  proposal was ever built, so there is nothing for a ledger entry to point at.
  This is the same reasoning M24.7 applied in the other direction when it
  moved `candidate_receipt_missing` INTO the ledger: a create that reached the
  proposal stage without a receipt is epistemic history, and a create that
  never got that far is a capability gap.
- **The receipt this build mints is `search_version: 3`, and the design says
  2.** The design assumed M24 shipped v1; M24.7 had already bumped to 2 when
  it made the three deterministic legs real. Reusing 2 would leave an M24.7
  receipt (`semantic: not_available`) and an M26.2 receipt
  (`semantic: completed`) claiming the same version, and telling those apart
  is the version's only job.

## Grant refusals (M54.10)

- **The four grant codes are transport codes, not a fifth registry.**
  `write_outside_scope`, `tool_outside_grant`, `read_outside_scope` and
  `target_outside_corpus` fail at the server's door, against the run's bearer,
  before any tool body runs or any proposal exists: where `run_actor_mismatch`
  and `malformed_arguments` already fail. So no op may list them, and load
  already enforces that.
- **Their destiny is operational.** A refused call bounds one run; it claims
  nothing about the world. Each row carries its run's id, and a run gets one
  row per code, tool and target, so a model that repeats a refused call writes
  one row. `Rejection::new` refuses a transport code, so no proposal can carry
  one into the ledger.
- **`target_outside_corpus` is the note doors' own judgement, asked early.**
  `vault::write` still refuses in the mechanism, in the same words. A path
  into `knowledge/` meets the bundle guard first, as it always has, and that
  guard records `malformed_arguments`.
- **The CLI's own permission denials stay `capability_unavailable`**
  (`agent.permission`, M54.9): the CLI refused, for reasons Cerebro does not
  own.

## Stale content (M55.3)

- **`stale_content` is a transport code.** An agent's note write that names
  `expect_hash` (get_note's Hash line) and finds other bytes fails at the
  write door, under the note's lock, before a byte is written. It bounds one
  call and claims nothing about the world, so it is operational, no op lists
  it, and `Rejection::new` keeps it out of the ledger, like M54.10's codes.
- **It is neither of the other two stale codes.** `stale_target_version` is
  the ledger's `expected_version` check on a proposal, and `stale_view` is a
  person's verify against a projection that moved. Neither is borrowed for a
  note's bytes, nor this one for theirs.
- **It is not retryable in-session.** The same call fails the same way: the
  agent must read the note again and decide whether its change still
  applies, so the refusal carries no current hash.
- **A hashed write is also a read.** The hash proves the run read the note,
  so `call_tool` holds the target to the read scope too, under
  `read_outside_scope`, and a write-only run cannot use the hash to probe a
  note it may not read. Human saves never compare: the last write wins.

## No longer waiting (M57.1)

- **`no_longer_waiting` is a transport code.** It answers a person's late
  click after its request ended (answered, cancelled, or its vault closed).
  It fails at the door of `answer_interaction`, bounds no run and is
  recorded nowhere: the card already says so, in its own words. Operational,
  in no op row, not retryable, and `src-tauri/src/agent/interaction.rs` holds
  it as a const.

## The live agent surface (M26.3c)

- **`agent_facing` defaults to TRUE, and the artifact says only where it is
  false.** A new op is offered to agents unless somebody argues otherwise,
  which is the right default for a table whose whole job is governing agent
  mutations — an op quietly excluded by omission would be a capability nobody
  could find the reasoning for. `revert_proposal` is the one false: it is
  MEDIUM, MEDIUM auto-applies, and an agent-facing revert would undo an
  applied mutation including one a human just approved, with no second card.
- **The live tool names are generated from this file.** `mcp.rs` builds one
  `propose_<op>` per agent-facing op; nothing types the list a second time.
  The `propose_` prefix keeps the namespace injective against the tool
  manifest's hand-written rows — `cache_source` is both a tool and an op — and
  `the_live_proposal_inventory_is_the_policy_inventory` proves the served
  surface and this artifact agree in both directions.
- **Registration is gated on the safety machinery being BOUND here.** The
  server refuses to build any proposal tool unless `preventive_ancestry` binds
  the walk and `create_belief` still requires `candidate_receipt_current` and
  declares its four receipt codes. Editing either of those out of this file
  does not quietly widen the surface; it closes it.

## The tool manifest (M54.1)

- **Order is meaning, so nothing in it is sorted.** `tools` is the order
  `tools/list` serves, and `cli_tools` the order the argv names them, which
  is the order every tool-approval list keeps; the Off run's deny list,
  `Write,Edit,MultiEdit,NotebookEdit,Bash`, kept its bytes.
- **The generated tools stay policy.v3's.** Their names, descriptions and
  schemas are built from the table's agent-facing ops; the `generated` block
  only annotates them, so an op added to the table is still offered the moment
  it lands.
- **`propose_organize` is the one prefix exception.** It predates the
  generated namespace (M9.5), and `proposal_op_of` asks the table rather than
  trusting the prefix, so it never reaches the mutation boundary. Any other
  hand-written `propose_` name fails the load.
- **`read_only` lives only on door `none`.** `readOnlyHint` lets the CLI run
  calls in parallel, so the hint is kept for tools that write nothing at all;
  a door that writes may not allow it, and a tool that only moves the UI or
  starts a run is `additive`, not read-only.
- **Note writers are always write-scoped.** Door `note` allows only the write
  and read_write axes, and both need a target argument that the schema
  requires (a note or folder on the write axis, a note on read_write), so a
  tool that edits notes cannot load unscoped. Every other tool is a read the
  read scope binds, or says in `exempt` why no folder axis binds it.
- **`edit_note` is read-gated as well as write-scoped (M55.5).** Its refusals
  quote the note back (a listing of each place a quote appears), and even its
  success says what matched, so a run that may write a note but not read it
  could use it as a read oracle. Its row's axis is `read_write`: the grant
  holds the note to the write scope and the read scope before the tool runs,
  with or without `expect_hash`. No new refusal code: the grant's are
  M54.10's, a stale hash is M55.3's `stale_content`, and a quote that does not
  resolve is plain `isError` text like `no note at <path>`.
- **Door `comment` writes no page, and its rows are reads (M70.3).**
  comment_on_note, reply_to_comment and resolve_comment write only the page's
  comment sidecar (`vault/comments.rs`), so the door's `writes` is false: its
  rows never rescan, checkpoint or log a written path, and they announce the
  page's comments instead. They sit on the read axis with a note target,
  because a refusal lists where a quote appears and get_note's thread block
  quotes the page, so a comment never needs write scope. Both loaders accept
  the door only with axis read, a note target, kind additive and renderer
  step, in one refusal's words, and its rows are never `confirmable`.
- **Picker copy lives here.** Toolset labels and hints and each row's summary
  are the picker's words, and `src/engine/tools.ts` reads them from here
  (M54.2). A copy edit is an artifact edit with a digest regeneration.
- **Fold phrases are owner-read copy (M56.8).** A read row's `fold {one,
  many}` is how a run of its consecutive calls reads in a transcript ("Read
  5 notes"), so a phrase edit is an artifact edit with a digest regeneration.
  Only reads fold, cerebro's `read_only` rows and the CLI's readers, so a
  write keeps its path in view; a failed or interrupted read is never folded
  out of sight. Phrases are lowercase (the row capitalizes the label it
  joins), at most 40 characters, `one` without `{n}` and `many` with exactly
  one.
- **The renderer vocabulary is data (M56.8).** `step` and `change` serve any
  row; `concept`, `handoff` and `commit` draw one door's work and sit only on
  it: `concept` on door `concept` (write_concept, recheck_concept), `handoff`
  on door `run` (hand_to), `commit` on door `ledger` and the proposals
  surface (commit_proposals). The generated `propose_*` tools stay `step`, a
  CLI row takes only `step` or `change`, and a `concept` row, like a
  `change` row, needs a target. A new renderer is an artifact edit and a
  loader change on both sides.
- **Two loaders, one refusal list.** `tools.rs` and `src/lib/policy/tools.ts`
  refuse the same manifests in the same words, and each holds one negative
  control per refusal. TS checks by hand the shape serde checks in Rust: an
  unknown field fails, and an absent `Option` field reads as null.
- **The `_meta` keys are CLI behaviour, read from 2.1.250.**
  `anthropic/searchHint` is served on every tool and `anthropic/alwaysLoad`
  only where a row sets it; a key the CLI does not know is ignored, never
  fatal.
- **Six tools load early, and no others (M54.5).** The CLI defers every MCP
  tool behind its tool search, so a run spent a turn finding
  `get_vault_context` before it could call it. An early tool's schema rides
  every turn of every run that lists it, so `always_load` is set only where
  it earns that: on the read core
  (`get_vault_context`, `search_notes`, `get_note`, `knowledge_about`), which
  nearly every run reaches for first, and on the two held tools
  (`report_window_outcome`, `submit_answer`), which `tools/list` shows only to
  the run holding their window or question (M54.4), so no other run pays for
  them and a synthesis run skips the search. Every other tool stays deferred:
  a write or a UI move comes later in a turn, if at all. Only a read-only row
  or a held tool may load early, and
  `agent::tests::only_the_read_core_and_held_tools_load_without_a_search` pins
  the six.
- **A CLI row names its family, never its decision (M57.2).** `family`
  is required and `subject` is null or an input field; what a family may do
  in a run is `tool-approval.v1.json`'s alone. The three shell columns M54.1
  kept here (denied without shell, denied when read-scoped, with shell) went
  to that table's grid and read scope.
- **`concept_types` is the one token.** A `{{name}}` in a description or
  schema must be declared in `tokens`, and a declared token must be used;
  `mcp.rs` renders each one when it serves the row.
- **The note writers are the confirmable rows (M57.4).** `confirmable` is
  true on create_note, update_frontmatter, append_to_note and edit_note: the
  note door changes the person's own pages. The concept writers are not,
  because a person already verifies a concept; nor is cache_source, a cache;
  the generated tools are decided by policy.v3; hand_to and the UI tools write
  no page. Both loaders refuse it missing, on a door that writes nothing, off
  the write and read_write axes, and on the generated block.
- **`ask_gate` is a hook endpoint, not a manifest row (M57.1).** A run's
  PreToolUse hook (`type: mcp_tool`) calls it on the run's own bearer to ask
  whether a call may run, wait or not. `mcp.rs` answers it before every grant
  axis, as hook JSON; `tools/list` never lists it, and nothing counts,
  announces or records it. It can register a wait and read a person's
  answer, never record one, so it has no row here and needs none.
- **`ask_host` is a hook endpoint too (M57.3).** A seated run names it as
  Claude Code's `--permission-prompt-tool`, which 2.1.250 needs before it
  offers AskUserQuestion in `-p`. `mcp.rs` answers it beside `ask_gate`,
  before every grant axis, and nothing lists, counts, announces or records
  it. It allows only a call the run's seat holds a person's answer for, with
  the input that answer made, and denies every other call, so it has no row
  here either.

## The tool-approval table (M57.2)

- **Six decisions, one carrier each.** `allow` rides `--allowedTools`;
  `deny` rides `--disallowedTools`; `ask` rides neither list and meets the
  ask gate, which asks the person on an attended run; `refuse` rides neither
  list on a run that can ask, where the gate denies it with the family's
  message, and `--disallowedTools` on every other run, so it is never left
  to the CLI; `cli` rides neither list, so the CLI's own rule decides (reads
  inside the vault need no approval, and the rest is refused in `-p`);
  `queue` (M57.4c) rides neither list, and dispatch holds the write for the
  person in Review.
- **A run that cannot ask never asks.** Only `attended` can ask, and only a
  run with a seat on a Claude Code the gate is built for is planned as one.
  Elsewhere an ask becomes a deny, its tools are `withheld`, and the meter
  records them as one `capability_unavailable` row under `agent.ask`; a
  refusal becomes a deny.
- **The order of a plan is fixed:** the grid's cell; then `read_scope`, which
  only ever denies; then a tool the record narrows out becomes deny when it
  would ask or sits in a `needs_default_mode` family (acceptEdits would
  approve it), and an allow it narrows out elsewhere is left to the CLI;
  then what a run that cannot ask does instead.
- **The mode follows the asks.** Internal runs start in `default`; a run with
  an ask surviving on a `needs_default_mode` family (file_write, shell)
  starts in `default`, because acceptEdits would approve those tools with no
  host; every other run keeps `acceptEdits`. `default` is a hidden alias in
  2.1.250, so a run that needs it is stopped at its init when the init
  reports another mode or a version below `min_cli_version`.
- **Families come from the manifest.** The table declares exactly the
  manifest's families, in its order of first appearance, then the ask-first
  family once a row is confirmable; a family holding a
  writer must sit on the shell ceiling and deny in every off cell; an
  internal cell only denies or refuses; `unlisted` (a tool neither file
  names, another server's included) is `cli` or `refuse`.
- **Card titles and messages are owner-read copy.** A copy edit is an
  artifact edit with a digest regeneration, in both interpreters at once.
- **This conversation covers the exact subject.** The host allows an ask only
  on a person's grant for the same family and the exact subject (the
  manifest's `subject` field as text, else the input's compact JSON, cut at
  2000 characters), kept in memory per vault and Claude Code session, and
  only where the family's card offers it: whether a card offers This
  conversation is the card's `answers`, policy rather than card code.
- **Cerebro's own page writers meet the table too (M57.4).** A tool the
  manifest marks `confirmable` resolves to the family the `ask_first` block
  names; the table names the family, the manifest names its members, so no
  tool list is typed here. That family is read by `ask_first` instead of a
  ceiling: an attended run whose agent asks first asks (a `write` card,
  Allow once only), an unattended one queues for Review (M57.4c), an
  internal run is always denied, and an agent that does not ask first is
  allowed. Only its asks
  reach argv (they leave `--allowedTools` for the gate); the rest is
  dispatch's to enforce, so a denied page write stays callable and is
  refused, and recorded, in Cerebro's words. An ask adds no
  `needs_default_mode`: acceptEdits never approves an MCP tool.
- **Unattended ask-first writes wait in Review (M57.4c).** Nobody can answer
  a run nobody watches, so its page writes `queue`: dispatch previews the
  write (every check it would make, on the bytes on disk now), then holds it
  in `runtime.db`'s `pending_writes` for the person to Allow or Reject, and
  the run's next unattended turn hears what became of it. **Queue is not a
  refusal**: nothing was refused, a person decides, so it carries no policy
  code and records no row. Only the ask-first family may queue, and both
  loaders refuse a `queue` cell anywhere else in the same words; a write the
  record narrows out is denied, never queued. **`queue_limits`** bound what
  waits, since nothing expires: `open_per_actor` (20) open writes per agent,
  so one agent cannot flood Review, and `input_bytes` (256 KiB) of key-sorted
  draft, the same bound the table's CHECK holds. Past either, the write is
  refused with one `capability_unavailable` row under `agent.ask_first`.
- **A question asks only where someone watches (M57.3).** The question
  family (AskUserQuestion) asks on an attended run with a `question` card,
  which offers Allow once only: a question is answered, never remembered. It
  leaves the mode alone, since acceptEdits never answers a question. Every
  other run denies it in argv, and its `deny` cell carries the family's
  message, which says nobody is watching. The question card's rules (1 to 4
  questions, 2 to 4 options each, the answers' membership and counts, and
  Claude Code's join) are not here: they live in
  `src-tauri/fixtures/question-answers.json`, replayed by
  `agent/question.rs` and `src/engine/questionForm.ts`. Previews show as
  text, never as HTML.
- **`ask-first:` fails closed.** The `ask_first` cases say how an Agent
  record's value reads: absent or `false` is off, `true` is on, and anything
  else, a `[[link]]` relation included (CV-09), is on with a warning on the
  agent page. Rust's `ask_first_of` and `src/engine/agents.ts` replay them.

## What is deliberately NOT here yet

`conflict_classification` and `contradiction_edges` are declared unavailable
until M27 ships their bodies, reducers, and vectors — the ops are
typed-unavailable rather than emitting an unnamed mutation.

The proposal tools are still absent from the live and mock MCP servers. The
gate above landed first ON PURPOSE: a predicate the table requires and nothing
evaluates is a rule that looks like protection, so the walk (M26.3a) shipped
with nothing depending on it, the binding (M26.3b) second, and registration —
which must also carry M26.2's semantic-receipt-v2 validator — last.

## The trigger registry (M28.0)

- **The protocols' floors are data, not code.** The design fixes each
  measurable protocol's mechanism in prose; the numbers (window lengths,
  sample floors, ppm thresholds) live in the artifact so retuning one is a
  reviewed artifact edit with a digest regeneration, never a quiet constant
  change in an evaluator. `rule_version` is baked into every evaluation id,
  so an evaluation run under different rules is a different evaluation.
- **`snapshot_hash_domain` is `cerebro-trigger-snapshot-v1`.** The design
  fixes the evaluation-id domain (`cerebro-trigger-evaluation-v1`) and says
  the input-snapshot hash is domain-separated without naming the tag; this is
  the name, chosen in the artifact rather than in either interpreter.
- **`metrics.component_units` restates `runtime::governance::Component`,**
  and the Rust loader REFUSES an artifact that disagrees with the enum — the
  `attention::lanes` posture. The restatement exists so TypeScript can
  validate a projected-component metric without reimplementing M26; it is
  tolerable exactly as long as the refusal holds.
- **Protocol coverage is two-sided.** Every unaliased measurable/hybrid gate
  must have a protocol entry and nothing else may: a protocol for a
  discretionary gate would read as a measurement nobody performs, and R5's
  Discovery alias deliberately owns none — its entire content is
  byte-equality with a fired R13 parent.
- **`R14:connector:*` is the one wildcard parent**, and with zero registered
  connectors it is a parent nothing can satisfy — the fail-closed reading the
  `per_connector_scope_model` tail wants.
- **R15–R17 are registered in the spec, not in this artifact (M31.8,
  2026-08-14).** M31 registered three deferrals — unprompted recall, the
  prior-manifest retrieval hint, the folder-level ingest opt-out — whose full
  rows the registry spec now carries. `trigger-registry.v1.json` deliberately
  still holds exactly R1–R14: an unnamed gate key resolves to nothing, which
  IS the refusal, so none of the three can be evaluated — let alone fire — by
  any shipped build. Their keys, R15's floors, and the one new metric name
  (`answer_latency`, unit `micros`) enter a successor artifact revision in
  the same commit as the first implemented R15–R17 evaluator, never
  speculatively — the same reasoning as R14's deliberately empty
  `registered_connectors`: a registration added to satisfy a validator would
  be worse than the gap.
