# M30 — Multi-repo workspace (overview)

Status: **roadmap accepted 2026-08-09.** Sub-project 1 (A + D′) specced; B, C′,
D″, E await their own specs.
Branch: `worktree-m30-multi-repo-workspace`, based on `main` @ 81210b9.

## Premise

Cerebro is a files-first markdown workspace over exactly one vault. M30 widens
that to **1 + N roots**: the vault you already have, plus work repositories you
mount beside it — a VS Code-style file explorer and a genuinely good document
viewer, so the markdown scattered through a repo stops being something you go
poking for.

The originating ask, verbatim: *"connect to 1+N github repos kind of like you
can have multiple workspaces in VS Code… build a code viewer and editor like VS
Code + Notion… see all of the markdown files in a repo bubbled up into a central
place so you don't have to go poking and riding through the repo to find read
mes."*

## Why this is six sub-projects, not one milestone

The ask names four features that sit on a foundation Cerebro does not have.
`AppConfig { last_vault: Option<String> }` is the whole workspace model today
(`src-tauri/src/app_config.rs`). Everything else needs that widened first.

| | Sub-project | Depends on | Status |
| --- | --- | --- | --- |
| **A** | Multi-root workspace — capability-gated roots | — | specced with D′ |
| **D′** | File explorer tree + doc viewer | A | specced with A |
| **B** | Git plumbing hardening (port from Tolaria) | A | not specced |
| **C′** | Code editing (CodeMirror), split panes, tabs | A, D′ | not specced |
| **D″** | Promote the doc viewer to a collections view kind | D′ | not specced |
| **E** | Codex-style chat panel | — (orthogonal) | not specced |

`D′` is C's file tree pulled forward and fused with D's markdown bubbling. They
were separated in the first cut of this roadmap and that was wrong: **the tree
must show non-markdown files, and code files are not `Entry`s** — `scan.rs` only
emits entries for `.md`. One substrate serves both features, so they ship
together.

`D″` exists because the doc viewer should earn its abstraction. Adding `docs` to
the `ViewType` union before the renderer is proven is how you get a view that
renders nothing.

## Settled decisions

Each of these closed a fork that would otherwise have been rediscovered mid-
implementation.

1. **Capability-gated roots, not a `kind` field.** A root carries
   `{ knowledge, git, writable }`, probed from the filesystem. AGENTS.md forbids
   type special-casing; a `kind: "vault" | "repo"` field is exactly that rule
   broken. v1 constrains **exactly one root to `knowledge: true`** — a stated,
   liftable constraint rather than a permanent asymmetry.

2. **One knowledge bundle, not N.** `knowledge/` is a path-relative OKF bundle
   inside a root (`KNOWLEDGE_DIR = "knowledge"`), and the M21–M28 ledger is
   in-vault NDJSON. Per-repo bundles would mean N seq spaces and N conformance
   surfaces, which **forces HLC back** against the accepted "no HLC — seq only"
   amendment; it would also commit AI-generated markdown into shared work repos.

3. **Git plumbing only. No GitHub API, not even reserved.** Tolaria's
   "tight GitHub integration" is not GitHub at all — grepping for
   `api.github.com`, `octokit`, `GITHUB_TOKEN`, `/pulls` returns only a feedback
   dialog, its test, and the app updater. What Tolaria has is provider-agnostic
   git plumbing, and `file_url.rs` handles Bitbucket, Gitea, GitLab and Generic.
   No PRs, issues, Actions, or review comments in M30.

4. **Attach existing folders; Cerebro never owns a checkout.** `clone.rs` drops
   out of v1 entirely. Two tools believing they own a working copy is a bug
   generator, and the repos are already on disk.

5. **A bespoke file tree + doc viewer, not rows in the existing view engine.**
   Settled by the substrate argument above. The generic-views alternative is
   recorded in the spec's rejected-alternatives log.

6. **Non-markdown files open read-only, syntax highlighted.** Keeps the v1
   promise ("viewer") honest and defers dirty state, save conflicts, external-
   change reconciliation and undo to C′, where they belong together.

7. **A new Rail destination, not a widened Docs surface.** `{ kind: 'docs' }`
   filters on `isDocEntry` (untyped vault notes) and cannot own a tree that
   shows `.ts` files.

8. **The vault appears as a root too.** It is a root that happens to have
   `knowledge: true`. Excluding it would make the vault the special case the
   capability model exists to avoid.

## Sequencing

1. **A + D′** — mount N roots, browse their files, read their docs. (Specced.)
2. **B** — port and harden git plumbing. Cerebro's `git/` is 2,081 lines to
   Tolaria's ~7,900; `conflict.rs` is 132 lines to 570, `status.rs` 142 to 725,
   and `credentials.rs` / `connect.rs` / `file_url.rs` are missing outright.
3. **C′** — editing, split panes, tabs.
4. **D″** — promote the doc viewer, once D′ has proven it in real use.
5. **E** — the chat panel, whenever; it depends on nothing here.

## Relationship to in-flight work

M30 branches from `main`, so it carries neither the M22–M28 ledger/policy layer
nor the M29 mermaid work. That is deliberate and safe in v1, because **mounted
repos emit no epistemic events** — decision 2 keeps the ledger single-writer.

Two forward merges are anticipated, neither blocking:

- **M29 (mermaid).** The doc viewer's block renderer is pluggable specifically
  so merging M29 lights up diagram rendering rather than requiring rework.
- **M22–M28 (policy).** If policy should eventually govern repo mutations — a
  HIGH-risk write to a shared work repo genuinely does want a proposal card —
  that arrives with C′ (editing), not here, since v1 writes nothing.

The `.gitignore` change that untracks `docs/` in favour of `docs/examples` +
`docs/archive` is byte-identical to the one already on `m22-m28-convergent-
intelligence`, so the two merge without conflict.

## Out of scope for all of M30

GitHub API surfaces (PRs, issues, Actions, review comments) · cloning or
otherwise managing checkouts · more than one knowledge root · federating
knowledge across roots · Windows support (the git provider probe stays
native-only, shaped so a port fills in a branch).
