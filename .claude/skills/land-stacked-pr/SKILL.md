---
name: land-stacked-pr
description: Land a PR that is stacked on another PR so its commits actually reach main. Use when a PR's base is not main, or when merging a chain of milestone PRs.
---

# land-stacked-pr

## Why this exists

- Branches here are not deleted on merge (`delete_branch_on_merge` is false),
  and GitHub retargets a child PR only when its parent's branch is deleted. So
  the child keeps the merged branch as its base, and merging it lands its
  commits there, not on main.
- It happened on 2026-08-15: PR #15 (M32) merged into `m31-claims-and-records`
  11 seconds after PR #14 merged that branch into main. M32 never reached main,
  and M53.1 and M53.2 had to re-land it.

## Roles

- The owner merges. The agent maps the stack, prepares each branch, watches CI
  and says exactly what to click.
- Push only when the owner asks. Never force-push main (revert instead), and
  never `--no-verify` (CV-01).

## Steps

- Map the stack bottom-up. For each PR, until a base is `main`:
  `gh pr view <n> --json number,baseRefName,headRefName,state,mergeStateStatus`.
- The owner merges the bottom PR. Before anything else, retarget its child:
  `gh pr edit <child> --base main`.
- A parent merged with a merge commit, this repo's habit, leaves the child's
  commits as they are: the child only has to catch up with main, which the
  PR's "Update branch" button does. A squash or rebase merge rewrote the
  parent's commits, so move only the child's own: `git fetch origin`, then
  `git rebase --onto origin/main <old-parent-tip> <child>`, then
  `git push --force-with-lease`.
- `main` requires `quality` and `e2e` on an up-to-date head
  (`.github/SETUP.md`). Wait for both on the head that will merge:
  `gh pr checks <child> --watch`. Linux CI also runs the crash tests that a Mac
  pre-push skips.
- Repeat up the stack, one PR at a time.

## Prove it landed

- `gh pr view <n> --json state,baseRefName,mergeCommit` says `MERGED`, with
  `main` as the base.
- After `git fetch origin`,
  `git merge-base --is-ancestor <merge-commit-oid> origin/main` exits 0. PR #15
  fails both checks.

## After

- Leave no milestone branch checked out in a Claude worktree. The owner checks
  branches out in the main checkout, and git refuses a branch that another
  worktree holds.
