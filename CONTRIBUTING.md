# Contributing

Cerebro is a personal project developed largely with AI agents, and the
process documentation lives where the agents read it: **`AGENTS.md`** holds
the commands, repo map, and the conventions that will bite you. Read it first
— it is short and it is the actual process.

The quick version:

- `pnpm install` wires the git hooks. Pre-commit lints; pre-push runs the
  full gate (typecheck, unit tests, and the Rust lane when `src-tauri/`
  changed). Never `--no-verify`.
- `pnpm test:run`, `pnpm e2e`, and `cd src-tauri && cargo test` must be green;
  CI enforces the same gates plus coverage floors that only ratchet up.
- Commits follow `type(scope): sentence (M<milestone>.<n>)`.
- Bugs and ideas: GitHub issues.
