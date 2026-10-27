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
preemptively.) A vault semantic both languages must hold is twinned only
under the D3 ruling, behind shared cases, and listed in "Twins (D3): one rule,
two readers, shared cases" below.

## The files

| File                                     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft-export.v1.json`                   | Explicit session draft exports: a 10 MiB payload, 60 second one-use choice lease, bounded pending choices, supported source types and version-1 bundle discriminants. Rust enforces the native capability; the browser mock consumes the same data. No journal or importer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `recovery.v1.json` + `.sha256`           | Opt-in local recovery bounds: retention, global retained bytes, entry size, row/path metadata and one-use failure-choice expiry. Rust enforces these bounds; TS presents and mocks the same artifact. Both loaders replay the digest.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `policy.v3.json`                         | **The table** (`format: 3`, M27.4): target classes, predicates, transitions, rejection destinies, escalators, capability gates, silence/absence/high-stakes/preventive-ancestry/contradiction-addressing rules, the risk ladder, and one row per op.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `policy.v3.sha256`                       | SHA-256 of `policy.v3.json`'s bytes. Rust and TS each hash what they loaded and compare against this file — the only way two processes in two languages assert the _same_ bytes rather than each asserting self-consistency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `policy.v2.json` + `.sha256`             | **Frozen** (`format: 2`, M26). The negative control for M27.4's contradiction-preservation gate: a table that parses cleanly, binds `open_contradictions_addressed` to the same five ops, and simply predates `contradiction_edges` being available. Registration against it refuses BY NAME.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `policy.v1.json` + `.sha256`             | **Frozen** (`format: 1`, M24–M25). Not history for its own sake: it is the negative control for M26.3's live-registration gate — a table that parses cleanly and simply predates `no_self_ancestry`. All loaders still read it, and nothing edits it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `authority-routes.v1.json`               | The current predicate- and stage-specific authority routes (D11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `authority-routes/<hash>.json`           | Immutable content-addressed snapshots. A queued proposal pins `(route_id, rule_version, artifact_hash)`, so an approval tomorrow is evaluated against the rule the agent was actually shown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `independence-rules.v1.json` + `.sha256` | The two deterministic positive-independence predicates (M25.5), loaded by `src-tauri/src/ingest/independence.rs`. `rule_version` is bumped by ANY predicate change and pinned into every event the producer emits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `freshness.v1.json` + `.sha256`          | When a claim goes stale, by predicate class (M27.1) — `time_basis`, `staleness`, and whether an attestation may anchor. Loaded by `src-tauri/src/dynamics/freshness.rs`. `rule_version` is stamped into every `freshness.transitioned` event.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `coverage-fold.v1.json` + `.sha256`      | The Coverage dimension precedence and summary fold (M27.2). Loaded by `src-tauri/src/dynamics/coverage.rs`; `fold_rule_version` is carried on every folded answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `staleness.v1.json`                      | When a concept is stale (M49.8): inclusive of its `stale_after` date, and a value that is not exactly a YYYY-MM-DD date (a non-string included) reads as stale — an unknown horizon is surfaced, never treated as "never". Read by `knowledge::is_stale` (Rust) and `staleFrom` (src/engine/okf.ts); both replay its `cases`, so the two evaluators cannot drift, and Rust also checks that `validate_stale_after` refuses every malformed case.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `links.v1.json`                          | Where the webview may go (M53.12): its entry document (`tauri://localhost` at one of `entry.paths`, or the devUrl under `tauri dev`, with no credentials and no query) loads, an `external_schemes` address leaves for the system browser, and everything else is refused. A path or query on the app's own origin is refused too, because tauri's asset fallback serves `index.html` for any path it cannot find (tauri-2.12.4 manager/mod.rs:402-415), so following one reloads the app and drops unsaved state. Read by `shell::links` (Rust), which routes every navigation and every new-window request through it, and by `isWebUrl` (src/mermaid/flowchart/linkTargets.ts) for the scheme list; both replay its `cases`, and Rust also checks the artifact is closed and canonical.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `agent-links.v1.json`                    | Open with's agent links (M55.9): four targets in menu order, each an id, a label, a base and a query param, and `max_url_bytes` (8192, the whole URL). A link is the base, `?`, the param, `=` and the prompt percent-encoded with `encodeURIComponent`'s set; a longer one is never opened and the prompt is copied instead. Rust (`shell::open`) builds every URL, checks the cap and replays the `cases`; TypeScript (`OpenWithMenu`) reads only the ids and labels and never builds a URL or checks a length, so no rule is twinned. No digest, like `links.v1.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `supervised-jobs.v1.json`                | M95 internal read-only job validation: references the existing subagent depth/concurrency/session ceilings and adds the approved ten-minute and 256 KiB limits, awake-only mode and bounded request/evidence parsing. The Rust-only freeze remains test/native-harness gated; this artifact grants no execution, queued job or durable result retention.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `run-configuration.v1.json`              | M97 immutable secret-free configuration metadata bounds: 64 KiB per manifest, 64 MiB per vault, 90-day completed retention, pinned active rows and bounded cleanup ticks. Rust `runtime/run_configuration.rs` alone enforces them; React reads the generated descriptive result and does not duplicate retention policy. Prompt bodies, secrets and environment/header values are never retained; cleanup never removes run history or effect receipts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `run-options.v1.json`                    | What a run may ask Claude Code for (M56.5): the five `effort_levels` 2.1.250's `--effort` takes, with labels; the model-name shape (`max_chars`, an ASCII letter or digit `first`, then the `also` characters); the `model_suggestions` the pickers offer; the refusal `messages` and `value_chars`, the cut a refused value is quoted at. Absent or blank is unset, which passes no flag. Read by `agent::run_options` (Rust, strict parse), which refuses a run before it starts in `run_agent`, `hand_to` and `spawn_run`, and by `src/engine/runOptions.ts`, which draws the agent page's rows and the composer's picker and gives the browser mock Rust's refusals word for word; both replay its `cases`. No digest, like `links.v1.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lanes.v1.json` + `.sha256`              | The four attention lanes (M27.6): lane order, the reason codes each lane may emit and their within-lane order, the reliance vocabulary, whether the debt lane requires reliance, and (M27.7) which lanes are PROTECTED under §33. Loaded by `src-tauri/src/attention/lanes.rs`, which refuses to start if the artifact and the code disagree about EITHER set — a lane or reason declared with no code behind it renders as permanently empty, which reads as "nothing here" — and refuses an artifact that protects nothing, because a firewall with no protected class is a comment. M27.9 added the three §78/§80 hygiene reasons to the debt lane — `dynamics::hygiene` had computed them since M27.2 with no caller, which is the same as not computing them. M49.10 (K31) stopped emitting `coverage_unassessed` as a lane item: no coverage assessor has shipped, so it pinned every belief in the protected blindness lane. It stays declared for the day an assessor leaves only some beliefs unassessed; until then the lanes COUNT unassessed beliefs (`Lanes::unassessed`) and the view says so — in the empty blindness lane's line, or in `incomplete` when the lane holds assessed items — so an empty lane never reads as "no coverage gaps".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `critical-attention.v1.json` + `.sha256` | §8's bypass (M27.7): the deliberately small, complete inventory of deterministic signals that must not wait in a lane. Each trigger declares its required typed fields, the comparison operators and durations, and the copy key; the artifact declares the replacement relation and its DIRECTION. Interpreted by `src-tauri/src/attention/critical.rs` and `src/lib/attention/critical.ts` — two interpreters, one artifact, and no rule written in either language. **Adding a trigger is an artifact change plus a vector change, never hidden code.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `goldens-critical/*.json`                | The bypass's parity mechanism, replayed by `cargo test` and `pnpm test:run` from the same bytes. Every shipped trigger has five: positive, boundary, replaced, wrong-environment, malformed — and BOTH suites assert that all five exist for every trigger, so a new trigger without vectors fails the build rather than shipping unchecked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `trigger-registry.v1.json` + `.sha256`   | The M28 deferral registry's evaluable half: the fourteen R1–R14 entries, each gate key's required evaluation variant, scope, and parent rule, the metric name/unit tables, and the measurable protocols' floors. (R15–R17, registered 2026-08-14 by M31.8, deliberately postdate v1 — see the trigger-registry judgment calls below.) Interpreted by `src-tauri/src/trigger/registry.rs` and `src/lib/trigger/registry.ts` — two interpreters, one artifact. A combination the artifact does not name resolves to nothing, which IS the refusal. R14's `registered_connectors` is the one deliberately empty list: no connector qualifies yet, and a fake registration to satisfy a validator would be worse.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `goldens-trigger/*.json`                 | The trigger registry's parity mechanism (M28.0), replayed by `cargo test` and `pnpm test:run` from the same bytes. Each golden is a full `TriggerEvaluation` record (sometimes with its parent) and the outcome both validators must land on: `accepted`, or a refusal named by its CLOSED code — codes are the contract, prose is not. Both suites also assert every refusal code has at least one golden, so a code with no fixture fails the build. Accepted goldens carry ids that genuinely recompute (`sha256(domain\0gate\0scope\0rule_version\0snapshot_hash)`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `goldens/*.json`                         | Proposal + preconditions → expected verdict + destiny. Replayed by `cargo test` and `pnpm test:run` from these same files. A fixture may declare `signals` (server-derived escalators), `versions` (`"<class>/<id>": n`, the M22 `state_versions` its expected-version CAS runs against), `ancestry` (the support graph M26.3's preventive walk runs over), and `table` (a FROZEN table to replay against — `"v1"` or `"v2"` — for a refusal the shipped table can no longer produce; M27.4 made every shipped capability available, so `capability_unavailable` lives on against v2 rather than losing its shared fixture). Declaring either state field requires `rust_only: true` — both read reducer state that is out of the mock's scope by declaration, so the TS runner skips the _verdict replay_ loudly rather than the directory quietly missing the case. It still asserts the artifact half of every such file: that the op declares the code possible, and that the code declares a destiny.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `concept-types.v1.json` + `.sha256`      | The words the agent may type a concept with (M33a.1), and a one-line hint for each. Loaded by `src-tauri/src/knowledge.rs`; the tool manifest's one token, `{{concept_types}}`, renders it into `write_concept`'s type description. Rust-only for now: the read side (`okf.ts`) resolves a concept's type against the vault's own catalog and tolerates unknown values by OKF §4.1, so there is no twin to disagree with.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tools.v1.json` + `.sha256`              | **The tool manifest** (M54.1): one row per hand-written MCP tool in served order — title, kind, idempotence, door, grant axis and target argument (`file` is a contained-file read and `canvas` a whiteboard read on axis read/door none or an edit on read_write/door canvas), picker summary and toolset, renderer, fold phrases (M56.8), icon, whether an ask-first agent's call waits for the person (`confirmable`, M57.4), search hint, description and input schema — the facts every generated `propose_<op>` tool shares, the picker's toolsets, the verified connector mail send spellings in `never_call` (with server/version sources), and the CLI's own built-ins in argv order, each with its tool-approval `family` and the input field its card names it by (`subject`, M57.2). Read by `src-tauri/src/policy/tools.rs`: `mcp.rs` serves `tools/list` from it with annotations, and derives the scope and read targets, the open-page announcements and the read-to-replace guard; `tool-approval.v1.json` plans the CLI's built-ins by its family column. TS reads the same file through `src/lib/policy/tools.ts` (M54.2), refusal for refusal, and derives the picker's toolsets, summaries and writes flags, the transcript's icons, write cards, row renderers and read folds (M56.8), the turn checkpoint's trigger and the run log's paths from it. Both sides hash against `tools.v1.sha256`, and both replay `src-tauri/fixtures/tool-cases.json`, its shared case file. navigate's `to` enum is `src/engine/destinations.ts`'s ids plus view, held there by `destinations.test.ts`; Rust refuses any `to` the served enum doesn't list (M59.1). Since M91.1 the CLI rows are every built-in a 2.1.250 init can list and the outward ones the binary ships, each answering to its `aliases` too (an init's `Task` is the `Agent` row), every fold names its `running` words, and a row may name its status `phrases`, as thirty rows do since M91.13 (the manifest's judgment calls below name them).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `connector-ownership.v1.json` + `.sha256`, `connector-ownership-cases.v1.json` | Explicit raw connector ownership admission (M96.4a): recognized owners, legacy absent-owner default, managed-only markers, fail-closed dispositions and safe reasons. Rust `policy/connector_ownership.rs` and TS `engine/connectorOwnership.ts` load the same bytes and replay shared entry/parser cases. This grants no managed route or credential authority. |
| `mail.v1.json` + `.sha256`               | Mail's private folders, scoped default-closed R14 gate, mail hosts and unattended connector reader denials. Rust `policy/mail.rs` and TS `engine/mailPolicy.ts` load it strictly; `mail/mod.rs` and TS replay the host cases. Runtime reads the artifact alone; tests verify the evidence pack before an open gate can ship.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tool-approval.v1.json` + `.sha256`      | **What Claude Code may run** (M57.2): for each tool family of the manifest, in its order, a grid of run kind (attended, unattended, internal) by ceiling (`none`, the shell's off, ask and on, or since M57.7 the web's off and on) to one of six decisions, the read scope's overrides, the permission modes, a card (title, kind and the answers it offers) on every family that asks and a message on every family that refuses (a `deny` cell says it too, where the family has one), and the words the model and the person read. Since M57.3 the question family (AskUserQuestion) asks on an attended run with a `question` card and is denied wherever nobody watches. Since M57.4 it also decides an ask-first agent's page writes: the `confirmable` family, whose members are the manifest's confirmable rows, is read by the agent's `ask_first` (yes or no) where the other families read a ceiling, and the `ask_first` block holds the record key and the values a record may hold. Since M57.4c an unattended ask-first write queues for Review (`queue`, the ask-first family's alone) within `queue_limits`. Since M57.7 the web family (WebFetch, WebSearch) reads the `web` ceiling, the Settings Web access switch: off denies it, on allows it, and internal runs are denied it either way. Since M60.8b `hidden_paths` names the vault folders (`.trash`) the CLI's own tools may not open, and which tools' path rules close them (Read, Edit). Since M91.1 a plan names the only built-ins a run holds (`tools`, its `--tools`); the task-list, background, cross-session, schedule, outside and skill families deny on every run; a family that `needs_gate` (the subagent tool) is denied wherever no gate sits; a family that `loads_tools` (ToolSearch) is left to the CLI on every run, an internal one included; the todo family pre-approves TodoWrite only where someone watches; and `messages.unknown_tool` is the init gate's stop for a built-in the manifest has no row for. Since M91.2a the subagent tool reads its own ceiling, `delegate` (off, on), the Settings Subagents switch: off denies it, and on leaves it to the CLI where a gate sits; a family's optional `narrowed_out` (`deny` or `default`) says what becomes of its tools when a record's narrowing names none of them by name or alias (deny on the delegate family alone); and `agent_types` pins Claude Code's built-in agent types, the ones a 2.1.250 init lists, beside the ones Cerebro allows (`subagents.v1.json`'s presets), which a plan that holds the subagent tool names (`denied_agent_types`, `allowed_agent_types`): since M91.2b a run's argv denies the first by name beside the person's own types, its init gate stops it when offered a type argv neither allows nor denies, and its ask gate lets a subagent start only as one of the second. Interpreted by `src-tauri/src/policy/tool_approval.rs` (argv, the init's mode check and the ask gate's `host_answer`) and `src/lib/policy/toolApproval.ts` (the mock, the panel's prompts), refusal for refusal. Both hash against the `.sha256`. |
| `goldens-tool-approval/*.json`           | The table's parity mechanism, replayed by `cargo test` and `pnpm test:run` from the same bytes: one plan golden per run kind × shell ceiling (each with the web off), one per run kind with the web on and one narrowed to WebFetch (M57.7), two read-scoped and two narrowed ones, five ask-first ones (M57.4; the unattended one waits in Review since M57.4c) (each pinning the mode, both lists, the hidden folders' path rules ending every attended and unattended deny list since M60.8b, the gate's matcher, what is withheld and every tool's decision), and `host-answers.json`, the gate's answer for single calls, beside the two question files (`question-attended-asks.json`, `question-unattended-denied.json`, M57.3) and `builtins-fail-closed.json` (M91.1: the subagent tool and its alias, a cross-session tool, ToolSearch). Since M91.1 every plan golden pins `tools`, the run's `--tools`, too. Since M91.2a every input names its Subagents switch (`delegate`: on where a person watches, off elsewhere), every plan golden pins the agent types its plan names, five more pin the switch off on an attended run, on where no gate sits (unattended, internal), a narrowing that leaves the subagent tool out and one that keeps it as `Task`, and `delegate-host-answers.json` holds the gate's answer under the switch. Both suites assert every cell, every run kind at each switch, both narrowings and every host outcome has a golden.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `subagents.v1.json` + `.sha256`          | **How far Claude Code's subagents may go** (M91.1): the Claude Code they were measured on (`cli_version`, the tool-approval table's pin) and the `env` every run but an internal one starts Claude Code with: subagents in the foreground, one level deep, two at once and eight a session, and since M91.2a none of Claude Code's built-in agent types. Names are Claude Code's own (`CLAUDE_`, then capitals, digits and underscores) in ASCII order, values plain words. Since M91.2a it also holds `seated_env`, what a seated run adds by the same rules and never one of `env`'s names (the todo list, never the task list other sessions share); `presets`, the agent types Cerebro defines, each a name argv carries whole (the tool-approval table's agent-type grammar, once), one sentence the main model reads (a capital first, a full stop last, one line, at most 300 characters, naming no tool and no retired term), the manifest's toolsets it holds (declared, once, each of read_only rows on non-writing doors) and the CLI rows it holds where its run holds them (`web_when_held`: by their names, once, each one a tool the web ceiling holds, so never the shell, the subagent tool or another that acts); and `settings`, the hardening every run's settings file carries, spelled as Claude Code's schema spells it (`permissions.disableBypassPermissionsMode` and `disableAutoMode`, each `disable`). The presets are exactly the table's `agent_types.allowed`. Read by `src-tauri/src/policy/subagents.rs`, whose variables `agent::cli_command` sets on the child, and by `src/lib/policy/subagents.ts` (imported raw), refusal for refusal; both hash against the `.sha256`. Since M91.2b every run but an internal one carries `env`, and a seated run `seated_env` after it, on its child (`agent::cli_command`) and again as its one `--settings` file's `env` beside `settings` (`agent::run_settings`), and `src-tauri/src/agent/cli_agents.rs` defines the presets in a run's `--agents`, each narrowed to the run's grant, with its prompt from `shared/prompt/subagents/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Some artifacts are Rust-only, and that is not an exemption from the house
rule.** `freshness`, `coverage-fold` and `lanes` have no browser ledger evaluator;
`run-configuration` has no browser retention writer. There is no twin to disagree
with. If a surface ever needs one of these rules on the TS
side, it loads the same file; it does not reimplement the rule.

The whole directory is `.prettierignore`d: the bytes are hashed, and a
formatter that reflowed them would break the anchor.

## Twins (D3): one rule, two readers, shared cases

**The owner's ruling (2026-10-12, recorded by M60.3).** Rust may twin a TS
vault semantic (what a wikilink means, how a quote matches, a filter, a field
kind, a date) under five conditions:

- **One artifact or case file holds the rule.** A hashed artifact (the policy
  table, `shared/schema/field-kinds.v1.json`, `shared/calendar/dates.v1.json`)
  or a case file under `src-tauri/fixtures/` or `conformance/`.
- **cargo and vitest both replay it**, from the same bytes, never by review
  of two hand-mirrored implementations.
- **It starts narrow and grows only with a case.** New behaviour arrives as
  a new case both suites must pass.
- **A gap between the languages is recorded, never papered over.** Where
  offsets differ (Rust bytes, TS UTF-16 units) the cases pin what both can
  say alike, such as lines and code-point contexts, and the artifact's README
  lists what the cases leave unpinned.
- **An unlisted twin is the review-blocking defect.** Every twin has a row
  below, and `scripts/twins.test.ts` holds each row: its paths exist, each
  replay file names what holds it, and no twin is listed twice.

`src-tauri/src/vault/link.rs` (wikilink targets, against
`src/engine/wikilink.ts`) is the precedent; M55.5's quote rules follow it.

**Pinned as data** (`shared/schema/field-kinds.v1.json`, held by its cases):

- **Virtual-field precedence:** a field's value is the entry's own fact
  (`title`, `type`, `createdAt`, `modifiedAt`), then a declared computed kind,
  then the relationship, then the property.
- **Collation:** `text_tests` lowercase, `equality` exact, `ordered`
  number_date_code_unit (number, then the date grammar's day, then UTF-16 code
  units), `sort` options_number_locale (declared options, number, then the
  reader's locale; TS-only).

A part that adds a shared case file adds its row here in the same commit.

| Twin | Rust replay | TS replay | Held by | Since |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------- |
| checked mention body envelope preserves bytes outside the chosen mention                                                                                                             | `src-tauri/src/vault/write.rs`                                                                    | `src/editor/mentionLink.test.ts`                                          | `shared/knowledge/mention-link-body.v1.json`                                                    | M97.5                        |
| selected authority exact property projection and metadata-only Full width CAS                                                                                                        | `src-tauri/src/workspace_service/selected_tests.rs`                                               | `src/lib/selectedMock.test.ts`                                            | `shared/workspace/authority.v2.json`                                                            | M99.6                        |
| explicit retained-draft export capability and exact body-only new-page creation                                                                                                      | `src-tauri/src/draft_recovery_commands.rs`                                                        | `src/lib/draftRecoveryIpc.test.ts`                                        | `shared/policy/draft-export.v1.json`, `src-tauri/fixtures/draft-recovery-cases.json`            | M93.2                        |
| local recovery retention, byte/row/path bounds and failure-choice expiry                                                                                                             | `src-tauri/src/vault/recovery/tests.rs`                                                           | `src/lib/policy/recovery.test.ts`                                         | `shared/policy/recovery.v1.json`                                                                | M93.9                        |
| exact human source body suffix and metadata-prefix preservation                                                                                                                      | `src-tauri/src/vault/write.rs`                                                                    | `src/editor/sourceBodyEdits.test.ts`                                      | `src-tauri/fixtures/source-body-cases.json`                                                     | M93.8                        |
| mail storage, URL hosts, mailbox normalization and the scoped admission gate                                                                                                         | `src-tauri/src/policy/mail.rs`, `src-tauri/src/mail/mod.rs`, `src-tauri/src/mail/address.rs`      | `src/engine/mailPolicy.test.ts`, `src/engine/mailAddress.test.ts`         | `shared/policy/mail.v1.json`                                                                    | M69.7–.7c                    |
| the policy table and its goldens                                                                                                                                                     | `src-tauri/src/policy/goldens.rs`                                                                 | `src/lib/policy/goldens.test.ts`                                          | `shared/policy/policy.v3.json`, `shared/policy/goldens/`                                        | M24                          |
| critical attention and its goldens                                                                                                                                                   | `src-tauri/src/attention/critical.rs`                                                             | `src/lib/attention/critical.test.ts`                                      | `shared/policy/critical-attention.v1.json`, `shared/policy/goldens-critical/`                   | M27.7                        |
| the trigger registry and its goldens                                                                                                                                                 | `src-tauri/src/trigger/evaluation.rs`                                                             | `src/lib/trigger/evaluation.test.ts`                                      | `shared/policy/trigger-registry.v1.json`, `shared/policy/goldens-trigger/`                      | M28.0                        |
| the epistemic reducer's vectors                                                                                                                                                      | `src-tauri/src/ledger/conformance.rs`                                                             | `src/lib/epistemic/conformance.test.ts`                                   | `conformance/`                                                                                  | M22.4                        |
| staleness                                                                                                                                                                            | `src-tauri/src/knowledge.rs`                                                                      | `src/engine/okf.test.ts`                                                  | `shared/policy/staleness.v1.json`                                                               | M49.8                        |
| note targets the write guards refuse                                                                                                                                                 | `src-tauri/src/vault/write.rs`                                                                    | `src/lib/mockIpc.test.ts`, `src/engine/docPages.test.ts`                  | `src-tauri/fixtures/note-targets.json`                                                          | M53.4                        |
| where the webview may navigate                                                                                                                                                       | `src-tauri/src/shell/links.rs`                                                                    | `src/mermaid/flowchart/linkTargets.test.ts`                               | `shared/policy/links.v1.json`                                                                   | M53.12                       |
| personal token names and grants                                                                                                                                                      | `src-tauri/src/runtime/client_tokens.rs`                                                          | `src/lib/mockIpc.test.ts`                                                 | `src-tauri/fixtures/client-tokens.json`                                                         | M62.5                        |
| source slugs                                                                                                                                                                         | `src-tauri/src/mcp.rs`                                                                            | `src/engine/ingest.test.ts`                                               | `src-tauri/fixtures/source-slugs.json`                                                          | M53.17                       |
| the scan golden, including the first H1 and its replacement (`firstH1LineIndex` / `replaceH1` in frontmatter.ts against `first_h1_line_start` / `replace_h1` in parse.rs / write.rs) | `src-tauri/src/vault/scan.rs`                                                                     | `src/lib/scanGolden.test.ts`, `src/engine/frontmatter.test.ts`            | `conformance/scan/entries.json`                                                                 | M53.22, M55.2, M60.11        |
| knowledge bundle paths                                                                                                                                                               | `src-tauri/src/knowledge.rs`                                                                      | `src/engine/okf.test.ts`                                                  | `src-tauri/fixtures/bundle-paths.json`                                                          | M53.28                       |
| projection claims                                                                                                                                                                    | `src-tauri/src/ledger/conformance.rs`                                                             | `src/lib/epistemic/schema.test.ts`                                        | `conformance/projection-claims.json`                                                            | M53.29                       |
| the tool manifest's cases, the CLI rows' aliases and running folds included                                                                                                          | `src-tauri/src/mcp.rs`                                                                            | `src/lib/policy/tools.test.ts`, `src/engine/tools.test.ts`                | `src-tauri/fixtures/tool-cases.json`                                                            | M54.1, M54.2, M91.1          |
| a run's tool grant                                                                                                                                                                   | `src-tauri/src/agent/mod.rs`                                                                      | `src/engine/toolGrant.test.ts`                                            | `src-tauri/fixtures/tool-grants.json`                                                           | M54.7, M91.1                 |
| edit_note's quote rules                                                                                                                                                              | `src-tauri/src/vault/quote.rs`                                                                    | `src/engine/quote.test.ts`                                                | `src-tauri/fixtures/quote-cases.json`                                                           | M55.5                        |
| set_fields' plan: labels to ids, link wrapping and the target check, deltas, ghosts, and the report and refusal words                                                                | `src-tauri/src/vault/set_fields.rs`                                                               | `src/engine/setFields.test.ts`                                            | `src-tauri/fixtures/set-fields-cases.json`                                                      | M60.4                        |
| wikilink targets (stem, project folder, item key, title)                                                                                                                             | `src-tauri/src/vault/link.rs`                                                                     | `src/engine/wikilink.test.ts`                                             | `src-tauri/fixtures/wikilink-targets.json`                                                      | M55.8, M60.9                 |
| the transcript fold, a subagent's sub-fold included                                                                                                                                  | `src-tauri/src/agent/fold.rs`                                                                     | `src/agent/transcript.test.ts`                                            | `conformance/transcript/`                                                                       | M56.3, M91.3–.4              |
| Claude Code's context breakdown: what the meter keeps of a seated run's answer to the context ask, its kinds, caps and cut names                                                     | `src-tauri/src/agent/meter.rs`                                                                    | `src/engine/ai/contextBreakdown.test.ts`                                  | `src-tauri/fixtures/context-breakdown.json`                                                     | M92.13, M92.14               |
| run options                                                                                                                                                                          | `src-tauri/src/agent/run_options.rs`                                                              | `src/engine/runOptions.test.ts`                                           | `shared/policy/run-options.v1.json`                                                             | M56.5                        |
| what Claude Code may run, the subagent tool's ceiling and the agent types it may start                                                                                               | `src-tauri/src/policy/tool_approval.rs`                                                           | `src/lib/policy/toolApproval.test.ts`                                     | `shared/policy/tool-approval.v1.json`, `shared/policy/goldens-tool-approval/`                   | M57.2, M91.1, M91.2a         |
| how far Claude Code's subagents may go, what a seated run adds, Cerebro's agent types, the hardening settings, and the loader's refusal words                                        | `src-tauri/src/policy/subagents.rs`                                                               | `src/lib/policy/subagents.test.ts`                                        | `shared/policy/subagents.v1.json`                                                               | M91.1, M91.2a                |
| question answers                                                                                                                                                                     | `src-tauri/src/agent/question.rs`                                                                 | `src/engine/questionForm.test.ts`                                         | `src-tauri/fixtures/question-answers.json`                                                      | M57.3                        |
| write doors and their stamps                                                                                                                                                         | `src-tauri/src/lib.rs`, `src-tauri/src/mcp.rs`                                                    | `src/lib/mockIpc.test.ts`                                                 | `src-tauri/fixtures/write-doors.json`                                                           | M58.1                        |
| an agent's read scope                                                                                                                                                                | `src-tauri/src/mcp.rs`                                                                            | `src/engine/agentAccess.test.ts`                                          | `src-tauri/fixtures/grant-scope.json`                                                           | M58.6                        |
| searchable values                                                                                                                                                                    | `src-tauri/src/search.rs`                                                                         | `src/engine/searchable.test.ts`                                           | `src-tauri/fixtures/searchable-values.json`                                                     | M59.2                        |
| source locations                                                                                                                                                                     | `src-tauri/src/source_location.rs`                                                                | `src/engine/sourceLocation.test.ts`                                       | `shared/knowledge/source-location.v1.json`, `shared/knowledge/source-location-cases.json`       | M97.1                        |
| source occurrences                                                                                                                                                                   | `src-tauri/src/source_occurrences.rs`                                                             | `src/engine/sourceOccurrences.test.ts`                                    | `shared/knowledge/source-occurrences.v1.json`, `shared/knowledge/source-occurrences-cases.json` | M97.5                        |
| the in-app Trash                                                                                                                                                                     | `src-tauri/src/vault/trash.rs`                                                                    | `src/engine/trash.test.ts`, `src/lib/mockIpc.test.ts`                     | `src-tauri/fixtures/trash-cases.json`                                                           | M60.8                        |
| batch writes and import plans: order, words and outcomes                                                                                                                             | `src-tauri/src/vault/batch.rs`                                                                    | `src/lib/mockIpc.test.ts`, `src/engine/batch.test.ts`                     | `src-tauri/fixtures/batch-cases.json`                                                           | M60.6                        |
| field kinds (including text-only repeat), value shapes, formula definitions, the status chain and declared deadlines (`replays_the_deadline_cases`)                                  | `src-tauri/src/vault/schema.rs`                                                                   | `src/engine/fieldKindTable.test.ts`                                       | `shared/schema/field-kinds.v1.json`                                                             | M60.3, M61.3b, M61.4, M61.10 |
| the date grammar, including injected-clock relative tokens                                                                                                                           | `src-tauri/src/vault/dates.rs`                                                                    | `src/engine/dateGrammar.test.ts`, `src/engine/relativeDates.test.ts`      | `shared/calendar/dates.v1.json`                                                                 | M60.3, M61.3c                |
| structured query filters, sorts and decimal number readings                                                                                                                          | `src-tauri/src/vault/query.rs`                                                                    | `src/engine/filterCases.test.ts`                                          | `src-tauri/fixtures/filter-cases.json`                                                          | M62.2                        |
| stored date placement, half-open agenda windows and recurrence pairing                                                                                                               | `src-tauri/src/vault/agenda.rs`                                                                   | `src/engine/agendaCases.test.ts`                                          | `src-tauri/fixtures/agenda-cases.json`                                                          | M62.3                        |
| checked view vocabulary                                                                                                                                                              | `src-tauri/src/vault/views.rs`                                                                    | `src/engine/viewVocabulary.test.ts`                                       | `shared/schema/views.v1.json`                                                                   | M62.4                        |
| upstream sheet calculation, limits and refusal words                                                                                                                                 | `src-tauri/src/sheet/engine.rs`                                                                   | `src/lib/mockSheet.ironcalc.test.ts`                                      | `src-tauri/fixtures/sheet-calc-cases.json`                                                      | M67.1                        |
| sheet fence headers, raw CSV records and source spans, including page bodies                                                                                                         | `src-tauri/src/sheet/fence.rs`                                                                    | `src/engine/sheet/fence.test.ts`                                          | `src-tauri/fixtures/sheet-fence-cases.json`                                                     | M67.2, M67.2b                |
| sheet source edit plans, refusal order and exact calculation reports                                                                                                                 | `src-tauri/src/sheet/edit.rs`, `src-tauri/src/sheet/ai.rs`                                        | `src/engine/sheet/edit.test.ts`, `src/lib/mockSheetEdit.ironcalc.test.ts` | `src-tauri/fixtures/sheet-edit-cases.json`                                                      | M67.2b                       |
| structural sheet reference rewriting, bounded fill and formula completion                                                                                                            | `src-tauri/src/sheet/grid.rs`                                                                     | `src/lib/mockSheet.ironcalc.test.ts`                                      | `src-tauri/fixtures/sheet-grid-ops.json`                                                        | M67.3, M67.3b                |
| checked view suggestion answers and refusals                                                                                                                                         | `src-tauri/src/vault/views.rs`                                                                    | `src/engine/viewSuggestion.test.ts`, `src/lib/mockIpc.test.ts`            | `src-tauri/fixtures/view-suggestion-cases.json`                                                 | M62.4                        |
| pre-run check eligible wakes and retry windows                                                                                                                                       | `src-tauri/src/agent/condition.rs`                                                                | `src/lib/mockIpc.test.ts`                                                 | `src-tauri/fixtures/condition-cases.json`                                                       | M63.7                        |
| self-followup booking, claims and cancellation words                                                                                                                                 | `src-tauri/src/runtime/followups.rs`                                                              | `src/lib/mockIpc.test.ts`                                                 | `src-tauri/fixtures/followup-cases.json`                                                        | M63.8                        |
| durable wakes: admission, recorded writers, chain bounds, assignment releases, claims, finishes, cancels and expiry                                                                  | `src-tauri/src/runtime/wakes.rs`                                                                  | `src/lib/mockIpc.test.ts`                                                 | `src-tauri/fixtures/wake-cases.json`                                                            | M63.1, .2, .3b               |
| durable reminder claims and revision-aware Done marks                                                                                                                                | `src-tauri/src/runtime/reminders.rs`, `src-tauri/src/runtime/done_marks.rs`                       | `src/lib/mockIpc.test.ts`                                                 | `src-tauri/fixtures/reminder-state-cases.json`                                                  | M64.3                        |
| History's activity window and its refusals                                                                                                                                           | `src-tauri/src/runtime/activity.rs`                                                               | `src/lib/mockIpc.test.ts`                                                 | `src-tauri/fixtures/activity-window-cases.json`                                                 | M64.2                        |
| connector approvals                                                                                                                                                                  | `src-tauri/src/connectors.rs`                                                                     | `src/engine/connectors.test.ts`                                           | `src-tauri/fixtures/connector-approvals.json`                                                   | M69.1                        |
| explicit raw connector ownership and loader fail-closed behavior | `src-tauri/src/policy/connector_ownership_tests.rs` | `src/engine/connectorOwnership.test.ts` | `shared/policy/connector-ownership.v1.json`, `shared/policy/connector-ownership-cases.v1.json` | M96.4a |
| comment sidecars                                                                                                                                                                     | `src-tauri/src/vault/comments.rs`                                                                 | `src/engine/comments.test.ts`, `src/lib/mockIpc.test.ts`                  | `src-tauri/fixtures/comment-cases.json`                                                         | M70.2                        |
| the agent comment tools' quote filter and words                                                                                                                                      | `src-tauri/src/comment_tools.rs`                                                                  | `src/engine/quote.test.ts`, `src/lib/mockIpc.test.ts`                     | `src-tauri/fixtures/comment-tools.json`                                                         | M70.3                        |
| a page thread's turns                                                                                                                                                                | `src-tauri/src/agent/thread_turn.rs`                                                              | `src/lib/mockIpc.test.ts`                                                 | `src-tauri/fixtures/thread-turns.json`                                                          | M70.4                        |
| file kinds, their refusals and the open verdict's cases                                                                                                                              | `src-tauri/src/files/kinds.rs`                                                                    | `src/engine/fileKinds.test.ts`                                            | `shared/files/kinds.v1.json`, `src-tauri/fixtures/file-kind-cases.json`                         | M66.1                        |
| contained root file addresses, byte doors and refusal words                                                                                                                          | `src-tauri/src/files/bytes.rs`                                                                    | `src/engine/fileBytes.test.ts`, `src/lib/mockBytes.test.ts`               | `shared/files/bytes.v1.json`                                                                    | M66.2                        |
| explicitly dropped file metadata and bounded capture text                                                                                                                            | `src-tauri/src/files/dropped.rs`                                                                  | `src/lib/mockDropped.test.ts`                                             | `src-tauri/fixtures/dropped-cases.json`                                                         | M66.3                        |
| whole-line page media and contained picture destinations                                                                                                                             | `src-tauri/src/files/media.rs`                                                                    | `src/engine/pageMedia.test.ts`                                            | `src-tauri/fixtures/media-lines.json`                                                           | M66.8b                       |
| thumbnail sizes, sources and negative-cache reasons                                                                                                                                  | `src-tauri/src/files/thumbs.rs`                                                                   | `src/engine/thumbs.test.ts`                                               | `src-tauri/fixtures/thumbnail-cases.json`                                                       | M66.9                        |
| contained document paths and refusal order                                                                                                                                           | `src-tauri/src/files/extract/mod.rs`                                                              | `src/lib/mockExtract.test.ts`                                             | `src-tauri/fixtures/document-paths.json`                                                        | M66.7c                       |
| inert extracted document text                                                                                                                                                        | `src-tauri/src/files/extract/markdown.rs`                                                         | `src/engine/extracted.test.ts`                                            | `src-tauri/fixtures/extract-escape.json`                                                        | M66.7c                       |
| extraction outcome wire shapes                                                                                                                                                       | `src-tauri/src/files/extract/mod.rs`                                                              | `src/engine/extracted.test.ts`, `src/lib/mockExtract.test.ts`             | `src-tauri/fixtures/extract-wire.json`                                                          | M66.7c                       |
| attachment names, hidden refusal and size cap                                                                                                                                        | `src-tauri/src/vault/write.rs`                                                                    | `src/engine/attachments.test.ts`, `src/lib/mockAttachments.test.ts`       | `src-tauri/fixtures/attachment-names.json`                                                      | M66.6                        |
| import identity, stamps and their protection, hash and URL grammar                                                                                                                   | `src-tauri/src/import/mod.rs`, `src-tauri/src/import/stamps.rs`                                   | `src/engine/importSources.test.ts`                                        | `shared/import/sources.v1.json`                                                                 | M69.3–.3b                    |
| JSON Canvas format, reader and writer, unknown values and refusal words                                                                                                              | `src-tauri/src/canvas/format.rs`, `src-tauri/src/canvas/read.rs`, `src-tauri/src/canvas/write.rs` | `src/engine/scene/format.test.ts`, `src/engine/scene/jsonCanvas.test.ts`  | `shared/canvas/format.v1.json`, `shared/canvas/format-cases.json`, `shared/canvas/cases.json`   | M68.2, M68.7                 |
| whiteboard agent caps and loader refusal words                                                                                                                                       | `src-tauri/src/canvas/agent_limits.rs`                                                            | `src/engine/scene/canvasLimits.test.ts`                                   | `shared/canvas/agent-limits.v1.json`, `shared/canvas/agent-limit-cases.json`                    | M68.7                        |
| checked whiteboard edits: operations, preserved bytes and refusal words                                                                                                              | `src-tauri/src/canvas/edit.rs`                                                                    | `src/engine/scene/agentEdit.test.ts`                                      | `src-tauri/fixtures/canvas-edit-cases.json`                                                     | M68.7b                       |
| canonical GitHub pull request URLs                                                                                                                                                   | `src-tauri/src/forge.rs`                                                                          | `src/engine/pullRequest.test.ts`                                          | `src-tauri/fixtures/pr-urls.json`                                                               | M69.11                       |
| normalized gh read outcomes and check readiness                                                                                                                                      | `src-tauri/src/forge.rs`                                                                          | `src/engine/pullRequest.test.ts`                                          | `src-tauri/fixtures/pr-cases.json`                                                              | M69.11                       |
| normalized correspondent dismissals, words and per-vault rows                                                                                                                        | `src-tauri/src/runtime/mail_dismissals.rs`                                                        | `src/lib/mockIpc.test.ts`, `src/engine/unfiled.test.ts`                   | `src-tauri/fixtures/mail-dismissal-cases.json`                                                  | M69.9b                       |

## Regenerating

Each is a deliberate act, so each is an `#[ignore]`d test rather than something
the suite does on its own:

```sh
cd src-tauri
# after an edit to recovery.v1.json
cargo test --lib vault::recovery::tests::write_recovery_digest -- --ignored
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
# rule_version to tool-approval/<date>, and rewrite the goldens it changes:
# the second command rewrites every plan golden's `expected`, and the five
# files that hold `host_answers` (host-answers.json, delegate-host-answers.json,
# builtins-fail-closed.json and the two question files) are edited by hand)
cargo test --lib policy::tool_approval::tests::write_tool_approval_digest -- --ignored
cargo test --lib policy::tool_approval::tests::write_tool_approval_goldens -- --ignored
# after an edit to subagents.v1.json (a preset added or renamed is a
# tool-approval edit too, since the presets are exactly agent_types.allowed,
# and its prompt goes under shared/prompt/subagents/, named in
# src-tauri/src/agent/cli_agents.rs's PRESET_PROMPTS)
cargo test --lib policy::subagents::tests::write_subagents_digest -- --ignored
# after an edit to connector-ownership.v1.json
cargo test --lib policy::connector_ownership::tests::write_connector_ownership_digest -- --ignored
```

On a Mac each of these also carries the crash skip list, as the mail
command below spells it.

A new snapshot must also be added to `RESOLVABLE_ARTIFACTS` in
`src-tauri/src/policy/authority.rs`, or `snapshots_on_disk_are_all_compiled_in`
fails — a snapshot no build can read is a rule a proposal can pin and nothing
can evaluate.

## Ordering is canonical, not cosmetic

Every closed list is non-empty, duplicate-free, and in canonical order, because
two artifacts that mean the same thing must not be able to differ.

- In `policy.v3.json`, canonical means **sorted**. `unbound_rejections` is the
  one list allowed to be _empty_, and format 2 emptied it (see below).
- In `authority-routes.v1.json`, canonical means the **enum declaration order**
  the M22 schema fixes: `planned … shipping` reads as reality moving forward,
  `project_owner … unknown` as authority descending. Load reports the expected
  order when it refuses.

`evaluation_order` is the exception — it _is_ an order. Precedence between
refusals is policy ("does an unavailable capability outrank an understated
risk?"), so it lives in the artifact rather than in whichever `if` happens to
come first in each language.

`tools.v1.json` holds two more orders of that kind: its `tools` are in served
order and its `cli_tools` in argv order, so neither is sorted.
`subagents.v1.json`'s `env` names are in ASCII order (M91.1), and so are
its `seated_env` names (M91.2a), which both readers check; its `presets` are
in the order argv names them.

## Judgment calls recorded here

- **M67.2b — sheet edits are one checked source batch:** only `set_cells`
  and `add_sheet` are admitted. An empty value clears a cell; canonical CSV
  encoding rewrites only touched fences, with the surrounding page and
  frontmatter preserved. Reported formula errors do not repair or refuse a
  valid source edit. Reports compare exact cached values, never formatted
  numbers. The npm binding lacks that getter, so the browser decodes its
  just-calculated carrier through a project-owned facade of the same pinned,
  unchanged engine. `scripts/sheet-values/README.md` documents the measured
  gap, reproducible build, provenance and shared report replay.

- **M67.2 — `calculate_sheet` is a read:** hypothetical inputs live only in
  the call's private workbook. It uses read scope, produces no write receipt
  and announces no page change. Its source strings and computed values are
  page data, never prompt instructions.

- **Agenda placement (M62.3):** `agenda-cases.json` holds points, inclusive
  date ends, midnight ends, open and backwards ranges and recurrence pairing.
  Timed windows are Rust-only: the calendar asks for days, the agenda for
  minutes. Start, end and labels are Rust's display words; TS verifies the
  shared point, day-span and conversion facts. Absent and unreadable values
  both produce no span in TS; Rust counts them separately. An open or
  backwards range preserves its start. Recurrence is never expanded here;
  only the first-daterange-else-first-date pairing is shared. Read scope
  applies to Type docs as well as records, so an unseen schema cannot supply
  dates. An invalid stored value is counted as unreadable, never as absent.
- **Structured query parity (M62.2):** `filter-cases.json` holds only queries
  Rust admits. The app skips unfinished conditions while a query refuses them.
  Text sorts caseless by code point in Rust and by locale in the app; the cases
  pin ASCII ordering, including lowercase first on a tie. Decimal text uses
  `numericText` / `numeric_text`, never JavaScript's hex or empty-string
  coercion. Rollups, formulas and derived relations are not evaluated by Rust.
  Relative tokens resolve on the case's injected day with Sunday weeks.
  UTF-16 versus code-point ordering and exotic `String(number)` spellings stay
  unpinned; the query answer names the text-sort difference.

- **`thresholds.lineage_fan_in_high = 5`.** The design fixes the _mechanism_
  (fan-in above a named threshold floors risk at HIGH) and leaves the number
  open. Five is the line at which a belief is load-bearing enough that editing
  it deserves a person's eyes. It is data precisely so it can be retuned
  without touching either interpreter — but retuning it changes what
  auto-applies, so move it deliberately and re-run the goldens.
- **`silence.allowed_transitions` is an allowlist**, not a forbidden list, so a
  transition added in a later milestone is forbidden under silence _by default_.
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
  available: the type doc still _looks_ like it protects something. The gate
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
  added later that _does_ carry a basis cannot reach the table without the
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
- **Both loaders read formats 1 _and_ 2.** v1 is not kept for nostalgia: it is
  the negative control proving M26.3's registration gate refuses for the right
  reason. Pointed at v1, `ancestry::table_binding` must fail on the _absent
  binding_, not on an unknown code — the wrong-reason failure would evaporate
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
- **The receipt this build mints is `search_version: 3`, and the design says 2.** The design assumed M24 shipped v1; M24.7 had already bumped to 2 when
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
  Human saves outside the editor also compare their loaded version (M65.7):
  `save_note` refuses stale `expect_hash` before writing or capturing a knowledge
  edit, and records one operational row under the `save_note` surface. Task
  ticks refresh without retrying; Library drafts wait for the person's choice.
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
  note it may not read. Editor saves never compare: the last write wins.

## No longer waiting (M57.1)

- **`no_longer_waiting` is a transport code.** It answers a person's late
  click after its request ended (answered, cancelled, or its vault closed).
  It fails at the door of `answer_interaction`, bounds no run and is
  recorded nowhere: the card already says so, in its own words. Operational,
  in no op row, not retryable, and `src-tauri/src/agent/interaction.rs` holds
  it as a const.

## Note exists (M61.6b)

- **`import_refused` is a transport code.** The Notion import door refuses
  before a byte, bounds one call and claims nothing, so the code is
  operational and belongs to no proposal op. Its recorder deduplicates by
  run, reason and canonical page id. A composable refusal licenses only a
  marked fallback for that same run's latest captured fetch; it never grants
  permission to supply an unmarked page body.

- **`note_exists` is a transport code.** An agent's `create_note` with
  `if_exists: "refuse"` that finds `<folder>/<slug>.md` taken fails at the
  write door, under the name's lock, before a byte is written. It bounds one
  call and claims nothing about the world, so it is operational, no op lists
  it, and `Rejection::new` keeps it out of the ledger, like M55.3's
  `stale_content`. A run gets one row per code, tool and note.
- **It is not `stale_content`.** No hash was named: the call asked for a
  name, not for bytes it had read, so borrowing the stale code would tell
  the agent to re-read a note it may never have seen.
- **It reveals no more than the numbered copy.** Without `refuse`, the same
  call lands `<slug>-2.md` and says which name was taken, so a refusal names
  nothing a write-scoped run could not already learn. The similar notes both
  answers list are read-scoped, like search_notes.

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
- **File targets are read-only (M66.8).** A `file` target requires a schema
  argument, the read axis and door none. `read_document` checks scope before
  opening and again against its contained descriptor's canonical path. It is
  granted by the read toolset, including personal-token clients.
- **Canvas targets name their door (M68.7–.7c).** A `canvas` target requires a
  schema argument: read/none or read_write/canvas. Door canvas also admits
  a folder target on the write axis, and no other combination. `read_canvas` checks scope
  before bytes and again against the pinned descriptor's canonical path.
  It reads one board up to the shared 8 MiB file cap. A file card is looked
  up only within read scope; outside that scope its target is `unchecked`,
  whether or not it exists. A card's contents and web links are never opened.
  The shared canvas limits cap the JSON answer independently of the file.
  `edit_canvas` validates ordered operations on a private board, then checks
  the output reads back exactly before one locked write. Existing dangling
  edges survive; adding or repointing one requires both nodes. Unknown JSON
  and Cerebro extras survive. Missing card targets warn and retain their
  pointers; a canonical target outside the vault refuses rather than being
  misreported as missing. Explicit ids share one namespace across nodes and
  edges; omitted ids derive from the original hash and one-based op index,
  retrying deterministic suffixes on collision. No-op plans preserve the
  original bytes and record nothing.
  `create_canvas` runs that planner on the exact empty-board seed. The final
  free filename is chosen and locked before planning, so a self-pointer
  check sees a concurrent create's numbered suffix. It writes once with one
  create receipt; Preview selects the same path without writing. A folder
  target may be optional only when its schema declares a string with
  `default: ""`, explicitly naming the vault root. Other targets remain
  required. The handler supplies that default; JSON Schema's annotation is
  not treated as client-side argument injection.
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
- **Computed record fields are never agent writes.** `set_fields` names
  formulas alongside rollups, timestamps and reverse relations (M61.4);
  the shared schema table declares which kinds are computed, and both
  planners refuse them before writing any part of the request.
- **Picker copy lives here.** Toolset labels and hints and each row's summary
  are the picker's words, and `src/engine/tools.ts` reads them from here
  (M54.2). A copy edit is an artifact edit with a digest regeneration.
- **Fold phrases are owner-read copy (M56.8).** A step-rendered read row's `fold {one,
many}` is how a run of its consecutive calls reads in a transcript ("Read
  5 notes"), so a phrase edit is an artifact edit with a digest regeneration.
  Only step-rendered reads fold, cerebro's `read_only` rows and the CLI's readers, so a
  write keeps its path in view; a failed or interrupted read is never folded
  out of sight. Phrases are lowercase (the row capitalizes the label it
  joins), at most 40 characters, `one` without `{n}` and `many` with exactly
  one. The four managed action metadata readers follow this same contract;
  their held access/effect decisions remain separate native cards. The
  additive `prepare_action` row never folds, so consequential review stays
  visible.
- **The renderer vocabulary is data (M56.8).** `step` and `change` serve any
  row; `concept`, `handoff`, `commit` and `view` draw one door's work and sit only on
  it: `concept` on door `concept` (write_concept, recheck_concept), `handoff`
  on door `run` (hand_to), `commit` on door `ledger` and the proposals
  surface (commit_proposals), and `view` only on door `none` (suggest_view).
  A checked view has its own card and never folds. `subagent` and `todo`
  (M91.1) draw one of the CLI's own tools, a subagent's work and a todo
  list, and sit only on its rows. The generated `propose_*` tools stay
  `step`, a CLI row takes `step`, `change`, `subagent` or `todo`, and a
  `concept` row, like a `change` row, needs a target. A new renderer is an
  artifact edit and a loader change on both sides.
- **Two loaders, one refusal list.** `tools.rs` and `src/lib/policy/tools.ts`
  refuse the same manifests in the same words, and each holds one negative
  control per refusal. TS checks by hand the shape serde checks in Rust: an
  unknown field fails, and an absent `Option` field reads as null.
- **The `_meta` keys are CLI behaviour, read from 2.1.250.**
  `anthropic/searchHint` is served on every tool and `anthropic/alwaysLoad`
  only where a row sets it; a key the CLI does not know is ignored, never
  fatal.
- **Seven tools load early, and no others (M54.5).** The CLI defers every MCP
  tool behind its tool search, so a run spent a turn finding
  `get_vault_context` before it could call it. An early tool's schema rides
  every turn of every run that lists it, so `always_load` is set only where
  it earns that: on the read core
  (`get_vault_context`, `search_notes`, `get_note`, `knowledge_about`), which
  nearly every run reaches for first, and on the three held tools
  (`report_window_outcome`, `submit_answer`, `submit_condition`), which `tools/list` shows only to
  the run holding their window, question or pre-run check (M54.4), so no other run pays for
  them and a synthesis run skips the search. Every other tool stays deferred:
  a write or a UI move comes later in a turn, if at all. Only a read-only row
  or a held tool may load early, and
  `agent::tests::only_the_read_core_and_held_tools_load_without_a_search` pins
  the seven.
- **A follow-up targets only its caller (M63.8).** `schedule_followup` is
  listed only to a `process:` run, and its handler resolves exactly one own
  Agent record. It has no target argument. At most three pending or claimed
  bookings wait for that agent in that vault, each five minutes to thirty
  days out, with a note of one to five hundred Unicode characters. The
  `later` toolset grants that booking alone; a personal client cannot hold it.
- **A CLI row names its family, never its decision (M57.2).** `family`
  is required and `subject` is null or an input field; what a family may do
  in a run is `tool-approval.v1.json`'s alone. The three shell columns M54.1
  kept here (denied without shell, denied when read-scoped, with shell) went
  to that table's grid and read scope.
- **Every built-in Claude Code offers has a row (M91.1).** The rows are the
  union of the built-ins 2.1.250's inits listed, signed in and not (the
  synthetic `src-tauri/fixtures/cli-stream/init-signed-in.json` holds them),
  and the outward ones its binary ships. A row may name `aliases`, other
  spellings Claude Code uses for it: an init lists `Task` for the subagent
  tool its calls name `Agent`. Names and aliases are one namespace, so a
  spelling answers with exactly one row's facts, through one lookup in each
  language (`cli_tool`, `cliTool`), and argv names a row by `name` alone.
  An init that offers a built-in with no row stops its run (the init gate).
- **A fold names its running words, and a row may name its status words
  (M91.1).** `fold.running` (`one`, `many`) reads as the fold does while
  its calls run ("reading 5 notes"), held to the same rules; the shipped
  manifest names it beside every fold. `phrases` (`running`, `done`,
  `failed`) is one call's row by status: at most 40 characters each, no
  count, lowercase. Both are optional, and a manifest without them reads as
  before. Since M91.13 thirty rows name `phrases`, the calls a turn draws as
  lines of their own, which `src/agent/elements/turnTitles.ts` titles by
  status: twenty of cerebro's (the note, sheet, canvas and comment writers,
  the concept writers, import_notion_page, cache_source, propose_organize,
  suggest_view, schedule_followup, open_note and navigate) and ten of the
  CLI's (Write, Edit, MultiEdit, NotebookEdit, Bash, WebFetch, WebSearch,
  AskUserQuestion, TodoWrite and ToolSearch). A row without them says its
  name: the reads fold instead, and hand_to, commit_proposals and the
  subagent tool draw their own words.
- **`concept_types` is the one token.** A `{{name}}` in a description or
  schema must be declared in `tokens`, and a declared token must be used;
  `mcp.rs` renders each one when it serves the row.
- **The note writers are the confirmable rows (M57.4).** `confirmable` is
  true on create_note, update_frontmatter, set_fields (M60.4), append_to_note
  and edit_note: the note door changes the person's own pages. The concept writers are not,
  because a person already verifies a concept; nor is cache_source, a cache;
  the generated tools are decided by policy.v3; hand_to and the UI tools write
  no page. Both loaders refuse it missing, on a door that writes nothing, off
  the write and read_write axes, and on the generated block.
- **set_fields keeps what it cannot check (M60.4).** Its cases
  (`src-tauri/fixtures/set-fields-cases.json`) pin three calls: an unknown
  option is kept as written and named, never refused (a ghost, M1); a link's
  type is checked only when the field declares `target:` and the run may read
  the page it names, so a link no readable page answers is kept and noted
  "not checked"; and a link is stored as the agent spelled it, never
  re-spelled. update_frontmatter stays permissive beside it.
- **`ask_gate` is a hook endpoint, not a manifest row (M57.1).** A run's
  PreToolUse hook (`type: mcp_tool`) calls it on the run's own bearer to ask
  whether a call may run, wait or not. `mcp.rs` answers it before every grant
  axis, as hook JSON; `tools/list` never lists it, and nothing counts,
  announces or records it. Live on 2.1.250 an `mcp_tool` hook reaches a tool
  its server leaves unlisted, beside a listed prompt tool too. It can
  register a wait and read a person's answer, never record one, so it has no
  row here and needs none.
- **`ask_host` is a hook endpoint too (M57.3).** A seated run names it as
  Claude Code's `--permission-prompt-tool`, which 2.1.250 needs before it
  offers AskUserQuestion in `-p`. `mcp.rs` answers it beside `ask_gate`,
  before every grant axis, and nothing counts, announces or records it.
  Live on 2.1.250, a run whose prompt tool its server does not list fails
  every tool call, pre-approved and always-loaded ones included. So the
  run's seat records that its argv names it, that run's `tools/list` alone
  lists it, and the same argv names it in `--disallowedTools`, which keeps
  it from the model while the CLI still asks it. It allows only a call the
  run's seat holds a person's answer for, with the input that answer made,
  and denies every other call, so it has no row here either.

## The tool-approval table (M57.2)

- **Six decisions, one carrier each.** `allow` rides `--allowedTools`;
  `deny` rides `--disallowedTools`; `ask` rides neither list and meets the
  ask gate, which asks the person on an attended run; `refuse` rides neither
  list on a run that can ask, where the gate denies it with the family's
  message, and `--disallowedTools` on every other run, so it is never left
  to the CLI; `cli` rides neither list, so the CLI's own rule decides (reads
  inside the vault need no approval, outside the hidden folders below, and
  the rest is refused in `-p`);
  `queue` (M57.4c) rides neither list, and dispatch holds the write for the
  person in Review. Since M91.1 every run also passes `--tools`, the built-ins
  its plan allows, asks for or leaves to the CLI: a built-in denied or
  refused there is no tool of the run at all, whatever the person's own
  settings allow, and a deny still rides `--disallowedTools` as the second
  line. 2.1.250 leaves MCP tools alone under `--tools` (measured).
- **A run that cannot ask never asks.** Only `attended` can ask, and only a
  run with a seat on a Claude Code the gate is built for is planned as one.
  Elsewhere an ask becomes a deny, its tools are `withheld`, and the meter
  records them as one `capability_unavailable` row under `agent.ask`; a
  refusal becomes a deny.
- **The order of a plan is fixed:** the grid's cell; then `read_scope`, which
  only ever denies; then a tool the record narrows out becomes deny when its
  family's `narrowed_out` is deny (M91.2a), when it would ask or when it sits
  in a `needs_default_mode` family (acceptEdits would approve it), and an
  allow it narrows out elsewhere is left to the CLI; then what a run that
  cannot ask does instead, which since M91.1 denies every tool of a family
  that `needs_gate`.
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
  internal cell only denies or refuses, but in a family that `loads_tools`,
  whose every cell is `cli` (M91.1); `unlisted` (a tool neither file
  names: another server's, since an unknown built-in stops its run at the
  init) is `cli` or `refuse`.
- **What reaches past the conversation is denied on every run (M91.1).**
  The task-list (TaskCreate, TaskGet, TaskList, TaskUpdate), background
  (TaskOutput, TaskStop), cross-session (SendMessage, ListAgents: measured
  reaching the person's other Claude Code sessions with no permission),
  schedule (CronCreate, CronDelete, CronList, ScheduleWakeup, RemoteTrigger),
  outside (Artifact, PushNotification, DesignSync, ReportFindings, Workflow,
  EnterWorktree, ExitWorktree, SendUserMessage, REPL, the MCP resource
  readers, LSP, Monitor) and skill (the person's own Claude Code skills,
  whose `allowed-tools` would add allow rules) families deny in every cell.
  EnterPlanMode joins the plan family's refusal.
- **A family that `needs_gate` is held only where a gate sits (M91.1).** On
  a run that cannot ask, its decision is deny, whatever the cell says, so the
  subagent tool never depends on a hook a run does not have. Optional,
  absent is false; it is the delegate family's alone today.
- **The subagent tool reads its own ceiling (M91.2a).** `delegate` (off, on)
  is the Settings Subagents switch: off denies it in argv, so the person's
  own allow rules cannot fill the silence, and on leaves it to the CLI on an
  attended run; every unattended and internal cell denies it, and
  `needs_gate` denies it wherever no gate sits whatever a cell says. A
  request that names no switch reads on where a person watches, the switch's
  default, and off everywhere else; a value but `on` reads off. Two states,
  like the web's: it never asks, so it never moves the mode. Read scope
  leaves it alone, since a subagent reads under its run's own grant.
- **A record must name the subagent tool to hold it (M91.2a).** A family's
  optional `narrowed_out` says what becomes of its tools when a record's
  narrowing names none of them, by name or alias: `deny`, whatever the cell
  says, or `default` (absent), the narrowing's own rule above. The delegate
  family's is deny, so a record written before subagents existed never
  gains them; one that names `Agent` or `Task` keeps the tool, and naming it
  never lifts the switch. Both loaders refuse `deny` on a family that
  `loads_tools`, which stays with every run. The rule is the family's, so the
  confirmable rows read it the same way; no code names the delegate family.
- **Agent types are pinned (M91.2a).** `agent_types.builtin` is Claude
  Code's own, the types a 2.1.250 init lists (claude, claude-code-guide,
  Explore, general-purpose, Plan, statusline-setup), and `allowed` is
  Cerebro's, the presets `subagents.v1.json` defines. A plan that holds a
  tool the delegate ceiling reads names both (`denied_agent_types`, which
  its argv denies as `Agent(<type>)` beside the person's own types since
  M91.2b, and `allowed_agent_types`, the only types its gate lets a
  subagent start as); every other plan names neither. Both loaders refuse,
  in the same words, a name outside letters, digits, colons, dots, dashes
  and underscores (it rides that rule whole), a name twice in its list, and
  an allowed type that is a built-in one. An init that offers a type argv
  neither allows nor denies stops the run (M91.2b).
- **A family that `loads_tools` stays with every run (M91.1).** ToolSearch
  loads the deferred MCP tools a run holds, Cerebro's own among them, and
  runs nothing itself, so every cell is `cli`, an internal one included, and
  every plan's `--tools` names it. It may not also `needs_gate`, which would
  deny it wherever no gate sits. Optional, absent is false.
- **A todo list is kept only where someone watches (M91.1).** The todo
  family (TodoWrite) pre-approves on an attended run and denies elsewhere.
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
- **The web is a ceiling of its own (M57.7).** WebFetch and WebSearch read
  `web` (off, on), never the shell's ceiling: off denies both in argv, so the
  person's own Claude Code allow rules cannot fill the silence, and on allows
  both, on an attended turn and on an unattended run alike; who reaches on
  is the renderer's (the switch, and for an agent's run its record's
  `tools: web`). Internal cells deny. Two states, since Ask is the shell's
  alone (D6), so the web never asks and never moves the mode. **Read scope
  leaves it alone, a judgment call:** a read limit bounds vault folders, not
  the outside world, so `read_scope` names no web row. A narrowing treats it
  like any tool that acceptEdits would not approve: a web tool the record
  leaves out rides neither list.
- **The Trash is closed to the CLI's own tools (M60.8b).** Cerebro's tools
  never see `.trash/`, but the CLI's Read, Glob and Grep need no approval
  inside the vault, so without a rule any run could read a deleted page.
  `hidden_paths` holds the rule as data: `folders` are vault-relative names,
  each one hidden component (both loaders refuse an empty, absolute, `..`,
  slashed or non-hidden name, one outside letters, digits, dots, dashes and
  underscores, since the rule rides a comma-joined flag, and a name twice, in
  the same words), and `tools` are manifest CLI rows whose path rule Claude
  Code applies (it applies a `Read` rule to its readers and an `Edit` rule
  to its editors). Every
  attended and unattended run's `--disallowedTools` carries
  `Tool(./folder/**)` for each pair after the table's own rows (a seated
  run's prompt tool follows them, M57.3), whatever its ceilings, read limit
  or narrowing, and a deny rule beats any allow, the person's own included. An
  internal run gets none: it is denied every CLI tool that opens a file
  already, holding only ToolSearch (M91.1). A shell-granted
  run can still reach the folder through Bash.
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

### Personal-token toolsets (M62.5, D17 (b), default taken)

The manifest's top-level `clients` block names one `default` toolset and its
`grantable` additions, with a nonempty `why`. Both loaders refuse a default
that is not declared or whose rows are not all read-only on non-writing
doors. Both refuse undeclared, duplicate, default or generated grantable ids,
and any grantable set with a row on axis none: every call must have a folder
scope that bounds it. A token always includes the default; tool names retain
served order. `toolset_writes` / `toolsetWrites` read each row's door rather
than maintaining a second list. Comment tools remain read-scoped and do not
claim a page-writing grant.

The token-case twin counts Unicode scalar characters in names and UTF-8
bytes in folders. It trims slug separators after the 32-character ASCII cut,
collapses repeated folder separators, rejects backslashes and controls, and
counts unique normalized folders toward its limit. These narrow choices keep
the grant shown in Settings the same grant the runtime checks. Plaintext
secrets never persist; token rows and the mock retain SHA-256 fingerprints.

## Mail storage and scoped admission (M69.7)

`mail.v1.json` and `mail.v1.sha256` are read by
`src-tauri/src/policy/mail.rs` and `src/engine/mailPolicy.ts`. The artifact
names the mail folder, the folders kept out of git and the gate's connector,
kinds, evidence pack and one vault-store scope. Its `path_cases`, `gate_cases`
and `refusals` replay in both readers. Folder names are plain ASCII paths and
matching ignores ASCII case at separators. Gitignore rows include derived
case-folding patterns so this remains true on case-sensitive filesystems.

The gate is closed by default. Only the owner acceptance procedure in the
named pack opens it, for the listed kinds in that one vault store. Tests
refuse an open gate without a dated, fired pack and R14 registration. Runtime
admission reads the artifact flag and scope, never the trigger registry or the
pack. Removing a file from git's index preserves it on disk and does not
remove it from older commits.

After a deliberate edit, bump the artifact version and run:

```sh
cd src-tauri
cargo test --lib policy::mail::tests::write_mail_digest -- --ignored \
  --skip crash --skip killed_ --skip kill_and_restart --skip a_kill_ \
  --skip kill_point --skip interrupted_overwrite
```

Replay `policy::mail::tests` and `src/engine/mailPolicy.test.ts`, then the git
checkpoint/run changeset checks whenever kept-out paths change. There is no
runtime digest check. Never format the hashed JSON.

Notion conversion (M69.5) is Rust-only, not a second vault semantic in TS.
`src-tauri/fixtures/notion-cases.json` contains synthetic documented envelopes
and expected carriers. Regenerate only with
`UPDATE_NOTION_CASES=1 cargo test --lib import::notion::tests::write_notion_cases -- --ignored`
and review the changed bytes; `src/editor/notionCases.test.ts` opens those
outputs through the real editor. The browser mock consumes these normalized
outcomes and does not implement conversion or automatic relinking. Live
connector recordings remain an owner check through the isolated recording kit.

The mail host twin uses Rust URL parsing and the pure `whatwg-url` parser in the
engine. Unicode/percent-encoded hosts, ignored code points, ports, userinfo and
separator spellings replay the same host cases; a hand-split hostname is not a
privacy boundary. No DOM global is used.

## Connector send denials (M69.10)

`tools.v1.json` ends with `never_call`: one explanation and source-attributed
names in strict ASCII order. Both loaders reject unknown fields, invalid names,
duplicates, disorder, empty explanations/sources and collisions with cerebro
rows. The published server/version source lives beside every name. These names
are not served tools and do not join the picker or tool-approval families.

`agent::build_args` adds each exact name on every loaded connector server,
using that server's CLI spelling, to the existing single `--disallowedTools`
flag. Record denials and unattended mail-reader denials remain there, deduped.
The approval plan and its goldens have no connector rows and do not change;
argv tests prove the added boundary. No connector means no added argument.
Internal runs hold no connectors. A foreign tool remains a transcript step
with a plug and server attribution, even if its bare name matches a vault
writer. No native mail sender is added.

M96 separately admits `prepare_action` as the sole app-owned external tool,
under the original retained native run, explicit account grants and each
consequential effect's held person approval. Its `open_world` annotation is
true; every other Cerebro row and all generated proposal tools remain closed.
This exact exception does not remove a connector mail denial or enable a
mail/publish tool. The four managed metadata readers remain `read_only`
steps and carry the shared running/completed fold phrases.

The checked versions and primary links are recorded in M69.10's plan and in
the artifact. Published catalogs changed since the initial plan: replies and
forwards send too, and Anthropic's current Workspace connector can send with
approval. Its undocumented tool spellings are not guessed. This inventory is
bounded to verified names; SECURITY.md describes other aliases and inherited
legacy configuration explicitly.

Mail header digests are projected in Rust only. Synthetic inputs and exact page
bytes live in `src-tauri/fixtures/thread-digests.json`; after a deliberate format
change regenerate with `cargo test --lib mail::digest::tests::write_thread_digest_cases
-- --ignored` and the full Mac skip list above, then review every changed byte.
The browser journey opens those same files through the real page renderer.

### Pull request read cases (M69.11)

`pr-urls.json` is the exact argv admission grammar shared by Rust and TS. The
host and scheme compare in ASCII case only; percent escapes, controls and the
union of Unicode White_Space and JavaScript whitespace refuse everywhere.
`pr-cases.json` is hand-shaped gh 2.x JSON with toy names: Rust normalizes the
process outcome, and TS judges readiness from that same normalized outcome.
Null checks mean not reported; an empty list means reported with no checks.
These fixtures have no writer or digest; edit them deliberately and replay
`forge::tests::replays_pr_urls`, `forge::tests::replays_pr_cases` and
`src/engine/pullRequest.test.ts`. Origin hints are TS-only, with primary-source
links beside each observed marker in `pullRequest.ts`; they are never an
attribution record or an assertion that an unmatched author is human.

The mail sweep block (artifact v4, M69.7e) supplies its limits and read/deny
names to the generated attended Agent record. Both loaders validate bounded
positive counts, unique tool-part names and disjoint lists. Refusal controls
live in the same artifact. Its two granted reader names and parameter forms
were checked against Google's [search_threads](https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/search_threads)
and [get_thread](https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/get_thread)
reference on 2026-10-15; no signed-in call was made. The deny list also retains
older planned spellings as compatibility subtractions. Missing readers refuse
rather than widening to another server or a shell.

`thread-digests.json` also contains requested-text projections. Regeneration
writes both `content` and `text_content` for those cases. Every received string
is made inert; fixtures are synthetic. Message-text permission is a separate
kind in the same default-closed gate.

## Reserved action foundation (M96.1)

`actions.v1.json` and its SHA-256 anchor hold the bounded schema subset, parser
limits, seven local effect classes and reserved future action tool/refusal names.
They do not register tools or operational ledger codes. Rust actions tests load
the artifact; the generated transport test checks the same bytes. There is no
TypeScript semantic interpreter and no new D3 twin. See `shared/actions/README.md`
for the ignored digest/schema writers, shared cases, replay and drift commands.
The admission section is the default-deny native account/action boundary: verified
single local owner, explicit grants, exact input restrictions, parent ceiling and
completion/Stop rules, plus traversal and catalog bounds. Rust reads this section;
`shared/actions/admission-cases.v1.json` pins the exact section, versioned scope
encoding and V35 DDL bytes. The browser continues to check the same policy anchor
without interpreting native authorization. The isolated Rust service remains
test-only and its production proof constructors, authenticated MCP/Ticket/native
hooks, account-grant producer and action routes remain gated. V34/V35 runtime
migrations preserve existing operational rows without legacy authority backfill.
Existing closed-world/mail/send guards remain unchanged.


## Local supervised-child freeze bounds (M95.6)

The Rust-only supervised-jobs.v1.json loader consumes the same compiled artifact
used by the internal native freeze; there is no TypeScript authorization twin.
Its input bounds cap each evidence file at 16 MiB and aggregate hashing at 64 MiB
per freeze attempt. The reader uses the existing contained descriptor door,
constant-memory chunks, deadline checks, whole-file hashes and identity rechecks.
These bounds do not admit a child process, broaden a parent scope, inherit attended
mail permission, or authorize result-body persistence. Unknown/missing limits fail
closed. The policy digest frozen in V40 also binds the actual preset, tool manifest,
mail, proposal and byte-reader policy bytes plus the actual composed subagent brief;
its row retains digests only. The contract also binds the exact actual parent mint
and retained native authority/revision, independently of effective child axes.

supervised-jobs.v1.sha256 pins the artifact. The loader's
m95_freeze_policy_compiled_bytes_match_digest_and_disk test checks compiled bytes,
the anchor and the disk artifact. After a deliberate change, regenerate using the
ignored write_supervised_jobs_digest Rust test and review the changed bytes; do not
hand-edit an anchor to mask a failing loader or source mismatch.


## Explicit raw connector ownership (M96.4a)

connector-ownership.v1.json is the one ownership admission table. Its owner field,
recognized owner spellings, absent-owner default, managed-only marker names,
fail-closed unknown/conflicting dispositions and safe reasons are data. The two
readers interpret them without copying an owner list into either language.
Format 1 supports a CLI legacy default and invalid unknown/conflicting markers;
unsupported or malformed policy is unavailable and can admit no raw entry.
Owner and marker lists are nonempty, unique, ASCII and sorted; reason text is
nonblank printable ASCII. Both readers replay the same entry and parser cases,
including alternate declared spellings, fields and malformed policy controls.

An exact managed owner is refused even without a complete reference, and any
present managed-only marker invalidates a legacy/CLI entry. Marker contents are
not read or resolved. This is operational refusal text, not a new ledger code.
An ownership marker proves no account, secret, grant or provider readiness.
CLI approvals and their existing fixtures are unchanged. No managed route,
public credential command, provider execution or inherited-global alias selector
is supplied here; absent-list legacy inheritance remains explicitly bounded by
the existing run/client-access rules.

Both suites hash the exact compiled/imported artifact against its shared digest;
the Rust replay also compares compiled bytes with disk. There is no runtime
hashing or store lookup. Regenerate deliberately with the ignored writer above
and the full Mac crash skip list, then replay policy::connector_ownership::tests,
src/engine/connectorOwnership.test.ts, the existing connector suites and the
repository twin/convention guards. Never format the hashed artifact.

## GitHub credential evidence beta (M96.2)

`github-import.v1.json` is the native-only classic-scope evidence policy. Its sorted supported names, digest namespace and explicit beta limitation are read by `connections/github_identity.rs`; unknown/missing/empty evidence is Unsupported and no scope evidence grants a local action capability. There is no TypeScript authority interpreter or D3 twin. `github-import.v1.sha256` anchors the exact bytes. After a deliberate edit, run the ignored `connections::github_identity::tests::write_github_import_digest` with the full Mac skip list, then replay `connections::github_identity::tests`; the loader test also compares compiled bytes with disk. Never reformat an existing artifact or silently update an anchor to mask drift.

`backup-workflow.v1.json` holds M99 native pending lease/one-slot/terminal bounds
and the two fixed Restore child names. Rust `workspace_service/backup_policy.rs`
loads these exact bytes; the later native workflow/frontend adapter must consume
the same artifact rather than duplicate limits or child-name policy. Its explicit
ignored `write_backup_workflow_digest` test regenerates the digest after review;
the non-writing test checks compiled/disk/digest identity. This artifact alone does
not enable Backups or install native command authority.
