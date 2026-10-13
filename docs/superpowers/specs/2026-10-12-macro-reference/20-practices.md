# Macro reference — Engineering system: hexagonal crates, style rules, ast-grep, CI, tests, observability, agent skills

**Scope**: how Macro builds software, read 2026-10-12 from `docs/examples/macro-main/` (vendored and gitignored). Every
Macro path below is relative to that root. Cerebro paths are relative to the repo root.
**Owner's rule (2026-10-12)**: Cerebro builds its own version, with Macro's code as the guide and never a 1:1 copy.
Modes are rebuild (fidelity mirror / adapt / inspire), adopt-upstream, reuse-permissive and skip. Stage 3 added one
more for PRACTICES-1: **re-land-own-work** (Cerebro's own stranded commits).
**Licence**: root `LICENSE.txt` is AGPL-3.0 and covers `crates/`, `services/`, `rules/`, `.github/`, the skills and
`docs/`. `apps/web/LICENSE` reads "All rights reserved" and covers `apps/web/tests`, `apps/web/docs` and
`apps/web/AGENTS.md`. `services/cla-worker/CLA.md` is CoParse legal text. So: **clean-room only**. No rule YAML,
fixture, sanitizer or skill text enters the repo. Tools are adopted only when permissive (cargo-deny, zizmor, actionlint).
**Evidence**: stage 1 read Macro, stage 2 read Cerebro, and stage 3 probed both (a scratch cherry-pick, cargo-deny,
full-crate clippy, a no-DOM tsc run, gh api). Stage 3 overrides stages 1–2. e2e, a CLI recording and a packaged-app
launch were **not** run.

---

## 1. What it is

- **Policy as tooling.** `docs/STYLE_GUIDE.md` has 89 rules with stable IDs (CS-01..55 Rust, FE-01..34 frontend). Each
  rule names its enforcer: 27 ast-grep rules, clippy `disallowed-methods`, cargo-deny wrapper bans and oxlint.
- **Hexagonal backend**: 83 of 243 crates have `src/domain`. Cargo features gate the layers, and `services/*/server.rs`
  are the composition roots. CI is 44 workflows generated from Rust, with a `--check` drift gate.
- **Ops for agents**: one tracing init, a local LGTM stack the agents query through the Grafana MCP, a skill library,
  and an 11k-line field-verified browser guide.

## 2. What users get (developers and agents)

| Feature | UX details and shortcuts | Paths |
| --- | --- | --- |
| `just check` | Checks only the files that differ from merge-base(origin/main), plus uncommitted and untracked ones. Lanes: `cargo fmt --check`, `biome ci --error-on-warnings`, oxlint (warn-only), `ast-grep scan`. Each failing lane prints a `fix:` command, and the output ends FAIL or OK. `just check full` adds tsc and clippy. `CHECK_BASE` overrides the base for shallow clones. | `tooling/just/check.just` |
| Stable-ID style guide | One line per rule: `<id> [scope] rule (evidence · enforcement · docs)`. IDs are never renumbered or reused. Reviews cite IDs ("see CS-30"). Headline rules: CS-14/15 (typed env, fail fast), CS-22 (`#[instrument(err)]`, structured fields), CS-24 (~1000-line files), CS-25 (mod.rs holds declarations only), CS-39 (SHA-pin actions), CS-41 (`#[expect(reason)]`), CS-49 (sibling test.rs), CS-51..53 (hexagonal), FE-09/10 (derive, don't sync), FE-25 (semantic colours), FE-31 (parse entity types, never cast). | `docs/STYLE_GUIDE.md` |
| ast-grep rules | 27 YAML rules, 11 error and 16 warning. `error` means zero existing violations and CI-blocking. `warning` means a legacy burn-down that surfaces only through the review bot; its note carries a hand-kept count ("~200 legacy uses"). TS and TSX twins exist because ast-grep rules are single-language. | `rules/ast-grep`, `sgconfig.yml` |
| Review bot on the same rules | CodeRabbit reads the same ast-grep dirs, in the chill profile (never blocks). Path rules: *.rs reports only semantic bugs; *.sql must not drop a column in the PR that removes its use; workflows must be SHA-pinned. gitleaks, trufflehog and osv are on. | `.coderabbit.yaml` |
| Generated CI | Every YAML starts `# DO NOT EDIT — regenerate with cargo x workflows` and names its Rust source. `path_validation.rs` checks every `paths:` glob. Actions are SHA-pinned, and concurrency cancels per ref. | `tooling/xtask/crates/xtask_workflows/src/workflows.rs`, `.github/workflows/check_generated.yml` |
| Affected-package Rust CI | paths-filter, then a merge-base diff deepened 0/200/2000 for stacked PRs, then guppy/determinator picks the changed packages plus their reverse deps, then clippy `-Dclippy::disallowed_methods` and `nextest -p` on pg14 with a pre-migrated template1, then an aggregated status job. | `.github/workflows/code_check_cloud_storage.yml`, `tooling/xtask/crates/xtask_nextest_filter/src/main.rs` |
| Dependency policy | A 14-SPDX allowlist with no strong copyleft. 18 advisory ignores, each with a reason. Wrapper bans: `tracing-subscriber` only through `macro_entrypoint` plus listed crates. Manifest-gated job. | `deny.toml`, `.github/workflows/cargo_deny.yml` |
| Typed env and config | `env_var!` gives one newtype per variable. `#[derive(MacroConfig)]` loads a service config, and a missing variable fails startup by name. Tests swap a thread-local env getter (`with_mock_env`). clippy bans `std::env::var`. | `crates/macro_env_var/src/lib.rs`, `crates/macro_config/src/lib.rs`, `clippy.toml` |
| One tracing init | `MacroEntrypoint::default().init()`: an INFO floor (an empty RUST_LOG logs nothing), a span filter independent of RUST_LOG, a panic hook, credential targets muted, opt-in OTLP and a flush on shutdown. | `crates/macro_entrypoint/src/lib.rs` |
| HTTP span layer | Adopts the W3C traceparent and opens an `http.request` span with route, status, latency_ms and request.id; headers are excluded. Slow requests WARN, failures log once, plus a tokio starvation detector. | `crates/macro_tower_layers/src/lib.rs` |
| Local LGTM + agent browser | Compose profile `lgtm` (grafana/otel-lgtm 0.32.0, Tempo MCP on). Profile `chrome` runs headless Chromium on CDP 9222 with noVNC 6080 for watching. `.mcp.json` wires chrome-devtools-mcp with `--browser-url` and the Grafana MCP. The agent reads the traceparent from the network panel, then calls `tempo_get-trace`. | `docker/docker-compose.yml:742-771`, `.mcp.json`, `docs/AGENT_GUIDE/observability.md` |
| Skill library | `.agents/skills` (11), `.claude/skills` (14, 2 symlinked) and `.pi`. YAML frontmatter. Copies **drifted** between harnesses (a 'claude'→'Codex' rename artifact; debug-service lacks frontmatter). | `.agents/skills`, `.claude/skills` |
| Browser-agent guide | 14 files, 11,115 lines, verified live. Technique: snapshot first; save huge snapshots and grep them; contenteditable means click then type; detect AI completion by the Stop button disappearing. CLAUDE.md requires the guide to change in the same PR as the surface. | `docs/AGENT_GUIDE/browser-technique.md`, `CLAUDE.md` |
| Test layers | Sibling test.rs; `#[sqlx::test]`; seeded local e2e (Rust `#[ignore]` plus Playwright on one fixture set); functional Playwright with controllable server outcomes; Linux-only native Tauri E2E with an independent oracle; insta goldens over sanitized **ACP** recordings; an import-boundary vitest test. | `docs/RUST_DEVELOPMENT.md`, `apps/web/tests`, `crates/folds/agent_fold/src/domain/test/real_recordings.rs`, `packages/email-renderer/tests/boundaries.test.ts` |
| CLA | A required `cla` status. Bots and org members pass; others sign once through a zero-scope GitHub OAuth Worker (append-only D1) and comment `/macro-cla check`. | `.github/workflows/cla.yml`, `services/cla-worker/README.md` |

## 3. How it's built

**Architecture.** Each domain crate holds `src/domain` (models; port traits with RPITIT async fns and an associated
`Err`; a service generic over the ports), `src/inbound` (axum, AI tools, listeners) and `src/outbound` (pg repos, S3,
HTTP). The features `ports`/`inbound`/`outbound`/`postgres` gate the layers (`crates/collab_surface/Cargo.toml`), and
other crates depend on a domain only through `features=["ports"]`. Composition roots alone construct adapters
(`services/document_storage_service/src/server.rs`, 2,225 lines). Authorization crosses the boundary as a typed
`EntityAccessReceipt<T>`. Enforcement: 8 Rust ast-grep rules (crate-local only), clippy, cargo-deny. The cross-crate
"never import another crate's outbound" rule is prose only, with 37 live violations
(e.g. `crates/soup/src/outbound/pg_soup_repo.rs:284`).

| Unit | Path | Role | LOC |
| --- | --- | --- | --- |
| Style guide | `docs/STYLE_GUIDE.md` | 89 rules with stable IDs and enforcer pointers | 318 |
| ast-grep rules | `rules/ast-grep` | 27 structural rules mapped to IDs | 1,292 |
| clippy / deny config | `clippy.toml`, `deny.toml` | Disallowed methods; licences, advisories, wrapper bans | — |
| `.github` | `.github` | 44 generated workflows, composite actions, CODEOWNERS | 22,029 |
| xtask | `tooling/xtask/crates` | Workflow generator, nextest filter, dep closures, local orchestrator | 23,757 |
| justfile | `justfile`, `tooling/just/*.just` | `check`, `run_local`, clippy, seeds | 177 (+720) |
| macro_env_var | `crates/macro_env_var` | Newtype-per-var macros, mock env harness | 1,103 |
| macro_config (+derive) | `crates/macro_config`, `crates/macro_config_derive` | Typed config loader | 1,360 + 451 |
| macro_entrypoint | `crates/macro_entrypoint` | Single tracing/OTel init, panic hook, shutdown | 1,051 |
| macro_tower_layers | `crates/macro_tower_layers` | Request id, traceparent, span shape, starvation detector | 664 |
| observability (TS) | `packages/observability` | Browser OTel facade, privacy context | 1,028 |
| ensure_exists / non_empty | `crates/ensure_exists`, `crates/non_empty` | `DoesExist<T>` proof token; `NonEmpty<T>` | 164 / 367 |
| local e2e | `crates/integration_tests/local_e2e`, `crates/local_e2e_test_support` | `#[ignore]` tests on the seeded stack; refuses non-local URLs | 2,987 / 838 |
| web tests | `apps/web/tests` | Local e2e, functional mutations, native Tauri harness | 9,001 |
| agent_fold goldens | `crates/folds/agent_fold` | insta sweep over sanitized ACP frames | 388 |
| Reference hexagon | `crates/collab_surface` | Canonical domain/inbound/outbound layout | 4,145 |
| Skills | `.agents/skills`, `.claude/skills` | Harness skill libraries | 957 / 1,487 |
| Agent guide | `docs/AGENT_GUIDE` | Browser manual plus trace correlation | 11,115 |
| docker | `docker` | Compose profiles lgtm, chrome, jaeger | 1,993 |
| cla-worker | `services/cla-worker` | CLA page, OAuth, check API | 854 |

**Data model.**
- `.sqlx/` holds 2,499 offline query files, generated and never hand-edited.
- Seed fixtures (`tooling/seed_cli/seed`) are shared by seed_cli, Playwright and local_e2e_test_support. Rows carry the
  `5eed` id marker.
- CI inventory is committed JSON: `.github/services-config.json` and `.github/workspace-dep-closures.json` (generated).
- Goldens are insta `.snap` files beside the tests, named test name plus fixture stem.
- Native E2E writes a bundle per run under `apps/web/test-results/native/<ts>/`: requests.json, checkpoints.json,
  webview.png/html and logs.
- Telemetry lives in the `lgtm_data` volume locally and in Datadog in prod.

**Flows.**
1. *Change → merge*: edit → `just check` (diff-scoped, fix hints) → PR with a Conventional Commit title → Rust CI
   (path-check → affected packages → fmt/clippy/SQLX_OFFLINE → nextest on pg14 → aggregate status), with conventions
   (ast-grep), cargo-deny (manifest-gated), `workflows --check` and web CI in parallel → CodeRabbit on the same rules →
   the `cla` status.
2. *UI action → trace → diagnosis*: the browser span sends `traceparent` → `MakeSpanWithRemoteParent` adopts it into
   `http.request` → the OTLP export lands in otel-lgtm → the agent calls `get_network_request`, then `tempo_get-trace`,
   then Loki filtered on that trace_id.
3. *Service boot*: `MacroEntrypoint::init` → `ConfigLoader::load` (a missing field fails) → secrets resolve → `server.rs`
   builds adapters and injects them into services → routers mount with the tracing layer → shutdown flushes.
4. *Agent change*: CLAUDE.md, then the task guide → load the skill (the hexagonal skill's final answer must state the
   boundary was checked) → `cargo test -p` → `just check` plus the qc skill (5 reviewer subagents) → browser verification
   by AGENT_GUIDE → PR ready with CI green.

## 4. Ideas worth stealing (ranked)

1. **Every rule names its enforcer** (`docs/STYLE_GUIDE.md`). It makes the prose-only rules visible. Cerebro can go
   further and *test* that each pointer resolves; Macro never checks its own pointers.
2. **`#[expect(lint, reason)]` plus clippy `disallowed-methods`** (`clippy.toml`, CS-41). An expectation that stops
   firing warns, which mechanises "suppressions carry reasons" and "kill the retired workaround's comment" together.
3. **Rules ship as errors at zero violations** (the `error` tier in `rules/ast-grep`). Cerebro keeps that half and
   drops the warning tier, which conflicts with its zero-warning policy.
4. **Import-boundary test plus a no-DOM core tsconfig** (`packages/email-renderer/tests/boundaries.test.ts`,
   `packages/email-renderer/tsconfig.core.json`). About 76 lines, and it locks "engine/ is the pure core".
5. **Controllable server outcomes in functional tests** (`apps/web/tests/functional/optimistic-mutations.spec.ts`):
   commit, reject and disconnect per mutation. In Cerebro it guards "unavailable is never empty".
6. **Independent oracle with a registry guard** (`apps/web/tests/native/fixtures/filter-oracle.ts`,
   `apps/web/tests/native/filter-matrix.ts`): assert exact IDs, and fail when an option goes unclassified.
7. **Sweep a corpus of real recordings, no registration step** (`crates/folds/agent_fold/src/domain/test/real_recordings.rs`).
   Macro sweeps ACP frames; Cerebro would be first to do it for Claude Code stream-json.
8. **SHA-pinned actions** (CS-39, `.github/workflows/*.yml`), with tags only in comments.
9. **One tracing init with an INFO floor and an independent span filter** (`crates/macro_entrypoint/src/lib.rs`).
10. **A dedicated agent browser** (`docker/docker-compose.yml:742-771`, `.mcp.json` `--browser-url`): the agent never
    fights the user's own Chrome.
11. **Harnesses fail on any unexpected or non-local request** (`apps/web/tests/native/README.md`,
    `apps/web/tests/calendar-team/README.md`).
12. **Skills by symlink, never by copy**: Macro's copies drifted (`.agents/skills/upgrade-model` vs
    `.claude/skills/upgrade-model`).

**Avoid**: the committed dev CA private key (`infra/local/certs/ca-key.pem`, no Name Constraints, valid to 2036, trusted
system-wide by README).

## 5. Cerebro today vs Macro

| Macro feature | Cerebro status | value | note |
| --- | --- | --- | --- |
| Stable-ID rules with enforcer pointers | partial | medium | ~18 prose conventions, no IDs, ~12 unenforced. 5 live breaches: private e2e boots, `agent/context.ts:205`, `git/useGit.ts` collapses, ChatInput's 3 reasonless disables, InlineDiff/ChangesPage/PulsePage collapses |
| ast-grep | partial (capability) | medium | ESLint has 0 boundary rules; Rust has 16 copy-pasted `include_str!(self)` tripwires. Take the rules, skip the tool |
| clippy disallowed-methods + `#[expect]` | absent | high | No clippy.toml or `[lints]`. Measured: 19 `#[allow]` (2 stale), 0 `#[expect]`, 11 spawn/env-mutation sites |
| SHA pins, PR gating, read-only token | partial | high | Built in M32.1–.5 and stranded off main. Rulesets and CodeQL are live in settings. CodeQL alerts #1/#2 (missing permissions, `mac-app.yml:32,87`) are open |
| cargo-deny licences/advisories/sources | partial | high | M32.6 stranded; measured green apart from the missing `license` line. 13 Dependabot alerts open |
| cargo-deny wrapper bans | different-by-design | low | Single crate |
| Pinned toolchain read by CI | absent | medium | Local rustc 1.95 (Homebrew, no rustup) vs CI 1.99. Node 26 vs 22; pnpm 9.15 vs 10. MSRV floor 1.89 (`File::try_lock`) |
| Change-scoped gate | partial | low | No legacy to hide. Real gap: the pre-push Rust lane misses `shared/`, `conformance/` and `demo-vault/` |
| Single tracing init, persisted logs | absent | medium | 34 `eprintln!` in 9 files, 2 `println!`, no panic hook, no file sink. Finder-launched apps get stderr on /dev/null (measured on other apps) |
| Browser error capture | absent | medium | No root error hooks, no ErrorBoundary, no window listeners |
| Explicit agent-turn outcome | already-better | low | `runs.outcome` plus the orphan sweep (`AbandonedUsageUnknown`) |
| OTLP/LGTM, browser OTel, span layer, memory recording | absent | low | Out of proportion; conflicts with SECURITY.md and the justify-every-crate rule |
| Real-recording goldens | partial | high | 5 hand-shaped fixtures; `translate()` drops unknown kinds (`agent/mod.rs:1037,1129`) |
| Import-boundary test + no-DOM core | absent | high | Measured no-DOM tsc: 5 errors (runLog ×3, sha256 and mockParse TextEncoder). mockParse used by 5 production modules |
| Oracle matrix + registry guard | partial | medium | `FILTER_OPS` uses `satisfies`; 49 example tests; 132 admissible op×kind cells, no oracle |
| Controllable outcomes (fault injection) | absent | high | No `failNext` seam. Collapses at `useGit.ts:208-210,237-239`, `InlineDiff.tsx:42-44`, `ChangesPage.tsx:64-66`, `PulsePage.tsx:33` |
| One fixture set shared by Rust + browser | partial | high | Parser parity rests on 3 hand-synced strings (`entry.rs:336-346` vs `mockParse.test.ts:4-31`). Guard parity is hand-mirrored in `mockIpc.test.ts:90-540` |
| Harness fails on non-local requests / CSP parity | absent | medium | The `tauri.conf.json` CSP never applies in dev or e2e. Likely: `mermaid/export.ts:187` font fetch passes e2e and fails in the app |
| Native Tauri E2E | absent | low | tauri-driver is Linux-only; a contract test plus scan golden catches the same drift |
| Generated-artifact `--check` | already-better | low | sha256 anchors, `#[ignore]` writers, conformance regen, goldens in both suites |
| Raw palette ban (FE-25) | already-better | low | `theme.test.ts` fails unmapped utilities |
| Proof tokens / NonEmpty | already-better | low | M49.1's `with_writer` closures make the precondition structural |
| Skill library | absent | medium | `.claude/` gitignored; procedures in private memory |
| Dedicated agent browser | absent | medium | User's global chrome-devtools MCP runs `@latest` without `--isolated`; the "blocked by own Chrome" trap persists |
| Security-alert triage | absent | medium | 13 Dependabot plus 3 CodeQL alerts; one HIGH (`src/engine/ingest.ts:159` tag-strip regex). Rust (5.2 MB) is not scanned |
| Review bot on shared rules | partial | low | Cursor Bugbot, no rules file; it reads only `.cursor/BUGBOT.md` and the diff |
| Typed env, hexagonal crates, generated workflows, affected CI, CLA, CODEOWNERS | different-by-design | low | One crate, one workflow, a solo Apache-2.0 repo; 22 env reads, 15 in the crash harness |

## 6. Port candidates

| id | title | mode | fidelity | effort | value | Macro guide (read first) | Cerebro target | depends |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PRACTICES-1 | Re-land stranded M32 Track A (CI hardening) on main | re-land-own-work | — | S | high | `.github/workflows/cargo_deny.yml`, `deny.toml` | `.github/workflows/mac-app.yml`, `scanners.yml`, `cargo-deny.yml`, `.github/dependabot.yml`, `.github/SETUP.md`, `deny.toml`, `src-tauri/Cargo.toml`, `playwright.config.ts`, `AGENTS.md`, `.gitignore` | — (next to M53.2 Track B) |
| PRACTICES-15 | Pinned toolchain read by CI; pre-push Rust lane widened | rebuild | adapt | S | medium | `rust-toolchain.toml`, `.github/actions/setup-rust/action.yml` | `rust-toolchain.toml`, `src-tauri/Cargo.toml`, `package.json`, `.github/workflows/mac-app.yml`, `.husky/pre-push` | 1 |
| PRACTICES-18 | One e2e boot, enforced by lint | rebuild | inspire | S | high | `crates/local_e2e_test_support/README.md`, `docs/STYLE_GUIDE.md` | `e2e/boot.ts`, `e2e/{diagrams,smoke,whiteboard,workspace,pipeline}.spec.ts`, `eslint.config.js`, `AGENTS.md` | — |
| PRACTICES-2 | Convention IDs (CV-NN) with resolvable enforcer pointers + ratchet guard | rebuild | adapt | S | medium | `docs/STYLE_GUIDE.md`, `.coderabbit.yaml` | `AGENTS.md`, `scripts/conventions.test.ts`, `scripts/ratchet-guard.ts`, `.husky/pre-push`, `.github/workflows/mac-app.yml`, optional generated `.cursor/BUGBOT.md` | — |
| PRACTICES-4 | `#[expect(reason)]` both languages; clippy bans raw spawn and env mutation | rebuild | adapt | S | high | `clippy.toml`, `docs/STYLE_GUIDE.md` (CS-41) | `src-tauri/Cargo.toml`, `src-tauri/clippy.toml`, `src-tauri/src/{git/command.rs,git/provider.rs,vault/testutil.rs,agent/mod.rs,ledger/schema/coverage.rs}`, `src/test/suppressions.test.ts`, `src/agent/ChatInput.tsx` | 2; M53.10 spawn helper |
| PRACTICES-16 | Scan golden: demo-vault holds mockParse and engine/wikilink to parse.rs | rebuild | inspire | M | high | `crates/local_e2e_test_support/README.md` (shared fixtures only); real template is Cerebro's `conformance/` | `src-tauri/src/vault/parse.rs`, `src-tauri/src/vault/entry.rs`, `conformance/scan.json`, `src/lib/mockParse.ts`, `src/engine/wikilink.ts` | — |
| PRACTICES-3 | Lint rails: engine purity, adapter-only Tauri, mermaid/mockParse quarantine, no-DOM engine | rebuild | adapt | M | high | `rules/ast-grep/ts-feature-core-pure.yml`, `packages/email-renderer/tests/boundaries.test.ts`, `packages/email-renderer/tsconfig.core.json` | `eslint.config.js`, `tsconfig.engine.json`, `src/engine/{runLog,skills}.ts`, `src/stores/vaultStore.ts`, `src/workspace/RootMountDialog.tsx`, `src/lib/mockParse.ts`, `src/test/setup.ts` | 2, 16 |
| PRACTICES-19 | Fault-injection sweep: unavailable never empty, human actions never throw | rebuild | adapt | M (19a S + 19b M) | high | `apps/web/tests/functional/optimistic-mutations.spec.ts`, `apps/web/tests/native/filter-matrix.ts` | `src/lib/mockIpc.ts`, `src/test/failureInvariants.test.tsx`, `src/git/useGit.ts`, `src/git/InlineDiff.tsx`, `ChangesPage.tsx`, `e2e/boot.ts` | COMMS-9 |
| PRACTICES-7 | Tracked dev skills + `.mcp.json` agent browser + security-alerts triage | rebuild | adapt | S | medium | `.agents/skills/dependabot/SKILL.md`, `.claude/skills/live-debug/SKILL.md`, `.mcp.json`, `docs/AGENT_GUIDE/browser-technique.md` | `.gitignore`, `.claude/skills/{verify-ui,policy-artifact-edit,land-stacked-pr,security-alerts-triage,coverage-ratchet}/SKILL.md`, `.mcp.json`, `AGENTS.md` | 2 |
| PRACTICES-6 | One local diagnostics init: capped JSONL, panic hook, webview errors, MCP call lines | rebuild | inspire | S | medium | `crates/macro_entrypoint/src/lib.rs`, `crates/macro_tower_layers/src/lib.rs` | `src-tauri/src/diagnostics.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/app_config.rs`, `src/main.tsx`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src-tauri/src/ingest/ambient.rs` | 4; CLIENT-DESKTOP-5 |
| PRACTICES-9 | IPC contract test: names, mocks, events, arg keys, uncalled adapters | rebuild | inspire | S | medium | `apps/web/tests/native/README.md`, `.github/workflows/check_generated.yml` | `src/lib/ipcContract.test.ts`, `src-tauri/src/lib.rs`, `src/lib/{ipc,gitIpc,rootsIpc}.ts`, `src/agent/agentIpc.ts`, `src/lib/mockIpc.ts` | — |
| PRACTICES-20 | CSP-parity lane + non-local request guard in boot() | rebuild | inspire | S–M | medium | `apps/web/tests/native/README.md`, `apps/web/tests/calendar-team/README.md` | `src-tauri/tauri.conf.json`, `e2e/boot.ts`, `playwright.config.ts`, `src/mermaid/export.ts`, `e2e/diagrams.spec.ts` | 18 |
| PRACTICES-5 | Real, sanitized Claude CLI recordings with a no-silent-drop sweep | rebuild | adapt | M | high | `crates/folds/agent_fold/src/domain/test/real_recordings.rs`, `crates/folds/agent_fold/scripts/sanitize_recording.py` | `src-tauri/fixtures/cli-stream/real/`, `src-tauri/src/agent/{mod,recordings}.rs`, `scripts/sanitize-cli-stream.ts`, `.gitattributes` | AGENTS-1; debug tee |
| PRACTICES-8 | Independent-oracle matrix for view filters | rebuild | adapt | M | medium | `apps/web/tests/native/fixtures/filter-oracle.ts`, `apps/web/tests/native/filter-matrix.ts` | `src/engine/viewFilters.oracle.test.ts`, `src/engine/viewFilters.ts`, `src/engine/types.ts` | — |
| PRACTICES-10 | Parallel ts/rust jobs under one aggregate `quality` | rebuild | adapt | S | low | `.github/workflows/code_check_cloud_storage.yml:644-662` | `.github/workflows/mac-app.yml` | 1, 15 |
| PRACTICES-21 | CodeQL covers Rust (settings or advanced `codeql.yml`) | adopt-upstream | — | S | low–medium | — (Macro has no equivalent) | GitHub code-scanning settings, `.github/workflows/codeql.yml` | 1 |
| PRACTICES-11 | Skip `pnpm check`; the hook fix moved to 15 | skip | — | S | low | `tooling/just/check.just` | — | — |
| PRACTICES-12 | Skip ast-grep, crate split, hakari, guppy CI, generated workflows | skip | — | XL | low | `sgconfig.yml`, `crates/collab_surface/Cargo.toml`, `tooling/xtask/crates/xtask_workflows/src/workflows.rs` | — | — |
| PRACTICES-13 | Skip OTLP/LGTM, browser OTel, span layer, memory recording | skip | — | L | low | `docker/docker-compose.yml`, `packages/observability/src/telemetry.ts` | — | — |
| PRACTICES-14 | Skip CLA, CodeRabbit, CODEOWNERS, qc skill, typed env crate, native tauri-driver | skip | — | M | low | `services/cla-worker/README.md`, `.coderabbit.yaml`, `crates/macro_env_var/src/lib.rs` | — | — |
| PRACTICES-17 | Skip deterministic port per checkout | skip | — | S | low | `docs/RUNNING_LOCALLY.md` | — | — |

Sequence: 1 → 15 → 18 → 2 → 4 → 16 → 3 → 19 → 7 → 6 → 9 → 20 → 5 → 8 → 10 → 21. Roadmap: 1, 15, 2, 3, 4, 16, 7, 6 sit in
M53 (M53.22 still sizes 16 as S; it is M). 18 fits M53, and 19 lands with COMMS-9 (M53.15). 9 is M54.3, 5 is M56.2 and
8 is M62.1.

Per-candidate notes beyond the table:
- **15**: the regex is `^(src-tauri|shared|conformance|demo-vault)/` (`demo.rs:243` reads demo-vault). Set
  `rust-version` only after a CI build on that version (deps top out at 1.88; try_lock needs 1.89). Homebrew cargo
  ignores `rust-toolchain.toml`, so the hook warns on a mismatch rather than switching. Which Node to pin is an owner call.
- **18**: `boot(page, { autoLearn })` covers pipeline. Lint `page.goto(` and the `cerebro.autoLearn`/`cerebro.themeMode`
  literals in specs (boot.ts exempt). Keep `page.reload` and pre-boot `addInitScript` seeding legal.
- **2**: before "No type special-casing" (AGENTS.md:132) gets a CV ID, name the sanctioned system types (Type,
  Collection, Skill, Agent). The ratchet guard runs `git fetch origin main` in CI. AGENTS.md stays terse: one token per
  rule, no evidence prose.
- **16**: Rust writes canonical Entry JSON over demo-vault's 137 notes (timestamps excluded, `UPDATE_CONFORMANCE=1`).
  vitest replays it through mockParse and wikilink. Retire `entry.rs:336-346`. Phase 2: Rust-emitted refusal goldens
  for the mock-reachable write guards (`mockIpc.test.ts:90-540`). Never merge the scanners (`engine/wikilink.ts:3-9`).
- **19**: `failNext(cmd)`/`deferNext(cmd)` plus a window seam. Classify all 106 adapter exports as: user-visible read,
  human-UI action, proposal channel (asserted as a typed rejection, never a toast) or not-visible-with-reason. Must
  render unavailable: `get_file_history`, `get_vault_pulse`, InlineDiff and ChangesPage; the last two are in neither
  COMMS-9 nor M53.15. Share one seam with the M64.1 state lab.
- **7**: `.gitignore` becomes `.claude/*` plus `!.claude/skills/`. A test checks the AGENTS.md "dev skills" list against
  the directory. The `.mcp.json` pins chrome-devtools-mcp@1.10.1 (Apache-2.0) with `--isolated`, or `--browser-url` to
  a Playwright chromium. Consider `.agents/skills` with a `.claude/skills` symlink. Do **not** cite Macro's run-app.
- **6**: `app_dir()` needs an AppHandle (`app_config.rs:20`), so buffer lines before setup or resolve the path before
  the Builder, or early panics are lost. Write one line per MCP call: tool, run_id, latency_ms, outcome, and WARN over
  a threshold. Consider `app_log_dir`. Amend AGENTS.md:120 to name the log a non-record. After the migration, deny
  `print_stderr`/`print_stdout`; the 2 digest writers get `#[expect]`.
- **9**: names from a `macro_rules` wrapper or a scan. Param names **must** come from scanning the 3 command files
  (lib.rs 71, git_commands.rs 27, roots_commands.rs 5), since there is no syn. Allowlist the orphan commands
  `ambient_ingest_enabled` and `set_ambient_ingest` with reasons. Fail on adapter exports with no caller:
  `stopAllAgents` (`agentIpc.ts:231`) has none, so `stop_all` never runs. M53.10 owns that fix.
- **20**: serve a `vite preview` build with the `tauri.conf.json` CSP header for a tagged subset. boot() fails on any
  non-local request.
- **5**: Macro records ACP frames, and its Claude Code fold uses synthetic fixtures. Only the sweep and the sanitizer
  pattern transfer. Record CLI 2.1.250 in a scratch vault with an isolated `CLAUDE_CONFIG_DIR` (it may need its own
  login; never an API key). Sanitizer: an allowlist rewrite of `system/init` that fails on unknown keys, then regex, then
  a post-scan. Every (type, subtype) pair is translated or on `IGNORED_KINDS` with a reason, and each fixture needs a
  `.meta.json`. Add `*.jsonl text eol=lf`. The repo is **public**; secret scanning only backstops the sanitizer.
- **8**: 132 admissible cells (`viewFilters.ts:81,91-110` × `properties.ts:199-385`), about 0.7–1.3k cases. Derive
  truth from the admissibility rules, never from the evaluator. "Feeds Rust goldens" is future work: no Rust
  `FilterGroup` exists yet (M62).
- **10**: the aggregate runs `if: always()` and requires `success` from both jobs. A job skipped after a failed
  dependency reports success, and Macro's own version passes `cancelled`. Never rename `quality` or `e2e`.
- **14**: the crash harness accounts for 15 env reads (14 `CEREBRO_CRASH_VAULT` plus `CEREBRO_CRASH_POINT`), not 14.

**Top three.**

**PRACTICES-1: re-land M32 Track A.**
- What: cherry-pick `478afd3 8525dce 4b997a9 0170607 6df51b1 312a7b6 dab2fff 2f229bb`.
  - 7 apply cleanly onto origin/main 263e7de and HEAD fb6822a. `2f229bb` conflicts only in `.gitignore` and `AGENTS.md`;
    `playwright.config.ts` merges.
  - All 10 SHA pins resolve; refresh the stale dtolnay `# v1` comment via Dependabot.
  - cargo-deny is green apart from `cerebro is unlicensed`, which dab2fff's `license = "Apache-2.0"` fixes.
- Acceptance: every `uses:` is a 40-hex SHA with permissions read by default. CodeQL alerts #1/#2 close. `quality` and
  `e2e` keep their names. Retire the AGENTS.md "check the e2e port is FREE" paragraph (M32.7 makes reuse opt-in).
- **Owner call**: M32.1 limits triggers to `pull_request` plus `push: main`, and branch pushes without a PR lose their
  gates and the DMG. Land beside Track B (`490b38a..777615c`, M53.2), which holds the M32.12 flake record. Fix MEMORY:
  #15 merged into m31, not main.

**PRACTICES-4: suppressions and spawn hygiene.**
- Measured by full-crate clippy: exactly 49 diagnostics across 3 lints, matching the inventory.
  - `allow_attributes` and `allow_attributes_without_reason` fire at the 19 `#[allow]` sites.
  - `disallowed_methods` fires 11 times: `agent/mod.rs:386,407,531,877,1325,1352`, `git/command.rs:80,187,190`,
    `git/provider.rs:34` and `vault/testutil.rs:45`.
- Delete the stale allows at `reduce.rs:967` and `commit.rs:923`. `knowledge.rs:476` uses `cfg_attr(not(test), expect(...))`.
- `ledger/schema/coverage.rs:234` sits inside a `macro_rules!` with 5 expansions. It needs `cfg_attr`, or an allow
  carrying a reason under `#[expect(clippy::allow_attributes)]`.
- The GIT_DIR test re-execs a child, which must not abort mid-write (the crash-wedge skip list matches names only).
- S holds if M53.10's spawn helper lands first. TS twin: `suppressions.test.ts` fails any `eslint-disable` without
  `-- reason`. That is 15 of 17 today, and ChatInput's 3 have no reason anywhere.

**PRACTICES-3: engine boundaries.**
- **Baseline**: the no-DOM tsc run reports 5 errors: `runLog.ts:91,106,116` (window), `lib/sha256.ts:35` and
  `lib/mockParse.ts:115` (TextEncoder, via `skills.ts:1`). Move runLog's storage behind a store, re-point skills, and
  add an ambient TextEncoder declaration.
- **Dynamic imports**: all 8 `@tauri-apps` imports are dynamic, and ESLint's `no-restricted-imports` ignores
  `import()`. Use `no-restricted-syntax` on `ImportExpression`, or Macro's TS-compiler-API vitest walk.
- **Flat config** replaces rule options per glob, so compose one full option set per glob.
- **Rule (e)**, `.type === '<Capitalized>'`: drop it, or ship it with recorded allowlist reasons ('Type', 'Collection'),
  noting that routing through constants (`SKILL_TYPE`, `AGENT_TYPE`) stays prose.

## 7. Conflicts with Cerebro conventions

| Macro pattern | Cerebro invariant | Resolution |
| --- | --- | --- |
| FE-01: service clients only in queries (analog: IPC only from stores) | M33: each status section owns its own read and failure | Not adopted. The boundary is `@tauri-apps/*` only in the 4 IPC adapters (PRACTICES-3) |
| ast-grep warning tier with hand-kept legacy counts | Zero warnings; ratchets only tighten | Every rule ships as an error at zero violations; legacy is fixed or suppressed with a reason in the same phase |
| A third rules engine with TS/TSX twin rules | Justify every tool; one artifact over twins | ESLint for TS; clippy plus tripwires for Rust (PRACTICES-12) |
| CodeRabbit, CODEOWNERS, required review | M32 non-goals: required reviews are solo theater; no paid scanners | Bugbot stays; optional BUGBOT.md generated from CV IDs (PRACTICES-2) |
| OTLP to LGTM, browser OTel, Datadog | SECURITY.md: no cloud; amendment 7: operational state stays out of the ledger | Local capped JSONL; never in the vault or ledger, never read by product logic (PRACTICES-6/13) |
| Sanitizer with an Anthropic-API LLM pass | No API key ever enters the app | Allowlist + regex + post-scan; any LLM pass runs the user's CLI from a dev script (PRACTICES-5) |
| cargo-deny blocking on manifest change | M32.6: advisory and scheduled | Keep M32.6 as built (PRACTICES-1) |
| CLAUDE.md source + AGENTS.md symlink + 11k-line guide | M14.6: AGENTS.md is the single source; brevity | CV IDs inline in AGENTS.md; a few tracked dev skills; no guide |
| CS-24/25/49/54 (file size, mod.rs, sibling test.rs, missing_docs) | 225 inline `#[cfg(test)]`; 16 tripwires self-scan their file's non-test half | Not adopted; churn exceeds value and breaks the tripwires |
| `just check` hides legacy findings | M14.5: whole-repo pre-push mirrors CI | Not adopted; only the Rust-lane detector is fixed (PRACTICES-15) |
| Repo "skills" | Product Skills are vault records (`type: Skill`) | Called "dev skills" (PRACTICES-7) |
| tracing-subscriber behind a wrapper crate | Justify every crate (tiny_http over axum) | Own appender of about 60–100 lines (PRACTICES-6) |
| Conventional Commit titles enforced | Owner's commits skip the format | CV entry marked `enforced: prose` |
| Native E2E against the real backend | E2E on mockIpc by design; parity tested | Contract test + scan golden + CSP lane (PRACTICES-9/16/20) |
| Rejected mutation rolls back with a toast | Proposal channels return typed results; exempt from toasts | PRACTICES-19 asserts typed rejections for proposal channels |
| Thread-local mock env getter | 22 env reads; no typed-env crate wanted | Ban `set_var`/`remove_var`; GIT_DIR test re-execs a child |
| "No type special-casing" stated absolutely | System types already route by name (`library.ts:101-102`, `collections.ts:119`, `write.rs:992`) | Name the sanctioned system types before giving the rule an ID (PRACTICES-2) |

## 8. Verification notes (stage 3)

Refuted:
- **"Macro's goldens are real Claude CLI stream-json."** They are ACP traffic (`real_recordings.rs:8-9`), and native
  folds, `claude_fold` included, use synthetic transcripts (`crates/folds/README.md:14-15`). The
  `fixtures/real/README.md` it points to does not exist. PRACTICES-5 would put Cerebro ahead of Macro.
- **"The aggregate status treats cancel as fail."** `code_check_cloud_storage.yml:644-662` exits 1 only on `failure`,
  so a cancelled job passes. PRACTICES-10 demands `success`.
- **"run-app does port/worktree checks."** It is a Cursor Cloud recipe (`.claude/skills/run-app/SKILL.md:1-25`).
  Dropped as a PRACTICES-7 guide.
- **"Rule (e) has one live hit."** There is a second at `mockIpc.ts:553` (`'Collection'`, a parity twin of
  `write.rs:992`), and constant-based routing escapes the rule.
- **"2f229bb conflicts in playwright.config.ts."** The hunks don't overlap (lines 10 vs 24), and the file merges
  cleanly.

Corrected (partial):
- No-DOM engine baseline is **5** errors, not 4 (adds `mockParse.ts:115`).
- AGENTS.md has **5** live breaches, not 3 (adds the ChatInput disables and the InlineDiff/ChangesPage/PulsePage
  collapses).
- CI permissions: there is no workflow-level block, but the build job sets `contents: write`. CodeQL alerts #1/#2 flag
  the quality and e2e jobs.
- Macro's desktop logging (`apps/web/tauri/src-tauri/src/logging.rs`, 14 lines; `lib.rs:131-146`) writes to stderr
  only, so Cerebro's file sink is its own design.
- `local_e2e_test_support` shares fixtures but has no canonical golden, so PRACTICES-16 is fidelity inspire, with
  `ledger/conformance.rs:5906-5913` as the template.
- The PRACTICES-9 manifest cannot avoid parsing command source for parameter names.
- The pre-push regex must include `demo-vault/`.
- Crash-harness env reads are 15, not 14.

Confirmed:
- The clippy inventory is exact (49 diagnostics).
- The M32 cherry-pick: 7 clean, 1 conflicting in the two expected files. 10/10 pins resolve, and cargo-deny is green
  apart from the license line.
- Toolchain drift: CI 1.99, local 1.95, deps max out at 1.88, MSRV floor 1.89.
- Repo facts: 13 alerts, the ruleset contexts, quality 10:28, 103/101 commands, 106 exports, 34 `eprintln!`.

Unverified:
- e2e boot swap (C3; low risk, no time-sensitive assertions found).
- CLI recording (C6).
- Packaged-app stderr (C5; /dev/null measured on other apps).
- Local pnpm 10 (C10; CI already runs pnpm 10 on this lockfile).
- Matrix timing (C8).

Folded in from missed items:
- 3 CodeQL alerts, including the HIGH at `ingest.ts:159` (PRACTICES-7 triage; triage #3 now).
- Rust is not in CodeQL (PRACTICES-21).
- CSP parity (PRACTICES-20).
- Hand-mirrored guard parity (PRACTICES-16 phase 2).
- The dedicated agent browser (PRACTICES-7).
- Dead `stopAllAgents` (PRACTICES-9).
- Track B is also stranded (sequenced with PRACTICES-1).

## 9. Where to read first

1. `docs/STYLE_GUIDE.md`: the rule format and the CS/FE subsets worth adopting.
2. `clippy.toml` and `deny.toml`: disallowed methods with reasons; licence and source allowlists.
3. `rules/ast-grep/ts-feature-core-pure.yml`, `rules/ast-grep/rust-no-infra-in-domain.yml`: the rule shapes behind
   PRACTICES-3/4.
4. `packages/email-renderer/tests/boundaries.test.ts`, `packages/email-renderer/tsconfig.core.json`: the boundary test.
5. `apps/web/tests/functional/optimistic-mutations.spec.ts`: controllable outcomes (read only; all rights reserved).
6. `apps/web/tests/native/fixtures/filter-oracle.ts`, `apps/web/tests/native/filter-matrix.ts`,
   `apps/web/tests/native/README.md`: the oracle, the registry guard and the unexpected-request policy.
7. `crates/folds/agent_fold/src/domain/test/real_recordings.rs`, `crates/folds/agent_fold/scripts/sanitize_recording.py`:
   the sweep and the sanitizer.
8. `crates/macro_entrypoint/src/lib.rs`, then `crates/macro_tower_layers/src/lib.rs`: the init lessons and the span
   shape.
9. `.github/workflows/code_check_cloud_storage.yml` (aggregate at :644-662) and `.github/workflows/cargo_deny.yml`.
10. `.mcp.json`, `docker/docker-compose.yml:742-771`: the dedicated agent browser.
11. `.agents/skills/dependabot/SKILL.md`, `.claude/skills/live-debug/SKILL.md`,
    `.agents/skills/cloud-storage-hexagonal-architecture/SKILL.md`: skill shapes.
12. `docs/AGENT_GUIDE/browser-technique.md`: verification technique worth folding into verify-ui.
