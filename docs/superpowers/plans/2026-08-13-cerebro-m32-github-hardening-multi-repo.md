# M32 — The gate becomes unskippable, and mounted repos get their git surface

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between Cerebro's strong *local* quality gate and its
absent *server-side* one (GitHub hardening), and give M30's mounted roots the
git surface M30 explicitly deferred (multi-repo support).

**Architecture:** Two loosely-coupled tracks on one branch cut from
`origin/main`. Track A (M32.1–M32.7) hardens the repo: CI triggers and token
scope, SHA-pinned actions, Dependabot, a main ruleset, workflow scanners,
cargo-deny, and build provenance. Track B (M32.8–M32.12) extends M30's
settled shapes: root-scoped read-only git commands gated on `caps.git` with
typed refusals, UI + mock parity, credentials probing, fetch/fast-forward
pull, and the agent-exposure decision recorded in SECURITY.md.

**Tech Stack:** GitHub Actions/rulesets/API (`gh`), Dependabot, zizmor +
actionlint + cargo-deny, Rust (Tauri 2), React 19 + Zustand, vitest,
Playwright.

---

**Brief for the agent picking this up cold.** Written 2026-08-13 out of a
five-agent recon over `docs/examples/tolaria-main` (a vendored production
Tauri vault app whose release engineering and multi-vault model are the
reference), the live GitHub API state of `JLagorio/cerebro`, and M30's own
decision log. Every fact below was verified on 2026-08-13; refs and external
state drift — re-verify at start.

**Read before touching anything**, in this order:

1. `AGENTS.md` — house rules. The ones that bite here: capability-gating (no
   routing on type names — `RootCaps` exists so nothing asks "is this a
   vault?"); store-layer never-throw is HUMAN-UI ONLY, and typed
   refusal/result channels are exempt **and must be** (a `RemoteResult` is
   read, never toasted away); the mock backend mirrors every Rust-side guard,
   tested; ratchets only tighten; zero-warning lint.
2. `docs/superpowers/plans/2026-08-09-cerebro-m30-overview.md` (on
   `origin/main`) — M30's decision log. M32 treats its shapes as **settled
   API**: extend `RootCaps`, `MountRefusal`-style typed refusals, and the
   `roots::find` resolution pattern; never introduce parallel concepts.
3. `SECURITY.md` — the trust model M32.12 amends. Do not widen any agent
   capability without amending it in the same commit.
4. `docs/examples/tolaria-main` is **vendored reference, not project code**.
   Read it for patterns (its ADRs 0114/0119/0056 are cited below); never
   lint, test, or scan it — and configure every scanner M32 adds so it
   cannot see it (M32.5 trap).

---

## Where things stand (verified 2026-08-13 — re-verify, refs drift)

**Repo.** `JLagorio/cerebro`, **public**, user-owned (no org — merge queue is
unavailable, org rulesets don't apply). `gh` CLI is authenticated and was used
for every API fact below.

**Branch topology.** `origin/main` tip is `e872114` (merge of PR #11, M29
mermaid), which contains M30 (`c863f36`, PR #12, multi-root workspace). The
`m22-m28-convergent-intelligence` branch (~135 commits of ledger/policy work,
still growing — don't pin the number) has **never merged**; its merge-base with main is `81210b9` (M20). M32's
multi-repo track extends `src-tauri/src/roots/` and `src/workspace/`
(~10.4k lines, PR #12), which exist **only on main**.

**Therefore: M32 builds on `origin/main`, not on the M22–M28 branch.** This
is forced, not preferential — basing on the branch would mean rebuilding M30.
Nothing in M32 needs the ledger/policy layer: M30's own decision log routes
policy-governed repo *writes* (proposal cards) to a future milestone that
requires that layer, and M32 excludes them (see Non-goals). Sequencing note
that matters: **M32.4's ruleset should land before the m22-m28 branch ever
merges**, so the riskiest merge in the repo's history happens onto a
protected main.

**GitHub API state** (all checked 2026-08-13):

| Fact | Evidence |
| --- | --- |
| main is unprotected | `gh api repos/JLagorio/cerebro/branches/main/protection` → 404 "Branch not protected" |
| zero rulesets | `gh api repos/JLagorio/cerebro/rulesets` → `[]` |
| secret scanning + push protection ON | `security_and_analysis` on `gh api repos/JLagorio/cerebro` |
| Dependabot alerts OFF | `gh api repos/JLagorio/cerebro/vulnerability-alerts` → 404 "Vulnerability alerts are disabled" |
| Dependabot security updates OFF | `security_and_analysis.dependabot_security_updates: disabled` |
| Actions default token read-only | `gh api repos/JLagorio/cerebro/actions/permissions/workflow` → `default_workflow_permissions: read` (a *setting*, not declared in any workflow — M32.1 makes it survive a settings change) |

**The one workflow.** `.github/workflows/mac-app.yml` (byte-identical on main
and the m22-m28 branch): triggers `push: branches: ['**'], tags: ['v*']` +
`workflow_dispatch` (lines 12–16) — **no `pull_request` trigger**; jobs
`quality` → `e2e` → `build (needs both)`; a `permissions:` block exists only
on `build` (`contents: write`, lines 124–125); eight third-party action refs
(four distinct actions) on mutable tags, including `dtolnay/rust-toolchain@stable` (lines 69, 139 — a
moving **branch**, not even a tag) and `softprops/action-gh-release@v2`
(line 168) inside the `contents: write` job; `Swatinem/rust-cache@v2`
restored in the job that builds the DMG users install (lines 143–145 —
cache-poisoning-to-release path); release body instructs users to strip
quarantine (`xattr -dr com.apple.quarantine`, lines 175–180).

**M30 shipped** (all on `origin/main`): `src-tauri/src/roots/{mod,read,store,tree}.rs`
+ `roots_commands.rs` with five commands (`list_roots`, `mount_root`,
`unmount_root`, `list_dir`, `read_file_text`, registered in `lib.rs:415–419`);
`Root { id (generated at mount, NOT path-derived), path, label, alias
(dormant, reserved for cross-root refs), color, caps }`;
`RootCaps { knowledge, git, writable }` **probed from disk, never declared**;
`MountRefusal { code, message }` — "a refusal the UI is expected to READ and
act on, not toast away"; exactly one knowledge root; mount attaches an
existing canonicalized directory only (Cerebro never creates or owns a
checkout). Front end: `src/workspace/` (RootTree, EditorGroups, TabBar,
Doc/Code viewers), `src/stores/rootsStore.ts`, mocks in `src/lib/mockRoots.ts`
(+ `mockGit.ts`), e2e in `e2e/workspace.spec.ts`.

**The git module today** (`src-tauri/src/git/`, ~2,081 lines): sound core —
`command::git_command()` scrubs `GIT_DIR`/`GIT_WORK_TREE` etc., disables all
prompting (`GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS`/`SSH_ASKPASS`), sets
`GIT_CONFIG_PARAMETERS="'core.quotepath=false'"` (command.rs:79–89);
`workspace::resolve` handles a vault nested inside a larger repo via
`GitWorkspaceInfo { vault_root, git_root, vault_pathspec, git_root_relation }`;
`remote::classify` turns suppressed prompts into typed
`RemoteOutcome::{Ok, UpToDate, Updated, Conflict, Rejected, AuthError,
NetworkError, NoRemote, Error}`. But **the git command surface in
`git_commands.rs` (25 of its 27 commands) takes `vault: String`** — a mounted
root shows no branch, no dirty state, no history, nothing. `RootCaps.git` is
probed and then consumed by no git surface (its only consumer anywhere is
`RootTree.tsx:119`'s unavailable-root check, `!caps.writable && !caps.git` —
M32.9 must not confuse that rendering with "no badge").
Missing vs the tolaria reference (7,890 lines): credentials probing,
upstream management, deep status/conflict treatment.

---

## Settled decisions (defaults an executor follows; the user can overrule)

Each of these was an open question in recon. The plan settles it so execution
never blocks; flipping any of them is a plan edit, not a discovery.

1. **The agent does NOT see mounted repos in M32.** SECURITY.md promises
   vault-scoped tools; mounted roots may contain employer code. M32.12
   records the decision and what a future "yes" requires, instead of
   silently wiring `roots/read.rs`'s MCP-ready guards into `mcp.rs`.
2. **No Apple Developer ID / notarization.** It costs $99/yr and is a
   custody decision, not a config change. The integrity ceiling without it is
   build-provenance attestation (M32.7) — the plan states that ceiling
   honestly rather than half-shipping signing.
3. **Dependabot, not Renovate.** Zero-infra, native cooldown, native
   github-actions SHA bumping (which keeps M32.2's pins from rotting).
4. **Immutable releases: dry-run first.** Enable the toggle, then publish a
   `v0.0.1-rc` throwaway release before the next real one — once published
   immutable, a botched asset can never be swapped (draft → attach → publish
   is the escape hatch to adopt if the flow ever grows steps).
5. **Root git mutations stop at fetch + fast-forward pull.** Commit/push on
   work repos is policy-layer territory (M30 decision log) and the m22-m28
   branch is not merged. `--ff-only` means Cerebro can never *create* a
   conflict in a repo it doesn't own.
6. **One release lane.** No alpha/stable channels. If channels ever come,
   extract a `workflow_call` builder first (tolaria's pattern) — noted, not
   built.
7. **Rust coverage floor: registered, not shipped.** It touches the husky
   hooks, which this plan otherwise refuses to touch. Recorded in M32.12's
   deferral list with the tolaria recipe (`cargo llvm-cov --fail-under-lines`
   at measured actuals, `--no-clean` locally).
8. **Commit signing: skip.** Solo, the push credential already authenticates
   every commit; a signature requirement is the rule most likely to get
   bypassed weekly with agent-driven commits from multiple worktrees. The
   10-minute SSH-signing + vigilant-mode setup is noted in M32.12 as a
   personal-hygiene option, never a ruleset rule.

## Non-goals (defend these)

- **No `pull_request_target`, ever.** The number-one Actions RCE pattern;
  nothing Cerebro needs requires it. M32.1 documents the rule in the
  workflow itself.
- **No GitHub API / octokit / PR integration in the app.** M30 decision 3
  (provider-agnostic plumbing) stands. Even tolaria's "tight GitHub
  integration" contains zero GitHub API calls.
- **No auto-updater and no updater keypair.** The minisign private key would
  be a silent-RCE-on-every-install god key; custody precedes the feature.
  M32.12 records the custody rule for whenever the updater becomes real.
- **No provider OAuth, no stored git credentials.** System-git auth only
  (tolaria ADR-0056) — it eliminates the entire credential-storage attack
  surface. M32.10 *probes* credentials; it never stores them.
- **No commit/push on mounted work repos.** Requires the policy layer
  (proposal cards) — a different milestone, after the m22-m28 merge.
- **No clone/checkout ownership.** M30's deliberate v1 decision: Cerebro
  mounts existing directories only.
- **No CODEOWNERS, PR templates, required reviews, or merge queue.**
  Considered and rejected as solo theater: you cannot approve your own PR,
  and training yourself to bypass a rule is worse than not having it. Merge
  queue is unavailable on a user-owned repo anyway. (One bug-report issue
  template IS in scope — drive-by reports from shipped DMGs are real.)
- **No CodeScene/Codacy or other paid scanners.** Free-tier
  CodeQL + zizmor + cargo-deny cover the residual surface beyond the husky
  gate.
- **No touching the husky hooks** except comment honesty. The local gate is
  the baseline M32 must not regress; every new lane is CI-only by design.
- **No lifting the one-knowledge-root invariant.** M30's overview records
  that lifting it forces HLC back in, against the accepted no-HLC amendment.
- **No Windows/Linux targets.** Tolaria's Authenticode/NSIS machinery is
  filed as reference (its tri-state secret validation and checksum-pinned
  tool prefetch are the transferable lessons), not scope.
- **No second TS implementation of any repo/vault semantics.** Everything
  stays behind the single Rust boundary; the mock layer mirrors guards with
  parity tests, exactly as M30 did (tolaria's duplicate frontmatter parser
  is the named anti-pattern).

---

## Getting started

This plan doc was authored on the `m22-m28-convergent-intelligence` checkout;
execution happens on a fresh branch off `origin/main` in its own worktree:

```sh
cd /Users/joseflagorio/Development/cerebro
git fetch origin
git worktree add .claude/worktrees/m32 -b m32-hardening-multi-repo origin/main
cp docs/superpowers/plans/2026-08-13-cerebro-m32-github-hardening-multi-repo.md \
   .claude/worktrees/m32/docs/superpowers/plans/
cd .claude/worktrees/m32 && pnpm install
git add docs/superpowers/plans/2026-08-13-cerebro-m32-github-hardening-multi-repo.md
git commit -m "docs(plan): M32 — github hardening and the multi-repo git surface (M32.0)"
```

One commit per phase, `type(scope): sentence (M32.n)`. Tick this doc's
checkboxes and note surprises **in the same commit** as each phase. After
M32.1, open a draft PR immediately — the retargeted triggers mean PR events
are where CI lives, and every later phase wants a green run attached.

Gate per phase (Track B phases run the full local gate; Track A phases that
only touch `.github/` run lint-of-the-thing plus the CI run itself):

```sh
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test:run
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
p=5573; lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null && echo "$p BUSY — pick another" || PORT=$p pnpm e2e
```

## Execution deviations (recorded 2026-08-15, at start of execution)

The plan's branch-topology premise expired between authoring and execution.
Re-verified at start, as the plan instructs:

**The m22-m28 branch MERGED** — `origin/main` is `7e1fe07`, the PR #13 merge,
so main now carries the ledger/policy layer. M31 (`m31-claims-and-records`,
PR #14, green) branched from `cb19f2e`, whose content is byte-identical to
`origin/main`, and therefore already contains M30's `roots/` + `workspace/`.
**M32 is built on M31, not on `origin/main`** — at the user's instruction, and
the constraint that forced the original choice ("basing on the branch would
mean rebuilding M30") no longer exists. M32's PR stacks on PR #14.

Three phase-level consequences, each handled where it lands:

| The plan says | True on this base | Phase |
| --- | --- | --- |
| no `e2e/boot.ts`; write a spec-local `boot()` | `e2e/boot.ts` exists and AGENTS.md mandates it — the instruction **inverts** | M32.9 |
| AGENTS.md has no port-trap paragraph; ADD one | it has one (the `lsof` ritual) — **rewrite** it, don't add | M32.7 |
| `playwright.config.ts` line 19 | line 24 | M32.7 |

Two plan statements are now moot rather than wrong: "the ruleset should land
before the m22-m28 branch ever merges" (it merged first — the ruleset still
lands, it just no longer guards that particular merge), and M32.12's
work-repo-writes trigger, "m22-m28 policy layer merged to main", is now
**satisfied** — that deferral's gate has fired and the register says so.

All GitHub API facts in the table above re-verified unchanged on 2026-08-15.

---

# Track A — the gate becomes unskippable

### M32.1 — CI triggers and token clamp

The workflow gains a `pull_request` trigger (required checks need PR-attached
runs to bind to — this must land before M32.4), stops burning a macOS build
on every WIP push, and stops handing every third-party action an ambient
token whose scope is only a repo *setting* away from write.

**Files**
- Modify: `.github/workflows/mac-app.yml`

- [x] **Step 1: Retarget the triggers**

Replace lines 12–16 (`on:` block) with:

```yaml
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
  workflow_dispatch:
```

The header comment (lines 3–10) says "run on Linux on every push" and "Every
push produces a downloadable artifact" — both false after this step. Rewrite
it to describe the new shape (PRs run the two gates; pushes to main and `v*`
tags additionally build; a PR that needs a DMG uses workflow_dispatch). A
comment that contradicts its own file is the drift this milestone's SETUP.md
lesson exists to prevent.

- [x] **Step 2: Clamp the token and document the rule**

Immediately below the `on:` block (before `concurrency:`), add:

```yaml
# Least privilege: the ambient token is read-only for every job; `build`
# alone elevates to contents:write for tag releases. The repo setting says
# read-only too, but a setting is not reviewable — this line is.
# House rule: no workflow in this repo may ever use pull_request_target.
# It hands the base repo's secrets to fork code; nothing we do needs it.
permissions:
  contents: read
```

- [x] **Step 3: Stop persisting credentials at checkout**

All three `- uses: actions/checkout@v4` steps (quality line 35, e2e line 90,
build line 127) become:

```yaml
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
```

Nothing in this workflow pushes back to the repo, so nothing needs the token
on disk where every subsequent step (pnpm lifecycle scripts, build.rs,
Playwright) can read it.

- [x] **Step 4: Keep the macOS build off PR events**

The `build` job builds a release-shaped artifact; PRs only need the two
gates. Add to the `build` job, directly under `needs: [quality, e2e]`:

```yaml
    # PRs are gated by quality+e2e alone; the artifact build runs on main,
    # tags, and manual dispatch. A PR that needs a DMG can dispatch one.
    if: github.event_name != 'pull_request'
```

- [x] **Step 5: Verify and commit**

```sh
git add .github/workflows/mac-app.yml
git commit -m "ci(actions): pull_request gating, read-only token, no persisted credentials (M32.1)"
git push -u origin m32-hardening-multi-repo
gh pr create --draft --title "M32: GitHub hardening + multi-repo git surface" \
  --body "Tracking PR for M32. Phases land as individual commits."
sleep 30 && gh pr checks --watch
```

Expected: `quality` and `e2e` run on the PR and pass; no `build` job on the
PR event. (`gh pr checks` errors with "no checks reported" if it races the
first check-run registration — the sleep covers that; re-run if it still
reports none.)

**Acceptance:** PR events run both gates; push CI is main+tags only; the
token is workflow-level read-only; all checkouts are credential-free; the
pull_request_target prohibition is written where the next editor will see it.

---

### M32.2 — SHA-pin the supply chain, cold-cache the release

Tags are mutable; the March-2025 tj-actions compromise was exactly a
force-moved tag running attacker code with the job's token. The worst
current exposure is `dtolnay/rust-toolchain@stable` (a moving *branch*) and
`softprops/action-gh-release` (tag) inside the `contents: write` job — and a
shared cargo cache feeding the artifact users install.

SHAs below were resolved 2026-08-13. **Re-verify each pin before
committing**, and mind the trap that caught this plan's own first draft: an
*annotated* tag has its own object SHA distinct from the commit it points at,
and Actions resolves `uses:` SHAs **as commits** — a tag-object SHA looks
pinned, passes zizmor's unpinned-uses audit, and breaks Dependabot's SHA
bumping and commit-resolving audits. Always take the **peeled** SHA:

```sh
# The ^{} line, when present, is the commit; the bare line is the tag object.
git ls-remote --tags https://github.com/<owner>/<repo>.git 'refs/tags/<tag>*'
# Or dereference via the API: type "tag" means peel it again.
gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq '.object | .type + " " + .sha'
```

**Files**
- Modify: `.github/workflows/mac-app.yml`

- [x] **Step 1: Pin the third-party actions (GitHub-owned `actions/*` stay on major tags)**

| Current ref | Pinned replacement (peeled commit SHAs) |
| --- | --- |
| `pnpm/action-setup@v4` (lines 37, 92, 129) | `pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 # v4.4.0` |
| `dtolnay/rust-toolchain@stable` (lines 69, 139) | `dtolnay/rust-toolchain@e97e2d8cc328f1b50210efc529dca0028893a2d9 # v1` |
| `Swatinem/rust-cache@v2` (lines 73, 143) | `Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2` |
| `softprops/action-gh-release@v2` (line 168) | `softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65 # v2.6.2` |

(pnpm v4.4.0 and rust-cache v2.9.2 are annotated tags — the SHAs here are
their peeled commits, not the tag objects. dtolnay v1 and softprops v2.6.2
are lightweight tags, so tag SHA = commit SHA.)

- [x] **Step 2: The dtolnay pin changes how the toolchain is named**

With `@stable` the action read the toolchain from the ref itself. Pinned by
SHA, the toolchain must be an input. The quality-job step becomes:

```yaml
      - uses: dtolnay/rust-toolchain@e97e2d8cc328f1b50210efc529dca0028893a2d9 # v1
        with:
          toolchain: stable
          components: rustfmt, clippy
```

and the build-job step becomes:

```yaml
      - name: Install Rust with both Mac targets
        uses: dtolnay/rust-toolchain@e97e2d8cc328f1b50210efc529dca0028893a2d9 # v1
        with:
          toolchain: stable
          targets: aarch64-apple-darwin, x86_64-apple-darwin
```

- [x] **Step 3: The release lane restores nothing it didn't fetch itself**

An attacker with one-time code execution in any main-branch run can poison a
shared cache; the next tag build would link poisoned objects into the DMG.
That argument covers BOTH caches in the build job. Guard the **build job's**
rust-cache step (the quality/e2e jobs keep their caches — they publish
nothing):

```yaml
      - uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2
        # A release must never link objects it didn't compile: tag builds
        # start cold. Costs minutes, on the one lane where it matters.
        if: ${{ !startsWith(github.ref, 'refs/tags/') }}
        with:
          workspaces: src-tauri -> target
```

and drop `cache: pnpm` from the **build job's** setup-node step (lines
133–136) entirely:

```yaml
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          # No pnpm store cache in this job — same reasoning as rust-cache:
          # the lane that ships bytes restores nothing from a writable
          # shared cache. quality/e2e keep theirs.
```

- [x] **Step 4: Verify every pin is a COMMIT, then commit**

```sh
# Each pinned SHA must resolve as a commit (not 422 / not a tag object):
for pin in pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320 \
           dtolnay/rust-toolchain@e97e2d8cc328f1b50210efc529dca0028893a2d9 \
           Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 \
           softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65; do
  gh api "repos/${pin%@*}/commits/${pin#*@}" --jq .sha >/dev/null \
    && echo "OK   $pin" || echo "BAD  $pin — tag object or gone, re-peel it"
done
grep -n '@v[0-9]' .github/workflows/mac-app.yml   # only actions/* remain
git add .github/workflows/mac-app.yml
git commit -m "ci(actions): third-party actions pinned to commits, releases compile cold (M32.2)"
git push && gh pr checks --watch
```

> **Executed 2026-08-15.** All four pins re-peeled and re-verified independently
> against the live API: `pnpm/action-setup@v4.4.0` and `Swatinem/rust-cache@v2.9.2`
> are annotated tags (peeled), `dtolnay/rust-toolchain@v1` and
> `softprops/action-gh-release@v2.6.2` are lightweight; all four resolve as
> commits and all four match the SHAs this plan recorded on 2026-08-13. The
> two later-phase pins were peeled in the same pass: `zizmor-action@v0.6.2`
> lightweight, `cargo-deny-action@v2.1.1` annotated — both also match.

**Acceptance:** every non-`actions/*` ref is a full commit SHA with a version
comment; the toolchain is an explicit input; the build job restores no cache
on tag refs; CI green.

---

### M32.3 — Dependabot: alerts on, updates automated

The single biggest free lunch found in recon: both lockfiles are committed,
and the repo gets **zero notification** when a CVE lands in the ~40 npm deps
or the 400+-crate Cargo tree. Two API calls and one file.

**Files**
- Create: `.github/dependabot.yml`

- [x] **Step 1: Turn the alerts on (settings-side)**

```sh
gh api -X PUT repos/JLagorio/cerebro/vulnerability-alerts
gh api -X PUT repos/JLagorio/cerebro/automated-security-fixes
```

Expected: HTTP 204 (empty response) for both. Verify:

```sh
gh api repos/JLagorio/cerebro/vulnerability-alerts   # now 204, not 404
```

- [x] **Step 2: Create `.github/dependabot.yml`**

```yaml
# Weekly, grouped, with a cooldown: a 7-day-old release has had its window
# to be caught and yanked (the npm-worm class). The github-actions ecosystem
# is what keeps M32.2's SHA pins from rotting — Dependabot bumps pinned SHAs
# natively and updates the version comment.
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    cooldown:
      default-days: 7
    groups:
      blocknote:
        patterns: ["@blocknote/*"]   # pinned lockstep — must move together
      tauri-frontend:
        patterns: ["@tauri-apps/*"]
      dev-dependencies:
        dependency-type: "development"
        update-types: ["minor", "patch"]
  - package-ecosystem: "cargo"
    directory: "/src-tauri"
    schedule:
      interval: "weekly"
    cooldown:
      default-days: 7
    groups:
      tauri:
        patterns: ["tauri*"]
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

- [x] **Step 3: Commit and verify Dependabot parses it**

```sh
git add .github/dependabot.yml
git commit -m "ci(deps): dependabot — alerts on, weekly grouped updates, SHA pins kept fresh (M32.3)"
git push
```

After push, check https://github.com/JLagorio/cerebro/network/updates (or
`gh api repos/JLagorio/cerebro/dependabot/alerts --jq length`) — a parse
error surfaces there, not in CI.

> **Executed 2026-08-15.** Both PUTs returned 204 and
> `security_and_analysis.dependabot_security_updates` now reads `enabled`.
> Group patterns verified non-vacuous before committing: 4 `@blocknote/*`
> packages, 3 `@tauri-apps/*`, 3 `tauri*` crates; both lockfiles tracked.
>
> **Trap for every remaining YAML in this plan:** Prettier lints `.github/`
> and the repo style is single quotes, so this plan's double-quoted snippets
> fail `pnpm format:check` as written. Run `pnpm exec prettier --write` on
> each new workflow/config before committing (M32.5, M32.6, M32.7 all add
> YAML). `mac-app.yml` was already conformant.

**Acceptance:** alerts endpoint returns 204; the config covers all three
ecosystems; update PRs will arrive gated by the same quality+e2e checks as
any PR.

---

### M32.4 — Ruleset on main, tag ruleset, immutable releases — witnessed in-repo

main is completely unprotected: the 2026-08-01 wipe-commit incident already
demonstrated the failure class, this machine runs many parallel worktrees
(the exact setup where a push from the wrong checkout happens), and two
long-lived divergent lines are going to merge someday. Depends on M32.1
(required checks bind to PR runs).

**Files**
- Create: `.github/SETUP.md`

- [x] **Step 1: Create the main ruleset**

```sh
gh api -X POST repos/JLagorio/cerebro/rulesets --input - <<'JSON'
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge", "squash"]
    }},
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "quality" },
          { "context": "e2e" }
        ]
    }}
  ],
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ]
}
JSON
```

Notes: `required_approving_review_count: 0` is deliberate — required reviews
are solo theater (you cannot approve your own PR). The check contexts are the
**job names** `quality` and `e2e` from mac-app.yml; if a job is ever renamed,
this ruleset must move in the same PR. `actor_id: 5` is the repository-admin
role; the bypass exists for emergencies and **using it is an incident** —
SETUP.md says so. If the API rejects a parameter name (`allowed_merge_methods`
has churned), drop that parameter and note it in SETUP.md; the load-bearing
rules are deletion, non_fast_forward, and the two required checks.

- [x] **Step 2: Create the tag ruleset**

```sh
gh api -X POST repos/JLagorio/cerebro/rulesets --input - <<'JSON'
{
  "name": "protect-release-tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "update" }
  ],
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ]
}
JSON
```

A `v*` tag, once pushed, can never be moved or deleted — the retag attack
(force-move `v1.0.0`, retroactively owning every re-downloader) dies here.

- [ ] **Step 3: Enable immutable releases, dry-run first**

Settings → General → Releases → enable **Immutable releases** (no stable API
surface for this toggle as of writing — it is settings-side; that is exactly
why SETUP.md exists). Then dry-run:

```sh
git tag v0.0.1-rc && git push origin v0.0.1-rc
# Bare `gh run watch` needs a TTY to pick a run — resolve the run id first:
sleep 15 && gh run watch "$(gh run list --event push --branch v0.0.1-rc -L1 \
  --json databaseId -q '.[0].databaseId')"
gh release view v0.0.1-rc --json isImmutable   # expect true
gh release delete v0.0.1-rc   # expect REFUSAL — that is the feature working
```

Leave the rc release in place (immutability means it stays; it is labeled rc
and harmless). If the single-step `action-gh-release` publish ever grows a
second attach step, switch to `draft: true` → attach → publish.

- [x] **Step 4: Witness every setting in `.github/SETUP.md`**

Tolaria's `.github/` contains four documented drifts between its setup prose
and its actual workflows — the lesson is that a setup doc may only be a
**checklist of externally-configured state**, never a restatement of what
YAML does. Create `.github/SETUP.md`:

```markdown
# Externally-configured state (not enforceable from the repo)

Settings live server-side; this checklist is their only in-repo witness.
If you change a setting, change this file in the same sitting. Do NOT
document workflow behaviour here — workflows document themselves inline.

- [x] Ruleset `protect-main`: deletion + non-fast-forward blocked; PRs
      required with checks `quality`, `e2e` (strict); 0 approvals
      (solo — reviews would be theater); admin bypass exists and
      **using it is an incident** — note the date and reason below.
- [x] Ruleset `protect-release-tags` on `v*`: no update/delete/move.
- [x] Immutable releases: ON (dry-run v0.0.1-rc verified immutable).
- [x] Dependabot alerts + security updates: ON (M32.3).
- [x] Secret scanning + push protection: ON (pre-existing).
- [x] Actions default workflow token: read-only (setting mirrors the
      workflow-level `permissions:` block — belt and suspenders).
- [x] Actions fork-PR policy: "Require approval for first-time
      contributors" (the default) — verified ON. PRs now execute
      PR-controlled code in quality/e2e; this setting is the approval
      gate in front of that.
- [ ] Private vulnerability reporting: verify ON; SECURITY.md points at it
      (M32.12).
- [ ] CodeQL default setup: ON, advisory (M32.5).

## Bypass log

(none)
```

- [x] **Step 5: Commit**

```sh
git add .github/SETUP.md
git commit -m "ci(governance): main and v* tags behind rulesets, releases immutable, settings witnessed (M32.4)"
git push
```

> **Executed 2026-08-15. Step 3 is NOT done — it needs a human at a browser.**
> Rulesets `protect-main` (20887280) and `protect-release-tags` (20887282)
> are live and every parameter was accepted, `allowed_merge_methods`
> included. `actor_id: 5` confirmed as the admin role
> (`current_user_can_bypass: always`).
>
> **Immutable releases has no API surface** — `PATCH /repos/{o}/{r}` with
> `immutable_releases` is a silent no-op and the field is not in the repo
> payload. It must be flipped in Settings → General → Releases. The
> `v0.0.1-rc` dry-run is deliberately NOT run until it is: tagging first
> would publish a MUTABLE release and burn the dry-run, and the tag
> ruleset now makes `v0.0.1-rc` permanent either way.
>
> Two SETUP.md boxes ship UNTICKED against the plan's template, on the
> plan's own honesty rule: immutable releases (above), and the Actions
> fork-PR policy, which the template claims is "verified ON" but is **not
> API-readable on a public repo** (`actions/permissions/access` → 422,
> no fork-pr-workflows endpoint). It needs an eyeball in Settings.
>
> Predicted-and-wrong, recorded so it isn't re-feared: enabling
> `strict_required_status_checks_policy` did NOT push PR #14 to `BEHIND`.
> It stayed `CLEAN`/`MERGEABLE` and merges without an update-branch step.

**Acceptance:** `gh api repos/JLagorio/cerebro/rulesets --jq '.[].name'`
lists both rulesets; a force-push to main is refused; a `v*` tag cannot be
deleted; the rc release is immutable; SETUP.md is the checklist and contains
no workflow prose.

---

### M32.5 — Scanner lane: zizmor + actionlint in CI, CodeQL default setup

M32.1/M32.2 fixed today's workflow; this keeps it fixed the next time YAML is
edited at 11pm. zizmor would have flagged the pre-M32 file on at least four
audits (unpinned-uses, ref-confusion, artipacked, cache-poisoning).

**Files**
- Create: `.github/workflows/scanners.yml`

- [x] **Step 1: Write the workflow**

```yaml
name: Workflow scanners

# Runs only when workflow files change. Scope is pinned to OUR .github —
# docs/examples/ vendors entire third-party repos including their own
# workflows, and a scanner that wanders in there fails on code we don't own
# (the M15.19 coverage lesson, still paying rent).
on:
  pull_request:
    paths: ['.github/**']
  push:
    branches: [main]
    paths: ['.github/**']

permissions:
  contents: read

jobs:
  zizmor:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      security-events: write   # SARIF into code scanning
      actions: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: zizmorcore/zizmor-action@3dc1ecc9bcb9e94e9b2c709687979e1298497054 # v0.6.2
        with:
          inputs: .github/workflows/

  actionlint:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - name: actionlint (version- and checksum-pinned)
        run: |
          curl -sSLo actionlint.tar.gz \
            https://github.com/rhysd/actionlint/releases/download/v1.7.10/actionlint_1.7.10_linux_amd64.tar.gz
          echo "f4c76b71db5755a713e6055cbb0857ed07e103e028bda117817660ebadb4386f  actionlint.tar.gz" | sha256sum -c -
          tar xzf actionlint.tar.gz actionlint
          ./actionlint -color .github/workflows/*.yml
```

If the zizmor action's input name differs at the pinned version (check its
README at that SHA), pass the path positionally or via the documented input —
the requirement that survives is: **zizmor sees `.github/workflows/` and
nothing else.**

- [x] **Step 2: Enable CodeQL default setup, advisory**

```sh
gh api -X PATCH repos/JLagorio/cerebro/code-scanning/default-setup \
  -f state=configured -f query_suite=default
```

Free on public repos; covers JS/TS, Rust (GA since Oct 2025, no-build
extraction — the webkit system-deps problem doesn't apply), and Actions
workflows. Clippy does no taint tracking; CodeQL's Rust queries cover
exactly Cerebro's attack surface shape (`mcp.rs` loopback server, `agent.rs`
subprocess spawn, `connectors.rs`). Advisory for the first month: findings
are read, not required checks. Tick the SETUP.md line.

- [x] **Step 3: Commit and watch both scanners run**

```sh
git add .github/workflows/scanners.yml .github/SETUP.md
git commit -m "ci(scanners): zizmor + actionlint on workflow changes, CodeQL default setup (M32.5)"
git push && gh pr checks --watch
```

Expected: both scanner jobs green against the already-hardened mac-app.yml.
If zizmor flags something M32.1/M32.2 missed, fix it in this commit — that
is the lane doing its job on day one.

> **Executed 2026-08-15. The lane did its job on day one, as hoped — and
> found two things this plan got wrong.**
>
> zizmor was run locally (`uvx zizmor@1.29.0`, no Docker needed) before
> pushing: **26 findings, 15 high.** Resolved as follows.
>
> 1. **`unpinned-uses` (10 high) contradicts M32.2's design.** zizmor's
>    blanket policy requires hash pins for `actions/*` too, which M32.2
>    deliberately exempted. Resolved zizmor's way — ALL actions are now
>    commit-pinned. M32.2's acceptance line ("only `actions/*` remain")
>    is superseded: `grep '@v[0-9]' .github/workflows/*.yml` is now empty.
>    Pinned to the **v4 line** (`checkout` v4.4.0, `setup-node` v4.4.0,
>    `upload-artifact` v4.6.2) — NOT to `latest`, which is now v7 for all
>    three. A triple major bump is a reviewable Dependabot PR, not
>    something a hardening commit smuggles in.
> 2. **`cache-poisoning` (5 high)** — suppressed inline with cause per
>    AGENTS.md ("suppressions carry reasons, in place"): quality/e2e ship
>    no bytes; the build job's two are the mitigation itself (no
>    `cache: pnpm`, rust-cache skipped on tags).
> 3. **`superfluous-actions` (1 info)** — suppressed with cause; a
>    `gh release` script step is not obviously safer than a pinned action.
>
> Post-fix: **"No findings to report (6 ignored, 10 suppressed)"**, and
> actionlint v1.7.12 exits 0 locally.
>
> **actionlint bumped 1.7.10 → 1.7.12** (1.7.10 is two releases stale).
> Both checksums were verified against rhysd's published
> `checksums.txt`; the plan's 1.7.10 hash was correct, and the shipped
> 1.7.12 hash is `8aca8db9…a3d8`.
>
> **CodeQL does NOT cover Rust.** The plan asserts Rust is GA in default
> setup; the API rejects it — allowed values are `actions, c-cpp, csharp,
> go, java-kotlin, javascript-typescript, python, ruby, swift` (422 on
> `rust`). Default setup is therefore `javascript-typescript` + `actions`
> only, and **the Rust attack surface named in this phase's rationale
> (`mcp.rs`, `agent.rs`, `connectors.rs`) gets no taint tracking from
> CodeQL.** Clippy still does no taint analysis either. Registered as a
> deferral in M32.12 rather than quietly dropped.

> **First CI run of the new lane caught a real pre-existing defect —
> and a hole in my local verification.** actionlint exited 0 locally but
> FAILED on the runner: `mac-app.yml` ran
> `pnpm tauri build --ci --target $TARGET` unquoted (SC2086), untouched
> since M14. The runner has **shellcheck** installed and this Mac did
> not, so every shellcheck-backed rule was silently skipped locally.
> Fixed to `"$TARGET"`; `brew install shellcheck` makes local actionlint
> match CI, and anyone verifying this lane by hand needs it installed or
> they are running a weaker linter than CI and will not know.
>
> CodeQL final state: `state=configured`,
> `languages=[actions, javascript-typescript]`, suite `default`.

**Acceptance:** scanners run on `.github/**` changes only; zizmor is scoped
away from vendored trees; actionlint is checksum-pinned; CodeQL default
setup shows `state: configured`.

---

### M32.6 — cargo-deny on a schedule

Dependabot alerts (M32.3) cover CVE notifications; cargo-deny adds what
Dependabot cannot: unmaintained/yanked crates, duplicate majors bloating the
universal binary, and **license compliance** — the DMG bundles LICENSE and
ships; GPL contamination in the binary is a shipping problem, not theory.

**Files**
- Create: `.github/workflows/cargo-deny.yml`
- Create: `deny.toml`

- [x] **Step 1: Write `deny.toml`**

```toml
# cargo-deny policy (M32.6). Advisory lane — a new CVE is time-triggered
# operational state, not a property of any commit, so this NEVER blocks a
# push and never enters the husky gate.

[graph]
all-features = true

[advisories]
version = 2
yanked = "deny"

[licenses]
version = 2
# Start from what the tree actually carries: the first run prints every
# license present; extend this list deliberately, one license at a time,
# never with a blanket allow. Copyleft in a shipped binary is the failure.
allow = [
  "MIT",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Zlib",
  "Unicode-3.0",
  "MPL-2.0",
  "CC0-1.0",
  "BSL-1.0",
]

[bans]
multiple-versions = "warn"

[sources]
unknown-registry = "deny"
unknown-git = "deny"
```

- [x] **Step 2: Run it locally once and reconcile the license list**

```sh
which cargo-deny >/dev/null || cargo install cargo-deny --locked
cd src-tauri && cargo deny check licenses advisories bans sources 2>&1 | tail -40
```

Expected: the licenses check names any license the tree carries that the
allow-list lacks. Add what is genuinely fine (say why, one comment per
addition); investigate anything copyleft before allowing it. Do not commit
until this passes locally.

- [x] **Step 3: Write the workflow**

```yaml
name: cargo-deny

# Weekly because advisories are time-triggered; on lockfile/policy change
# because those are the two commits that can introduce a violation.
on:
  schedule:
    - cron: '0 6 * * 1'
  pull_request:
    paths: ['src-tauri/Cargo.lock', 'deny.toml']
  workflow_dispatch:

permissions:
  contents: read

jobs:
  cargo-deny:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: EmbarkStudios/cargo-deny-action@3c6349835b2b7b196a839186cb8b78e02f7b5f25 # v2.1.1 (peeled commit)
        with:
          manifest-path: src-tauri/Cargo.toml
          command: check advisories licenses bans sources
```

- [x] **Step 4: Commit**

```sh
git add deny.toml .github/workflows/cargo-deny.yml
git commit -m "ci(deps): cargo-deny — advisories, licenses, dupes, on a schedule not in the gate (M32.6)"
git push
```

> **Executed 2026-08-15.** First local run: `advisories FAILED, bans ok,
> licenses FAILED, sources ok`. Both failures were more interesting than
> the plan expected, and neither was fixed by widening an allow-list.
>
> **Licenses: the plan's allow-list needed no additions at all.** Every
> dependency's license was already covered. The single failure was
> **our own crate** — `cerebro 0.1.0` had no `license` field, making it
> the one unlicensed node in its own graph. Fixed at the source:
> `license = "Apache-2.0"` in `src-tauri/Cargo.toml`, matching the
> Apache-2.0 LICENSE the DMG already bundles and ships. A real metadata
> gap, found by the lane on its first run.
>
> **Advisories: 16 distinct findings, ZERO vulnerabilities** — every one
> `unmaintained`, every one transitive and unfixable from here: 10 gtk-rs
> GTK3 bindings (Linux-only tauri deps macOS never compiles), the 5
> `unic-*` crates via tauri-utils → urlpattern (RUSTSEC-2025-0098,
> upstream: "no safe upgrade is available"), and proc-macro-error.
> Resolved with `[advisories] unmaintained = "workspace"` — vulnerability
> and yanked findings stay hard errors, while unmaintained is scoped to
> crates this workspace names itself. Sixteen dated ignore ids would rot
> silently as tauri's tree moves; the reasoning is written in deny.toml.
>
> Final: `advisories ok, bans ok, licenses ok, sources ok`. `Cargo.lock`
> is untouched by the license field, and fmt/clippy stay green.

**Acceptance:** local `cargo deny check` passes; the workflow runs weekly and
on lockfile changes; the job is not a required check and not in husky, with
the reason written in both files.

---

### M32.7 — Release provenance, and the hygiene sweep

Today a user holding `Cerebro.dmg` has no way to check it was built by this
repo's CI from a given commit — no notarization, ad-hoc signature, and the
release notes train them to strip quarantine. Provenance attestation is the
whole integrity story available without an Apple account; say so honestly.

**Files**
- Modify: `.github/workflows/mac-app.yml`
- Modify: `.gitignore`
- Create: `.github/ISSUE_TEMPLATE/bug.yml`
- Modify: `playwright.config.ts`
- Modify: `AGENTS.md`

- [ ] **Step 1: Attest the shipped bytes**

In the `build` job: extend its `permissions` block and add a step **after**
"Sign and package" (attested bytes must be shipped bytes) and before the
artifact upload:

```yaml
    permissions:
      contents: write
      id-token: write        # provenance attestation (M32.7)
      attestations: write
```

```yaml
      - name: Attest build provenance (tags only)
        if: startsWith(github.ref, 'refs/tags/v')
        uses: actions/attest-build-provenance@v4
        with:
          subject-path: dist-mac/*
```

- [ ] **Step 2: Put the verify one-liner where the quarantine instructions are**

In the release body (lines 171–183), after the `xattr` code block, add:

```
    You can verify this DMG was built by this repository's CI from the
    tagged commit (requires the GitHub CLI):

    ```
    gh attestation verify Cerebro.dmg -R JLagorio/cerebro
    ```
```

Same audience, and it partially redeems the quarantine instruction it sits
next to.

- [ ] **Step 3: `.gitignore` the future secret**

Add to `.gitignore`:

```
.env
.env.*
```

The app's architecture needs no secrets today; this is for the first day
that stops being true.

- [ ] **Step 4: One issue template — the one that isn't theater**

Create `.github/ISSUE_TEMPLATE/bug.yml`:

```yaml
name: Bug report
description: Something broke in the app
body:
  - type: input
    id: macos
    attributes:
      label: macOS version
      placeholder: "e.g. 15.5 (Apple Silicon)"
    validations:
      required: true
  - type: input
    id: version
    attributes:
      label: Cerebro version
      placeholder: "release tag, or 'built from main at <sha>'"
    validations:
      required: true
  - type: textarea
    id: what
    attributes:
      label: What happened
      description: What did you do, what did you expect, what happened instead?
    validations:
      required: true
  - type: textarea
    id: vault
    attributes:
      label: Vault shape (if relevant)
      description: Rough size and anything unusual — no contents needed.
```

- [ ] **Step 5: The e2e reuse knob — configuration instead of ritual**

AGENTS.md documents a trap: `reuseExistingServer` silently attaches to a dev
server another worktree is holding, and the suite runs against a different
branch's app. Convert the documented `lsof` ritual into configuration.
**This deliberately changes the default dev workflow** — that is the point,
and AGENTS.md moves in the same commit.

In `playwright.config.ts`, the `webServer` block's `reuseExistingServer`
line (line 19 on origin/main — find it by content, the m22-m28 branch's copy
sits at a different line) changes:

```ts
    // Reuse is OPT-IN (M32.7): a busy port now fails loudly instead of
    // silently testing another worktree's branch. Set CEREBRO_E2E_REUSE=1
    // to attach to a dev server you know is yours.
    reuseExistingServer: !process.env.CI && process.env.CEREBRO_E2E_REUSE === '1',
```

(CI is unaffected: the workflow exports `CI=true`, which already disabled
reuse there.)

In `AGENTS.md` (origin/main's copy — it has no port-trap paragraph; that
text lives only on the m22-m28 branch): update the commands-table E2E row to

```
| E2E | `pnpm e2e` | Playwright; starts its own server. `CEREBRO_E2E_REUSE=1` to reuse yours; `PORT=...` to isolate |
```

and ADD a short paragraph to the e2e/verification guidance: reuse is opt-in
since M32.7; a busy port fails loudly with "port … is used"; set
`CEREBRO_E2E_REUSE=1` only when the running server is yours (a port held by
another worktree used to be silently reused, running the suite against a
different branch's app).

- [ ] **Step 6: Verify and commit**

```sh
pnpm e2e --list >/dev/null 2>&1 || PORT=5573 pnpm exec playwright test --list | head -3
git add -A
git commit -m "ci(release): provenance attestation, and the hygiene sweep — env ignore, bug template, e2e reuse knob (M32.7)"
git push && gh pr checks --watch
```

**Acceptance:** tag builds emit an attestation for `dist-mac/*`; the release
body carries the verify command; `.env*` ignored; bug template renders; e2e
reuse is opt-in and AGENTS.md says so.

---

# Track B — mounted repos get their git surface

### M32.8 — Root-scoped read-only git commands (Rust)

M30 probes `RootCaps.git` and then nothing consumes it: all ~26 git commands
take `vault: String`. This phase gives mounted roots the read surface —
status, branch, ahead/behind, recent commits, file URL — gated on the
capability, refusing typed. `git::workspace_for` already resolves any path
to its real git root (it handles vault-inside-repo nesting), so this is a
command surface, not a git-module rewrite.

**Files**
- Modify: `src-tauri/src/roots/mod.rs` (the capability gate + refusal type)
- Create: `src-tauri/src/roots_git_commands.rs`
- Modify: `src-tauri/src/lib.rs` (command registration)

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/roots/mod.rs` under the existing `mod tests`:

Fixture rules, which apply to EVERY Rust test in Track B: `tempfile` is NOT
a dependency of this crate (`Cargo.toml` has no `[dev-dependencies]` at all)
— scratch dirs come from `crate::vault::testutil::temp_vault(label)` like
the existing `roots::tests`; and repositories are built through the crate's
env-scrubbed helpers (`crate::git::commit::init_repo`, `command::run_str`),
**never** bare `std::process::Command::new("git")` — command.rs's
`REPO_SELECTING_VARS` comment records what raw git in tests under a
hook-exported `GIT_DIR` did to this repo, three times. There are zero raw
git spawns in `src-tauri` today; keep it that way. (If `temp_vault`'s exact
name differs, mirror whatever the existing `roots::tests` fixtures in this
same file use — those two constraints are the requirement.)

```rust
#[test]
fn a_root_that_is_not_a_repo_refuses_git_typed() {
    let config = crate::vault::testutil::temp_vault("m32-gate-config");
    let plain = crate::vault::testutil::temp_vault("m32-gate-plain");
    let root = mount(&config, plain.to_str().unwrap()).unwrap();
    let err = git_workspace(&config, &root.id).unwrap_err();
    assert_eq!(err.code, "no_git_capability");
}

#[test]
fn an_unknown_root_id_refuses_typed_not_stringly() {
    let config = crate::vault::testutil::temp_vault("m32-gate-unknown");
    let err = git_workspace(&config, "no-such-id").unwrap_err();
    assert_eq!(err.code, "no_such_root");
}

#[test]
fn a_mounted_repo_resolves_to_its_git_workspace() {
    let config = crate::vault::testutil::temp_vault("m32-gate-repo-config");
    let repo = crate::vault::testutil::temp_vault("m32-gate-repo");
    crate::git::commit::init_repo(&repo).unwrap();
    let root = mount(&config, repo.to_str().unwrap()).unwrap();
    let ws = git_workspace(&config, &root.id).unwrap();
    assert!(ws.is_repo());
}
```

- [ ] **Step 2: Run them and watch them fail**

```sh
cd src-tauri && cargo test --lib roots::tests::a_root_that_is_not_a_repo
```

Expected: FAIL — `cannot find function git_workspace`.

- [ ] **Step 3: Implement the gate in `roots/mod.rs`**

Beside `MountRefusal` (same contract, its own type — a git refusal is not a
mount refusal, and sharing the type would let a UI match arm silently accept
codes it never handles):

```rust
/// A git-surface refusal the UI is expected to READ and act on — the same
/// contract as `MountRefusal`. Codes: `no_such_root`, `no_git_capability`,
/// `config_unavailable`, `git_error`, and (from M32.11's mutation gate)
/// `parent_repo`. The mock's parity test drives every browser-reachable one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootGitRefusal {
    pub code: String,
    pub message: String,
}

impl RootGitRefusal {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
}

/// Resolve a mounted root to its git workspace — the capability gate every
/// root-scoped git command goes through. Capability is re-probed live (the
/// stored `caps` snapshot can be stale: a repo `git init`ed after mount is
/// a repo now).
pub fn git_workspace(
    config_dir: &Path,
    root_id: &str,
) -> Result<crate::git::workspace::GitWorkspaceInfo, RootGitRefusal> {
    let root = find(config_dir, root_id).ok_or_else(|| {
        RootGitRefusal::new("no_such_root", format!("no mounted root with id {root_id}"))
    })?;
    let ws = crate::git::workspace_for(&root.path);
    if !ws.is_repo() {
        return Err(RootGitRefusal::new(
            "no_git_capability",
            format!("{} is not a git repository", root.label),
        ));
    }
    Ok(ws)
}
```

- [ ] **Step 4: The command surface**

Create `src-tauri/src/roots_git_commands.rs`:

```rust
//! Root-scoped git reads (M32.8). M30 mounted the roots and probed
//! `caps.git`; this is the first consumer. READ-ONLY by design in this
//! phase — mutations arrive in M32.11 with typed outcomes, and work-repo
//! commit/push is a policy-layer milestone, not this one.

use tauri::Manager;

use crate::git;
use crate::git::pulse::PulseCommit;
use crate::git::remote::GitRemoteStatus;
use crate::git::status::ModifiedFile;
use crate::git::workspace::GitWorkspaceInfo;
use crate::roots::RootGitRefusal;

fn workspace(
    app: &tauri::AppHandle,
    root_id: &str,
) -> Result<GitWorkspaceInfo, RootGitRefusal> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| RootGitRefusal::new("config_unavailable", e.to_string()))?;
    crate::roots::git_workspace(&dir, root_id)
}

#[tauri::command(async)]
pub fn root_git_workspace_info(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<GitWorkspaceInfo, RootGitRefusal> {
    workspace(&app, &root_id)
}

#[tauri::command(async)]
pub fn root_git_remote_status(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<GitRemoteStatus, RootGitRefusal> {
    let ws = workspace(&app, &root_id)?;
    git::remote::remote_status(&ws).map_err(|e| RootGitRefusal::new("git_error", e))
}

#[tauri::command(async)]
pub fn root_git_modified_files(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<Vec<ModifiedFile>, RootGitRefusal> {
    let ws = workspace(&app, &root_id)?;
    git::status::modified_files(&ws).map_err(|e| RootGitRefusal::new("git_error", e))
}

#[tauri::command(async)]
pub fn root_git_pulse(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<Vec<PulseCommit>, RootGitRefusal> {
    let ws = workspace(&app, &root_id)?;
    git::pulse::vault_pulse(&ws, 50).map_err(|e| RootGitRefusal::new("git_error", e))
}

#[tauri::command(async)]
pub fn root_git_file_url(
    app: tauri::AppHandle,
    root_id: String,
    path: String,
) -> Result<Option<String>, RootGitRefusal> {
    let ws = workspace(&app, &root_id)?;
    Ok(git::file_url(&ws, &path))
}
```

Register in `lib.rs` directly after the `roots_commands::` block. Note:
`roots_commands::read_file_text` at line 419 is currently the LAST entry and
has **no trailing comma** — add one before appending, or the macro won't
parse:

```rust
            roots_git_commands::root_git_workspace_info,
            roots_git_commands::root_git_remote_status,
            roots_git_commands::root_git_modified_files,
            roots_git_commands::root_git_pulse,
            roots_git_commands::root_git_file_url,
```

and add `pub mod roots_git_commands;` beside `pub mod roots_commands;`.

- [ ] **Step 5: Gate and commit**

```sh
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
git add -A && git commit -m "feat(roots): mounted repos get their read-only git surface, refusing typed (M32.8)"
```

**Acceptance:** three tests pin the gate (unknown id, non-repo, repo); five
commands exist and are registered; every refusal carries a matchable code;
no command mutates anything.

---

### M32.9 — Workspace git UI, and the mock refuses everything Rust refuses

Surface M32.8 in the workspace tree. Design vocabulary from tolaria ADR-0114,
which matches Cerebro's own "nothing speaks first": classify every feature as
union-graph or focused-repo behaviour, and show provenance/badges **only when
they disambiguate** — a root's git badge appears when the root is a repo,
never as noise on the single-vault case.

**Files**
- Modify: `src/stores/rootsStore.ts` (+ its test)
- Modify: `src/workspace/RootTree.tsx` (+ its test)
- Modify: `src/lib/mockRoots.ts` (+ its test), `src/lib/mockIpc.ts` if root
  commands route through it (follow M30's wiring — check where
  `list_roots`/`read_file_text` are mocked and put the five `root_git_*`
  handlers in the same place)
- Modify: `e2e/workspace.spec.ts`

- [ ] **Step 1: Write the failing store test**

In `src/stores/rootsStore.test.ts`, following the file's existing fixture
style (M30 wrote these tests — mirror them):

```ts
it('loads git status for a repo root and keeps refusals as values', async () => {
  // mockRoots: one root with caps.git=true, one without
  const store = useRootsStore.getState();
  await store.loadGitStatus('root-with-git');
  expect(useRootsStore.getState().gitStatus['root-with-git']?.branch).toBe('main');

  await store.loadGitStatus('root-without-git');
  const refusal = useRootsStore.getState().gitRefusals['root-without-git'];
  expect(refusal?.code).toBe('no_git_capability');   // read, not toasted
});
```

- [ ] **Step 2: Watch it fail, then implement**

Store shape: `gitStatus: Record<string, GitRemoteStatus>` and
`gitRefusals: Record<string, RootGitRefusal>` (camelCase over the wire —
the Rust types serialize `rename_all = "camelCase"`). `loadGitStatus`
invokes `root_git_remote_status`; a refusal is **stored, not thrown and not
toasted** — the typed-refusal exemption to the store-layer rule, same as
M30's mount flow. Only a transport-level failure (invoke itself rejecting
with a non-refusal) follows the human-UI rule: catch, toast, null.

- [ ] **Step 3: Mock parity, tested**

`mockRoots.ts` gains the five `root_git_*` handlers. Parity means the mock
can **actually emit** what Rust emits — a test comparing two hand-written
string lists is a tautology that passes while the mock mirrors nothing. Of
the Rust surface's codes: `no_such_root` (unknown id) and
`no_git_capability` (mock root without a git fixture) fall out of the
handlers; `git_error` needs a seedable failure (a per-root
`failNextGitCall` flag on the mock fixture, the same style as mockGit's
existing failure knobs if it has them — otherwise a module-level setter);
`config_unavailable` is Rust-transport-only (no config dir exists in a
browser) and is documented as such rather than faked. The parity test
DRIVES each emission:

```ts
it('the mock emits every refusal the Rust surface can emit', async () => {
  // no_such_root
  expect((await mockRootGitRemoteStatus('nope')).error?.code).toBe('no_such_root');
  // no_git_capability — a mounted mock root with no git fixture
  expect((await mockRootGitRemoteStatus(plainRootId)).error?.code).toBe('no_git_capability');
  // git_error — seeded
  seedRootGitFailure(repoRootId);
  expect((await mockRootGitRemoteStatus(repoRootId)).error?.code).toBe('git_error');
  // config_unavailable is Rust-transport-only (no config dir in the
  // browser); every other Rust code is emitted above. Keep this comment
  // next to the Rust code list in roots/mod.rs when either side changes.
});
```

(Adapt the call/return shape to how mockRoots actually surfaces refusals —
the requirement is one driven emission per reachable code, not this exact
API.) Mock roots carry a `caps.git` flag and a small canned
`GitRemoteStatus`/`PulseCommit[]` fixture.

- [ ] **Step 4: The badge**

`RootTree.tsx`: on a root row whose status is loaded, render branch name +
dirty-count + ahead/behind as a quiet inline badge (follow the tree's
existing styling idiom; `getByTestId`-friendly `data-testid="root-git-badge"`).
No badge when the root is not a repo, when status is not yet loaded, or when
everything is clean and in sync with no counts to show — nothing speaks
first. Mind the existing `unavailable(row)` check at `RootTree.tsx:119`: it
keys on `!caps.writable && !caps.git` to render a vanished-directory root —
an unavailable root gets that rendering and never a git badge; do not let
the badge logic double-read `caps.git` in a way that changes it.

- [ ] **Step 5: e2e**

Extend `e2e/workspace.spec.ts` using **its own local `boot()` helper** —
that is origin/main's convention (there is NO `e2e/boot.ts` on main; that
file exists only on the m22-m28 branch, and creating one here would collide
at merge time; origin/main's AGENTS.md says "copy an existing spec's boot").
Mount a mock repo root, expect the badge with the mocked branch name; mount
a non-repo root, expect no badge and no error toast.

- [ ] **Step 6: Full gate (TS side ratchets!), commit**

```sh
pnpm lint && pnpm typecheck && pnpm test:run && pnpm test:coverage
p=5573; lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null && echo "$p BUSY" || PORT=$p pnpm e2e
git add -A && git commit -m "feat(workspace): root git badges, refusals read as values, mock parity tested (M32.9)"
```

**Acceptance:** store keeps refusals as values; mock emits exactly the Rust
refusal set and a test proves it; badge renders only when it disambiguates;
e2e covers repo and non-repo roots; coverage ratchet still green.

---

### M32.10 — Git plumbing depth: credentials probe, upstream, hardened spawn

The two modules that gate reliable per-root sync, ported in spirit from the
vendored reference (tolaria `credentials.rs`/`upstream.rs`), plus the
non-interactive hardening flags Cerebro's spawn doesn't set yet. Auth stays
system-git only (ADR-0056): we **predict** whether auth will work; we never
store anything.

**Files**
- Create: `src-tauri/src/git/credentials.rs`
- Create: `src-tauri/src/git/upstream.rs`
- Modify: `src-tauri/src/git/mod.rs` (module declarations)
- Modify: `src-tauri/src/git/command.rs` (the `GIT_CONFIG_PARAMETERS` line)

- [ ] **Step 1: Failing test for the hardened spawn**

In `src-tauri/src/git/command.rs` tests:

Fixture rules from M32.8 apply (no `tempfile`, no raw git spawns — use
`crate::vault::testutil::temp_vault` + `crate::git::commit::init_repo`,
matching the hand-rolled scratch-dir style command.rs's own env_tests use):

```rust
#[test]
fn spawned_git_carries_the_protocol_pins() {
    let dir = crate::vault::testutil::temp_vault("m32-pins");
    crate::git::commit::init_repo(&dir).unwrap();
    // GIT_CONFIG_PARAMETERS entries are visible to `git config` inside the
    // spawned process — that is the property we rely on.
    let v = run_str(&dir, &["config", "protocol.ext.allow"]).unwrap();
    assert_eq!(v.trim(), "never");
    let v = run_str(&dir, &["config", "core.fsmonitor"]).unwrap();
    assert_eq!(v.trim(), "false");
    let v = run_str(&dir, &["config", "core.hooksPath"]).unwrap();
    assert_eq!(v.trim(), "/var/empty");
}
```

- [ ] **Step 2: Watch it fail, then extend the env line**

`command.rs` line 88 becomes:

```rust
    // M32.10 — protocol pins ride the same env: `ext::` transports are
    // arbitrary command execution and are never legitimate here; `file://`
    // stays user-initiated only; fsmonitor daemons have no business being
    // started by an app that spawns git on a timer; and a repository's own
    // hooks NEVER run under Cerebro-spawned git — fetch fires
    // reference-transaction hooks and pull fires post-merge, which in a
    // mounted repo is running that repo's code. /var/empty exists and holds
    // nothing on macOS; command-scope config outranks repo-local.
    cmd.env(
        "GIT_CONFIG_PARAMETERS",
        "'core.quotepath=false' 'protocol.ext.allow=never' 'protocol.file.allow=user' 'core.fsmonitor=false' 'core.hooksPath=/var/empty'",
    );
```

Judgment call, recorded: the hooks pin applies to **vault** git flows too —
deliberately. An app auto-committing on a timer must never hang on, or
execute, a repo's hook; a user who wants their vault's hooks runs git
themselves. Residual vectors that CANNOT be pinned off without breaking
legitimate auth, written down so nobody thinks they were missed:
`credential.helper` and `core.sshCommand` in a mounted repo's `.git/config`
still execute during an authenticated fetch/pull — an empty
`credential.helper` pin would reset the helper LIST and kill the user's
keychain helper. Mounting a repository is trusting its `.git/config`;
M32.12's SECURITY.md text says exactly that.

- [ ] **Step 3: Credentials probe** (new module; its tests land in the same
step — there is no meaningful pre-implementation fail run for a new file,
so this step does not claim one)

Create `src-tauri/src/git/credentials.rs`:

```rust
//! Can this workspace authenticate to its remote BEFORE we try? (M32.10)
//!
//! `remote::classify` diagnoses auth failure after the fact; for a mounted
//! work repo the user didn't configure through us, an answer up front is
//! the difference between a sync button that works and one that fails with
//! a good error. We ask git's own credential machinery and store nothing —
//! ADR-0056 posture: system git owns auth.
//!
//! Two hardening properties, both load-bearing:
//! - `credential fill` runs from a NEUTRAL cwd, never inside the mounted
//!   repo. Git discovers a repo from cwd and honors its local config there
//!   — including a repo-declared `credential.helper`, which is arbitrary
//!   command execution ordered by a repo Cerebro does not own. From a
//!   non-repo cwd only the user's global/system helpers are consulted,
//!   which is exactly the question we are asking.
//! - A URL carrying control characters is never written into the
//!   credential protocol (the CVE-2020-5260 injection class: a config value
//!   with embedded newlines could smuggle extra `host=`/`password=` lines).

use super::command;
use super::workspace::GitWorkspaceInfo;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialReadiness {
    /// A helper answered with a credential for the remote's host.
    Ready,
    /// No remote configured — nothing to authenticate against.
    NoRemote,
    /// HTTPS remote and no helper produced a credential.
    NoHelper,
    /// SSH remote: we do not probe (an ssh connection attempt is
    /// observable by the server; a probe that phones home is not a probe).
    /// The UI treats this as "try and see".
    Unknown,
}

pub fn probe(ws: &GitWorkspaceInfo) -> CredentialReadiness {
    let dir = ws.dir();
    let url = match command::run_str(&dir, &["remote", "get-url", "origin"]) {
        Ok(u) => u.trim().to_string(),
        Err(_) => return CredentialReadiness::NoRemote,
    };
    if url.bytes().any(|b| b < 0x20) {
        // A config value can embed newlines via quoted escapes; refusing
        // control characters keeps the credential protocol un-smuggleable.
        return CredentialReadiness::Unknown;
    }
    if url.starts_with("git@") || url.starts_with("ssh://") {
        return CredentialReadiness::Unknown;
    }
    // `git credential fill` consults the configured helpers without
    // touching the network. Prompting is already disabled by
    // command::git_command (GIT_TERMINAL_PROMPT=0, empty ASKPASS), so a
    // helperless setup fails fast instead of hanging. NEUTRAL cwd — see
    // the module doc; the repo's own credential.helper must never run.
    let neutral = std::env::temp_dir();
    let mut child = match command::git_at(&neutral)
        .args(["credential", "fill"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return CredentialReadiness::Unknown,
    };
    use std::io::Write;
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = write!(stdin, "url={url}\n\n");
    }
    match child.wait_with_output() {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            if text.lines().any(|l| l.starts_with("password=")) {
                CredentialReadiness::Ready
            } else {
                CredentialReadiness::NoHelper
            }
        }
        _ => CredentialReadiness::NoHelper,
    }
}
```

Tests (same file, fixture rules from M32.8 — no tempfile, no raw git; do
not test the `Ready` arm against the developer's real keychain — the
deterministic arms pin the shape; the helper interaction is exercised
manually in Step 6):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn repo(label: &str) -> std::path::PathBuf {
        let dir = crate::vault::testutil::temp_vault(label);
        crate::git::commit::init_repo(&dir).unwrap();
        dir
    }

    #[test]
    fn no_remote_probes_to_no_remote() {
        let dir = repo("m32-cred-none");
        let ws = crate::git::workspace::resolve(&dir);
        assert_eq!(probe(&ws), CredentialReadiness::NoRemote);
    }

    #[test]
    fn ssh_remotes_are_not_probed() {
        let dir = repo("m32-cred-ssh");
        let ws = crate::git::workspace::resolve(&dir);
        command::run_str(&ws.dir(), &["remote", "add", "origin", "git@github.com:x/y.git"])
            .unwrap();
        assert_eq!(probe(&ws), CredentialReadiness::Unknown);
    }

    #[test]
    fn a_url_with_control_characters_is_refused_not_probed() {
        let dir = repo("m32-cred-hostile");
        let ws = crate::git::workspace::resolve(&dir);
        // git config accepts quoted escapes; simulate the decoded result by
        // configuring the value directly.
        command::run_str(
            &ws.dir(),
            &["config", "remote.origin.url", "https://x.test/a\nhost=evil.test"],
        )
        .unwrap();
        assert_eq!(probe(&ws), CredentialReadiness::Unknown);
    }
}
```

- [ ] **Step 4: Upstream management** (new module; tests land with it, same
as Step 3)

Create `src-tauri/src/git/upstream.rs`:

```rust
//! Tracking-branch management (M32.10). `remote_status` reports
//! has_upstream; this is the write half — a mounted repo whose branch
//! tracks nothing cannot fetch/pull meaningfully, and "set it up" beats
//! "go run git commands yourself".

use super::command;
use super::workspace::GitWorkspaceInfo;

/// Point the current branch at origin/<branch>. Fails typed-stringly (the
/// caller wraps it) when the remote branch does not exist — we do NOT
/// create remote branches from here; that is push territory.
pub fn set_upstream_to_origin(ws: &GitWorkspaceInfo, branch: &str) -> Result<(), String> {
    command::run_str(
        &ws.dir(),
        &["branch", &format!("--set-upstream-to=origin/{branch}"), branch],
    )
    .map(|_| ())
}
```

Test: the deterministic negative arm. The fixture needs a real commit —
`--set-upstream-to` on an unborn branch fails for a different reason ("no
commit on branch") and would pin the wrong failure. Seed identity + commit
through the scrubbed helpers, read the actual branch name (init default
varies by git config), and assert the error names the missing remote ref:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_to_a_missing_remote_branch_fails_naming_the_ref() {
        let dir = crate::vault::testutil::temp_vault("m32-upstream");
        crate::git::commit::init_repo(&dir).unwrap();
        let ws = crate::git::workspace::resolve(&dir);
        command::run_str(&ws.dir(), &["config", "user.email", "t@example.com"]).unwrap();
        command::run_str(&ws.dir(), &["config", "user.name", "t"]).unwrap();
        command::run_str(&ws.dir(), &["commit", "--allow-empty", "-m", "seed"]).unwrap();
        let branch = command::run_str(&ws.dir(), &["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap()
            .trim()
            .to_string();
        let err = set_upstream_to_origin(&ws, &branch).unwrap_err();
        assert!(
            err.contains(&format!("origin/{branch}")),
            "the failure names the missing ref: {err}"
        );
    }
}
```

(If `init_repo` already configures a committer identity, the two config
lines are harmless overrides — keep them; the test must not depend on the
machine's global git config.)

- [ ] **Step 5: Declare the modules**

In `git/mod.rs`, beside the existing declarations:

```rust
pub mod credentials;
pub mod upstream;
```

- [ ] **Step 6: Manual probe check, gate, commit**

```sh
cd src-tauri && cargo test --lib git::
# Manual, once: in any real HTTPS-remote repo on this machine, a debug call
# to credentials::probe should return Ready (osxkeychain helper).
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
git add -A && git commit -m "feat(git): credential readiness probe, upstream management, protocol pins (M32.10)"
```

**Acceptance:** every spawned git carries the three protocol pins and a test
proves it; `probe` never stores anything and never touches the network for
ssh; upstream setup exists with its negative arm tested.

---

### M32.11 — Per-root fetch and fast-forward pull, outcomes read not toasted

The first mutations on mounted roots — deliberately the low-risk pair.
`--ff-only` means Cerebro can never create a conflict in a repo it doesn't
own; anything that would need a merge reports `Rejected` and the user
resolves it in their own tooling. The `RemoteResult` contract is the
proposal-channel exemption in AGENTS.md: the caller READS the outcome.

**Files**
- Modify: `src-tauri/src/git/remote.rs`
- Modify: `src-tauri/src/roots_git_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/stores/rootsStore.ts`, `src/workspace/RootTree.tsx`,
  `src/lib/mockRoots.ts` (+ tests), `e2e/workspace.spec.ts`

- [ ] **Step 1: Failing tests for the two new remote operations**

Honesty about the starting point: `remote.rs`'s test module today is **four
string-input tests of `classify()`** — no repo fixtures, no clones, no
pull/push tests, nothing to mirror. `diverged_fixture()` is new code,
written in the tests module under the M32.8 fixture rules (temp_vault +
init_repo + `command::run_str`; never bare `Command::new("git")`): init an
upstream repo, seed identity + one `--allow-empty` commit, clone it **by
filesystem path** (`command::run_str(&parent, &["clone", up_path, dest_path])`
— a path argument, not a `file://` URL; M32.10's `protocol.file.allow=user`
permits direct user-context use), then one more commit on each side. Return
the clone's workspace (paths under temp_vault need no guard object). Add
`use crate::git::workspace;` to the tests module for the resolver.

```rust
#[test]
fn fetch_with_no_remote_is_no_remote_not_error() {
    let dir = crate::vault::testutil::temp_vault("m32-fetch-none");
    crate::git::commit::init_repo(&dir).unwrap();
    let ws = workspace::resolve(&dir);
    assert_eq!(fetch(&ws).status, RemoteOutcome::NoRemote);
}

#[test]
fn a_diverged_pull_ff_reports_rejected_and_changes_nothing() {
    // upstream and local each gain a commit → --ff-only must refuse.
    let ws = diverged_fixture("m32-diverged");
    let before = command::run_str(&ws.dir(), &["rev-parse", "HEAD"]).unwrap();
    let result = pull_ff(&ws);
    assert_eq!(result.status, RemoteOutcome::Rejected);
    let after = command::run_str(&ws.dir(), &["rev-parse", "HEAD"]).unwrap();
    assert_eq!(before, after, "a refused fast-forward must not move HEAD");
}
```

- [ ] **Step 2: Implement `fetch` and `pull_ff`**

In `remote.rs`, following `pull`'s existing shape (run, then `classify`
stderr into an outcome):

```rust
/// `git fetch origin` — updates remote-tracking refs, touches nothing
/// local. The safe half of sync, offered on mounted roots first.
pub fn fetch(ws: &GitWorkspaceInfo) -> RemoteResult {
    if !has_remote(ws) {
        return RemoteResult::plain(RemoteOutcome::NoRemote, "No remote configured");
    }
    match command::run(&ws.dir(), &["fetch", "origin"]) {
        Ok(_) => RemoteResult::plain(RemoteOutcome::Updated, "Fetched"),
        Err(failure) => {
            let (status, message) = classify(&failure.message());
            RemoteResult::plain(status, message)
        }
    }
}

/// `git pull --ff-only`. A pull that would need a merge is REFUSED —
/// Cerebro never creates a conflict in a repo it does not own. Divergence
/// reports Rejected with git's own explanation; the user resolves it in
/// their own tooling.
pub fn pull_ff(ws: &GitWorkspaceInfo) -> RemoteResult {
    if !has_remote(ws) {
        return RemoteResult::plain(RemoteOutcome::NoRemote, "No remote configured");
    }
    match command::run(&ws.dir(), &["pull", "--ff-only", "origin"]) {
        Ok(out) => {
            if out.contains("Already up to date") {
                RemoteResult::plain(RemoteOutcome::UpToDate, "Already up to date")
            } else {
                RemoteResult::plain(RemoteOutcome::Updated, "Fast-forwarded")
            }
        }
        Err(failure) => {
            let msg = failure.message();
            if msg.contains("Not possible to fast-forward")
                || msg.contains("not possible to fast-forward")
                || msg.contains("have diverged")
            {
                return RemoteResult::plain(
                    RemoteOutcome::Rejected,
                    "Local and remote have diverged; resolve outside Cerebro",
                );
            }
            let (status, message) = classify(&msg);
            RemoteResult::plain(status, message)
        }
    }
}
```

(Judgment call, recorded here: divergence maps to the existing
`RemoteOutcome::Rejected` rather than a new variant — the TS side matches
on the closed set of snake_case strings, and a new variant would ripple
through every consumer for one message's worth of nuance. Revisit only if
the UI needs to *act* differently on divergence vs push-rejection.)

- [ ] **Step 3: The nested-mount gate, commands, registration, UI**

A mounted root can sit INSIDE a larger repository —
`workspace::resolve` walks up and returns
`GitRootRelation::Parent`, and `GitWorkspaceInfo::dir()` is then the
**enclosing** repo. Reads are fine (status is pathspec-scoped; branch info
is honest display). But fetch/pull would mutate the whole parent repo —
everything outside the mounted scope. Mutations therefore require the root
to BE the repo root. Add the gate beside `git_workspace` in `roots/mod.rs`,
plus its test:

```rust
/// The mutation gate: like `git_workspace`, but additionally refuses roots
/// mounted inside a larger repository — sync there would act on a repo the
/// user never mounted. New code: `parent_repo`.
pub fn git_workspace_for_sync(
    config_dir: &Path,
    root_id: &str,
) -> Result<crate::git::workspace::GitWorkspaceInfo, RootGitRefusal> {
    let ws = git_workspace(config_dir, root_id)?;
    if ws.git_root_relation != crate::git::workspace::GitRootRelation::Vault {
        return Err(RootGitRefusal::new(
            "parent_repo",
            "this root sits inside a larger repository; syncing would act on \
             the whole repo — run git there yourself",
        ));
    }
    Ok(ws)
}
```

```rust
#[test]
fn sync_on_a_subfolder_mount_refuses_parent_repo() {
    let config = crate::vault::testutil::temp_vault("m32-sync-config");
    let repo = crate::vault::testutil::temp_vault("m32-sync-parent");
    crate::git::commit::init_repo(&repo).unwrap();
    let sub = repo.join("nested");
    std::fs::create_dir(&sub).unwrap();
    let root = mount(&config, sub.to_str().unwrap()).unwrap();
    assert_eq!(
        git_workspace_for_sync(&config, &root.id).unwrap_err().code,
        "parent_repo"
    );
    // The read gate still resolves it — reads are pathspec-scoped.
    assert!(git_workspace(&config, &root.id).is_ok());
}
```

Update `RootGitRefusal`'s doc-comment code list (M32.8) to include
`parent_repo`. Two commands in `roots_git_commands.rs`, on the SYNC gate:

```rust
fn sync_workspace(
    app: &tauri::AppHandle,
    root_id: &str,
) -> Result<GitWorkspaceInfo, RootGitRefusal> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| RootGitRefusal::new("config_unavailable", e.to_string()))?;
    crate::roots::git_workspace_for_sync(&dir, root_id)
}

#[tauri::command(async)]
pub fn root_git_fetch(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<crate::git::remote::RemoteResult, RootGitRefusal> {
    Ok(git::remote::fetch(&sync_workspace(&app, &root_id)?))
}

#[tauri::command(async)]
pub fn root_git_pull_ff(
    app: tauri::AppHandle,
    root_id: String,
) -> Result<crate::git::remote::RemoteResult, RootGitRefusal> {
    Ok(git::remote::pull_ff(&sync_workspace(&app, &root_id)?))
}
```

Register both in `lib.rs`. Store action `syncRoot(rootId)` runs fetch →
refresh status → (only if behind and not ahead) pull_ff, and **returns the
`RemoteResult` for the UI to render** — `auth_error` shows the probe hint
(M32.10), `rejected` shows the divergence message, `parent_repo` renders as
a quiet "nested in a larger repo" state on the sync affordance; nothing is
toasted away. Mock parity: `mockRoots` implements both with canned outcomes
including the rejected arm, and a mock root can be flagged nested so the
parity test drives a `parent_repo` emission (extending M32.9's test). e2e:
sync a mock root that fast-forwards (badge count clears) and one that
diverges (message surfaces, HEAD badge unchanged).

- [ ] **Step 4: Full gate, commit**

```sh
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd .. && pnpm lint && pnpm typecheck && pnpm test:run && pnpm test:coverage
p=5573; lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null && echo "$p BUSY" || PORT=$p pnpm e2e
git add -A && git commit -m "feat(roots): fetch and fast-forward pull per root, outcomes read not toasted (M32.11)"
```

**Acceptance:** a refused fast-forward provably moves nothing; no-remote is
`no_remote`, never `error`; the store returns outcomes as values; mock
covers every outcome the UI branches on; e2e exercises both sync arms.

---

### M32.12 — The decisions, written down where they bind

Three decisions from this milestone have homes outside code. This phase puts
them there so the next milestone doesn't re-litigate or — worse — silently
assume.

**Files**
- Modify: `SECURITY.md`
- Modify: `.github/SETUP.md`
- Modify: this plan doc (checkboxes + any deviations noted per phase)

- [ ] **Step 1: SECURITY.md — the mounted-roots trust model**

SECURITY.md predates M30 and says nothing about mounted roots. Add a section
after the existing trust-model material:

```markdown
## Mounted repositories (M30/M32)

Cerebro can mount additional directories — typically work repositories —
beside the vault. The trust model for a mounted root:

- **Cerebro exposes no mounted-root tools to the agent.** MCP tools are
  vault-scoped; none of the `root_*` commands are agent tools. Scope this
  claim honestly: with the shell ceiling enabled, the CLI's own tools
  (Bash/Read/…) reach anything your user account can read, mounted or not
  — this decision governs Cerebro's guarded surface, not the operating
  system. Mounted repositories may contain code the user does not have
  the right to share (employer code); widening Cerebro's surface is a
  deliberate decision, not a default (see below).
- **Reads are guarded**: path containment after canonicalization, a 2MB
  ceiling, binary sniffing (`src-tauri/src/roots/read.rs`).
- **Git operations are read-only plus fetch/fast-forward pull.** Cerebro
  never commits to, pushes from, or resolves conflicts in a mounted
  repository; a pull that would need a merge is refused (`--ff-only`);
  and sync refuses a root mounted inside a larger repository
  (`parent_repo`) — it would act on a repo you never mounted. Auth is
  system git's: Cerebro stores no credentials and only asks
  `git credential fill` (from outside the repo, so the repo's own
  credential helpers never run) whether auth WOULD succeed. Cerebro pins
  off repo hooks and the `ext::`/fsmonitor vectors for every git it
  spawns, but fetch/pull necessarily run inside the repository and git
  honors that repository's remaining configuration there — **mounting a
  repository is an act of trust in its `.git/config`.**

**Decision (M32.12): agent exposure of mounted roots is OFF.** Revisiting
it requires, in one PR: root-scoped read-only MCP tools behind the existing
permission allowlist (read-only mode must cover them), per-call root
resolution with ambiguity-as-error for anything write-shaped, and an update
to this section. The guarded read path was built MCP-ready precisely so
that PR is small — the barrier is this trust model, on purpose.
```

- [ ] **Step 2: SETUP.md — verify private vulnerability reporting, tick the line**

PVR is currently **disabled** (`{"enabled": false}`, checked 2026-08-13),
and a bare `GET || PUT` would never run the PUT — the GET exits 0 whether
enabled is true or false. Test the VALUE:

```sh
[ "$(gh api repos/JLagorio/cerebro/private-vulnerability-reporting --jq .enabled)" = "true" ] \
  || gh api -X PUT repos/JLagorio/cerebro/private-vulnerability-reporting
gh api repos/JLagorio/cerebro/private-vulnerability-reporting   # {"enabled": true}
```

Point SECURITY.md's reporting section at the repo's Security → "Report a
vulnerability" flow if it doesn't already, and tick the SETUP.md checkbox.

- [ ] **Step 3: The deferral register (in this plan doc, below)**

Confirm the following table is accurate as of the end of M32 execution and
tick this box. These are analyzed-not-built, with their triggers:

| Deferred | Trigger to build | The recorded design |
| --- | --- | --- |
| Rust coverage floor | next milestone that adds untested `src-tauri` surface | `cargo llvm-cov --fail-under-lines <measured actual>` in the quality job; mirror in pre-push behind the existing `src-tauri` change detection with `--no-clean`; floor ratchets up only (AGENTS.md rule) |
| Updater + key custody | the day auto-update becomes a goal | generate the minisign keypair offline; private key ONLY in a GitHub Environment restricted to protected `v*` refs, never a plain repo secret; offline backup (losing it strands every install); unsigned-updater = RCE channel, never ship it casually |
| Apple Developer ID + notarization | paid account decision | tolaria's ephemeral-keychain recipe (`release-build-artifacts.yml:84–99` in the vendored tree); delete the xattr instruction the same day |
| Work-repo writes (commit/push under policy) | m22-m28 policy layer merged to main | proposal-card flow per M30 decision log; `RemoteOutcome` vocabulary already fits |
| Release channels (alpha/stable) | first need for a second lane | extract a `workflow_call` builder BEFORE duplicating any lane (tolaria release.yml pattern) |
| Commit signing | collaborators arrive, or paranoia strikes | SSH-key signing + vigilant mode, 10 minutes; never a ruleset rule while agent-driven commits flow from many worktrees |

- [ ] **Step 4: Commit, finish the PR**

```sh
git add SECURITY.md .github/SETUP.md docs/superpowers/plans/2026-08-13-cerebro-m32-github-hardening-multi-repo.md
git commit -m "docs(security): the mounted-roots trust model, and six deferrals with triggers (M32.12)"
git push
gh pr ready && gh pr checks --watch
```

**Acceptance:** SECURITY.md states the mounted-root model including the
explicit agent-exposure OFF decision; PVR verified/enabled and witnessed;
the deferral register is accurate; the PR is green and ready for review.

---

## Traps

- **Required-check names are the job names.** `quality` and `e2e` in the
  ruleset must match mac-app.yml's job ids forever; renaming a job without
  moving the ruleset bricks merging (the bypass log is not an invitation).
- **The ruleset lands before the m22-m28 merge.** That merge is the
  riskiest push in the repo's history; do not let it happen onto an
  unprotected main.
- **Scanner scope.** `docs/examples/` vendors whole repos *including their
  `.github/workflows/`*. zizmor/actionlint are pinned to
  `.github/workflows/` paths; any future scanner gets its exclusion
  manifest in the same commit that introduces it (M15.19 lesson).
- **A 40-hex ref can still be the wrong object.** Annotated tags have their
  own SHA distinct from the commit they point at; Actions resolves `uses:`
  pins as COMMITS, and a tag-object SHA looks pinned while breaking
  Dependabot's bumping and commit-resolving audits. Always pin the peeled
  `^{}` commit (this plan's first draft got three of six wrong exactly this
  way — M32.2 Step 4's loop is the check).
- **SHA pins rot without M32.3.** The dependabot `github-actions` ecosystem
  is what keeps them fresh; if you drop that block, drop the pins strategy
  consciously.
- **Raw `git` in tests is banned in this crate.** command.rs's
  `REPO_SELECTING_VARS` comment records raw test git under a hook-exported
  `GIT_DIR` turning a throwaway repo into the real checkout, three times.
  Every Track B fixture goes through `init_repo`/`run_str`; there are zero
  bare `Command::new("git")` spawns in `src-tauri` today and M32 must not
  add the first.
- **Immutability is forever, per release.** A botched immutable release
  cannot be fixed, only superseded. The rc dry-run is not optional.
- **`GIT_CONFIG_PARAMETERS` is one env var.** M32.10 *extends* the existing
  value; clobbering it would drop `core.quotepath=false` and break every
  path with a non-ASCII character (the existing tests would catch it — run
  them).
- **The e2e reuse flip changes daily muscle memory.** After M32.7,
  `pnpm e2e` against a running dev server fails with "port is used" unless
  `CEREBRO_E2E_REUSE=1`. That is the designed behaviour; AGENTS.md moves in
  the same commit so nobody diagnoses it as a regression.
- **Store-layer rules cut both ways.** Refusals and `RemoteResult`s are
  values the caller reads (the documented exemption); transport failures
  still follow catch/toast/null. Mixing the two up in either direction is a
  review-blocking defect.
- **Coverage ratchets on the TS side.** M32.9/M32.11 add store branches;
  write their tests with the code or `pnpm test:coverage` blocks the
  commit.
- **`gh api` shapes churn.** Every settings call in this plan prints its
  result; if a parameter is rejected, the fallback is the Settings UI and
  an honest SETUP.md entry — never silently skipping the control.

## Acceptance matrix

| Claim | How it is checked |
| --- | --- |
| PRs are gated, pushes to main require a green PR | ruleset live; `gh api .../rulesets` lists `protect-main`; a direct push to main is refused |
| No mutable third-party action refs | `grep -n '@v[0-9]' .github/workflows/*.yml` shows only `actions/*`; zizmor unpinned-uses audit green |
| Release path is cold-cache + attested + immutable | build job rust-cache skipped on tags; attestation step on tags; rc release verified immutable |
| CVE notification exists for both ecosystems | vulnerability-alerts endpoint 204; dependabot.yml covers npm/cargo/actions |
| Workflow YAML cannot silently regress | scanners.yml runs zizmor+actionlint on every `.github/**` change |
| Mounted repo shows branch/dirty/ahead-behind | `roots::tests` gate tests; RootTree badge e2e |
| Non-repo root refuses typed, nothing toasts | `no_git_capability` test + store test + e2e no-toast assertion |
| Sync cannot create conflicts | `a_diverged_pull_ff_reports_rejected_and_changes_nothing` |
| Sync refuses roots nested in a larger repo | `sync_on_a_subfolder_mount_refuses_parent_repo` |
| Every spawned git is hook-dead and protocol-pinned | `spawned_git_carries_the_protocol_pins` (incl. `core.hooksPath=/var/empty`) |
| The credential probe cannot run repo-declared helpers | neutral-cwd design in `credentials.rs` + `a_url_with_control_characters_is_refused_not_probed` |
| A cargo advisory lane exists and never blocks a push | cargo-deny weekly workflow + deny.toml; not a required check, not in husky |
| Cerebro exposes no root tools to the agent | SECURITY.md decision section; no `root_*` in `mcp.rs` (grep) |
| Mock parity is driven, not asserted | the mock EMITS each reachable refusal code in its parity test |

## Exit criteria

main and `v*` tags are behind rulesets and releases are immutable · the one
workflow that ships installable bytes runs on least privilege with pinned
actions and a cold cache on tags · Dependabot watches both lockfiles and the
action pins · workflow YAML is linted by CI on every change, scoped away
from vendored trees · tag artifacts carry verifiable provenance and the
release notes say how to check · mounted repos have a read-only git surface
plus fetch/ff-pull, gated on live-probed capability, refusing typed —
including `parent_repo` for roots nested in repositories they don't own —
with mock parity proven by driven emission and e2e coverage of both sync
arms · every Cerebro-spawned git is hook-dead and protocol-pinned, and the
credential probe can never execute a mounted repo's helpers · the limits of
Cerebro's guarantees are written where users read them (SECURITY.md's
trust-in-`.git/config` sentence, the shell-ceiling caveat) · six deferrals
are registered with triggers · full gates green and the PR is ready.
