---
name: dependabot-triage
description: Triage open Dependabot alerts and PRs into a bump, an override or a proposed dismissal, each with a reason. Use when any are open, or before a release.
---

# dependabot-triage

The agent proposes and the owner decides. Never dismiss an alert, or merge or
close a PR, yourself.

## Gather

- Alerts:
  `gh api 'repos/{owner}/{repo}/dependabot/alerts?state=open&per_page=100' --jq '.[] | [.number, .security_advisory.severity, .dependency.scope, .dependency.package.ecosystem + "/" + .dependency.package.name, .dependency.manifest_path] | @tsv'`.
- PRs: `gh pr list --author app/dependabot`.

## Per alert

- Scope: a `runtime` dependency ships in the app; a `development` one does
  not.
- Direct or transitive: `pnpm why <package>`, or
  `cargo tree -i <crate> --manifest-path src-tauri/Cargo.toml`.
- Reachable: anything that parses or renders vault text in the webview is,
  because a vault is untrusted input.
- The fix: the alert's `first_patched_version`, and whether our declared
  range can reach it.

## Decide

- Bump: one dependency or one Dependabot group per `build(deps):` commit
  (CV-02), with the full gate. An editor or renderer dependency also needs
  `pnpm e2e` and the `verify-ui` skill. A major bump is its own planned part.
- Override: the `@blocknote/*` packages are pinned exactly and move in
  lockstep (their group in `.github/dependabot.yml`). A tiptap or ProseMirror
  advisory under them waits for a BlockNote release, or gets a
  `pnpm.overrides` entry with its reason in the commit and an editor e2e run.
- Dismissal: propose it only, with one reason from `fix_started`,
  `inaccurate`, `no_bandwidth`, `not_used` or `tolerable_risk`, and a comment
  saying why. Hand the owner the command:
  `gh api -X PATCH repos/{owner}/{repo}/dependabot/alerts/<n> -f state=dismissed -f dismissed_reason=<reason> -f dismissed_comment='<why>'`.

## Rust

- `deny.toml` and the weekly lane in `.github/workflows/cargo-deny.yml` are
  advisory by design and never gate a push. An advisory inside tauri's own
  tree waits for a tauri bump.

## PRs

- Read the lockfile diff, not only the title. An actions bump keeps the SHA
  pin and updates the version comment beside it; `scripts/workflows.test.ts`
  holds both rules.

## Report

- One row per alert: number, package, decision (bump, override or proposed
  dismissal), reason and commit.
- CodeQL alerts are code defects, not dependency noise: each gets its own
  part, with a fix and a test.
