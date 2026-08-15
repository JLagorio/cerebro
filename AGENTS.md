# Working on Cerebro

Shared instructions for AI coding agents. `CLAUDE.md` is a shim pointing here —
keep everything agent-facing in this file.

Cerebro is a files-first markdown workspace: a Tauri 2 (Rust) + React 19 app
where the vault on disk is the source of truth. The assistant is the user's own
Claude Code CLI, spawned as a subprocess against an in-process loopback MCP
server — no API key ever enters the app.

## Commands

| What       | Command                             | Notes                                                                     |
| ---------- | ----------------------------------- | ------------------------------------------------------------------------- |
| Dev server | `pnpm dev`                          | Port 5173 strict; `PORT=5273 pnpm dev` for a second checkout              |
| Unit tests | `pnpm test:run`                     | **`pnpm test` is watch mode — it never exits.**                           |
| Coverage   | `pnpm test:coverage`                | Thresholds in `vite.config.ts` ratchet UP only                            |
| E2E        | `pnpm e2e`                          | Playwright; reuses a running dev server outside CI. `PORT=...` to isolate |
| Lint       | `pnpm lint`                         | Zero-warning policy (`--max-warnings=0`)                                  |
| Format     | `pnpm format` / `pnpm format:check` | Prettier, 100 cols, single quotes                                         |
| Typecheck  | `pnpm typecheck`                    | App (`tsconfig.json`) + tools (`tsconfig.tools.json` — scripts/, e2e/)    |
| Rust       | `cd src-tauri && cargo test`        | Also `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`     |
| Mac build  | `./scripts/mac-build.sh`            | Local build + install                                                     |

Hooks (husky): pre-commit lints; pre-push runs the full gate. **Never
`--no-verify`** — if a hook is wrong, fix the hook.

## Repo map — what is real and what is vendored

- `src/` — React app. `engine/` is the pure domain core (best-tested layer);
  `views/`, `pages/`, `app/`, `detail/`, `knowledge/`, `agent/`, `editor/`,
  `git/`, `library/`, `workspace/`, `status/` are surfaces; `stores/` is
  Zustand; `lib/` holds IPC + browser mocks.
- **The Status hub is one page made of sections** (M33.3–M33.5).
  `pages/EpistemicStatusPage.tsx` is the shell; each section is its own
  component in `src/status/` owning its own read and its own failure.
  `ReviewPage` and `PipelinePage` are gone — "Needs review" and "Background"
  are sections, not tabs, and the rail is 10 buttons (Home, Status, Inbox,
  Docs, Workspace, Knowledge, History, Assistant, Library, Settings), asserted
  by name in `app/Rail.test.tsx`. Sections are addressed by `data-section`,
  never by a per-section testid, and `Selection.status` carries an optional
  `section` (plus `run`, for one fleet detail) so a section is a place the
  back button returns to.
- `src-tauri/src/` — Rust: `vault/` (scan/parse/write), `git/`, `mcp.rs`
  (loopback MCP server), `agent.rs` (CLI spawn), `knowledge.rs` (OKF guards),
  `connectors.rs`, `runtime/fleet.rs` (SELECT-only run history — it writes
  nothing, and a phase that needs a new fact goes through the Meter or the
  governance writers instead).
- `demo-vault/` — the golden corpus. Dev, vitest, and Playwright all run
  against it; editing it churns e2e assertions, so treat changes as test
  changes.
- **`docs/archive/` and `docs/examples/` are gitignored vendored reference,
  NOT documentation** — third-party repos and material kept for study. Never
  lint, test, or grep them as project code. Milestone plan and spec docs live
  in `docs/superpowers/plans/` and `docs/superpowers/specs/` and are tracked
  normally (the old `docs/archive/superpowers/` path and its `git add -f`
  ritual are gone).
- `scripts/` — seeders and mac packaging. Typechecked via `tsconfig.tools.json`.

## Conventions that will bite you

- **Commits**: `type(scope): sentence (M<milestone>.<n>)` — see `git log`. One
  milestone phase per commit where possible.
- **Store-layer error invariant — human-UI actions only** (re-scoped M24.2):
  actions behind a human action never throw. They catch, `toast()`, and
  return `null`/`false`; call sites may fire-and-forget with `void`. Anything
  that breaks this needs a written reason at the call site.
  **Proposal channels are exempt, and must be.** They return a typed
  `applied | queued | rejected { code, rule, expected, actual }` result that
  the caller is expected to READ and act on — a queued HIGH-risk mutation is
  not an error to toast away, and a `stale_target_version` rejection is a
  card the user has to see. Collapsing those into `null` would throw away
  the whole point of typing them.
- **Policy is data**: `shared/policy/` is loaded by Rust (`include_str!`) and
  TS (vite) from the SAME files. A policy rule implemented as twin Rust and
  TS code is a review-blocking defect — grow the table format instead.
  Parity is the shared artifact plus `shared/policy/goldens/`; see that
  directory's README before editing either artifact (both have regeneration
  steps that are deliberate, `#[ignore]`d tests).
- **Absent is never zero, and unavailable is never empty.** A number nobody
  recorded renders as words ("not recorded", "unknown", "unattributed"), never
  as `0` or `$0`; a total that had to skip unmetered rows says how many it
  skipped rather than absorbing them. A read that FAILED renders
  `section-unavailable`, never the empty state — "nothing is waiting" and "we
  could not tell you what is waiting" are opposite sentences, and a surface
  that says the first when it means the second is worse than one that says
  nothing. M33 retired two `catch → empty` collapses (`ReviewPage`,
  `PipelinePage`) for exactly this; do not reintroduce one. `Option`/`null`
  from Rust means NOT RECORDED and an empty collection means measured-at-zero,
  so never map one to the other on the way through.
- **Two records, two destinies**: every refusal names a code whose
  ledger-or-operational destiny is declared in the shipped policy table —
  `shared/policy/policy.v3.json` since M27.4; v1 and v2 are frozen negative
  controls, never edited. Epistemic
  history goes in the vault ledger; schema mistakes, malformed arguments,
  and capability gaps go in `<app-data>/runtime.db`. When in doubt:
  operational. Promoting a code into the ledger needs a
  coverage-materiality argument in review.
- **Knowledge is guarded**: `knowledge/` is agent-written, human-VERIFIED.
  Writes go through `write_concept`/`verify_concept` only; the mock backend
  (`src/lib/mockIpc.ts`) must mirror every Rust-side guard, and that parity is
  itself tested.
- **No type special-casing**: behavior is capability-gated (a record with a
  status field is task-like; a record the base holds concepts about gets a
  dossier). Do not route on type names.
- **Wikilink fields** arrive from the scanner bracket-stripped in
  `entry.relationships`, not `properties` — test fixtures must use that shape.
- **Suppressions carry reasons**: every `eslint-disable` states why, in place.
  The compiler-era react-hooks rules are off by documented choice
  (`eslint.config.js`) — candidates to ratchet on, not free to violate.
- **A retired workaround needs its original comment killed.** When a
  constraint stops being true, the fix includes deleting the comment that
  explained the old shape. M31 planned to kill five in our own tree — the
  assembly prompt's "no tools" claim, the three "Not narrowed here"
  rationales (counted once), the assembly capability-absence comment, the
  run_cost_components "no producer" note, and this file's own policy.v1
  reference — and review found five more the same commits had falsified
  (ambient's ledger-appender count, schema.rs's "nothing reads them yet",
  and the trigger module's three "fourteen" claims). Budget for that: the
  comment a change falsifies is rarely the comment the change is about.
- **Ratchets only tighten**: coverage thresholds in `vite.config.ts` never go
  down.
- `.gitattributes` pins sources to text after two files went binary from
  embedded control bytes (raw NUL, literal BOM). Write escapes (`\0`,
  `\uFEFF`), never raw control characters.

## Verifying UI work

**Only `*.mermaid.test.ts` may `import mermaid`.** Those files exist to measure
claims about the bundled renderer — the shape registry, the `style`/arrow syntax
our ops emit — and each pays ~4s of real parse/render for it. Everything else
under `src/` stays pure string code or mocks `../render` with a fixture svg
(`StructuralEditor.test.tsx`); a component test that reaches for real mermaid is
a component test that flakes under load.

Playwright specs use `getByTestId`/`getByRole` against the mock backend
(`window.__cerebroMockFs` exposes the fake disk). **Import `boot` from
`e2e/boot.ts`; never write your own.** It disables the background distiller,
pins the theme, and pins the CLOCK to `VAULT_TODAY` — the day the demo vault
was written to be read on. That last one is not optional: the corpus has
absolute dates and the app has relative-time logic, so an unpinned spec has a
shelf life. One expired in M26 and failed on every tree for days. The
browser timezone is fixed to UTC in `playwright.config.ts` for the same
reason. For live checks, chrome-devtools MCP against `pnpm dev` works;
synthetic `blur` events don't fire React `onBlur` (call `el.blur()`).

**Check the e2e port is FREE before running.** `reuseExistingServer` is on
outside CI, so a port held by another worktree is silently reused and the
suite runs against a different branch's app — producing confident, wrong
failures. `lsof -iTCP:5173 -sTCP:LISTEN` first, then `PORT=<free> pnpm e2e`.
