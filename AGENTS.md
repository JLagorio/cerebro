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
  `git/` are surfaces; `stores/` is Zustand; `lib/` holds IPC + browser mocks.
- `src-tauri/src/` — Rust: `vault/` (scan/parse/write), `git/`, `mcp.rs`
  (loopback MCP server), `agent.rs` (CLI spawn), `knowledge.rs` (OKF guards),
  `connectors.rs`.
- `demo-vault/` — the golden corpus. Dev, vitest, and Playwright all run
  against it; editing it churns e2e assertions, so treat changes as test
  changes.
- **`docs/` is gitignored vendored reference, NOT documentation** —
  `tolaria-main/` and friends are third-party repos kept for study. Never lint,
  test, or grep them as project code. Milestone plan docs live in
  `docs/archive/superpowers/plans/` and are force-added (`git add -f`).
- `scripts/` — seeders and mac packaging. Typechecked via `tsconfig.tools.json`.

## Conventions that will bite you

- **Commits**: `type(scope): sentence (M<milestone>.<n>)` — see `git log`. One
  milestone phase per commit where possible.
- **Store-layer error invariant**: actions never throw. They catch, `toast()`,
  and return `null`/`false`; call sites may fire-and-forget with `void`.
  Anything that breaks this needs a written reason at the call site.
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
(`window.__cerebroMockFs` exposes the fake disk). The background distiller is
disabled via localStorage in `boot()` — copy an existing spec's boot. For live
checks, chrome-devtools MCP against `pnpm dev` works; synthetic `blur` events
don't fire React `onBlur` (call `el.blur()`).
