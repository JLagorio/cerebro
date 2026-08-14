# Cerebro M9 — Platform Polish (Milestone Map)

> **Status: DRAFT.** Milestone-altitude plans. Each M9.x doc is a sibling file; expand to M1-style task contracts before execution.

**Goal:** Make the view layer actually configurable (Notion parity for grouping, hierarchy, and columns), give the vault a git history the assistant's edits can be reviewed against, and rebuild the AI panel around tolaria's action-card model.

**Why now:** M1–M8 built the data layer, the knowledge engine, and the assistant. What is thin is the layer the user actually touches every day — a saved view can express one grouping level, one hierarchy level, and a fixed column set, and there is no way to see what the background distiller changed overnight.

**Context:** `main` at 409fe70. Reference implementation vendored at `docs/tolaria-main/` (gitignored). Branch: `m9-platform`.

---

## Locked decisions (user, 2026-07-29)

1. **All three tracks ship** — view configuration, git, and the AI panel. Not sequenced one-at-a-time.
2. **Git port is complete**, not the local subset: remotes, push/pull, conflict resolution, provider probing, clone, and GitHub file URLs. Tolaria's `src-tauri/src/git/` is ~8.6k lines; treat it as the target surface.
3. **Plan docs for every milestone** before execution.

## Milestone map

| | Milestone | Doc | Depends on |
|---|---|---|---|
| M9.1 | View configuration v2 | `…-m9.1-view-config.md` | — |
| M9.2 | Columns are properties | `…-m9.2-columns-as-properties.md` | M9.1 |
| M9.3 | Open in place | `…-m9.3-open-in-place.md` | — |
| M9.4 | Git tracking | `…-m9.4-git.md` | — |
| M9.5 | AI panel | `…-m9.5-ai-panel.md` | M9.4 (diff review) |
| M9.6 | Notion polish | `…-m9.6-notion-polish.md` | M9.1, M9.2 |

**M9.3 lands first** — it is a contained fix to a daily irritation and touches nothing the other milestones need.

**M9.1 and M9.2 land together.** Both rewrite `Presentation`; splitting them means migrating the type twice.

**M9.4 and M9.5 are independent of the view work** and can run in parallel on separate branches. M9.5 wants M9.4's diff plumbing for the "review what the agent changed" flow, but degrades gracefully without it.

## Shared decisions across M9

**Presentation v2 is a superset, not a break.** `parseViewYaml` is tolerant by contract ([views.ts:115](../../../src/engine/views.ts#L115)) — old keys (`groupBy`, `orderBy`, `visibleFields`, `childrenVia`) read forward into the new shape, new keys always write. No vault migration script, no version field. A view file written by M8 opens in M9 and a view file written by M9 opens in M8 with its extra levels ignored.

**View UI state persists in `uiStore`, keyed by view id.** Collapse state is currently component-local `useState` in TreeView and TableView, so it resets on every navigation. That is half of "the nesting doesn't stick." Ephemeral UI state does not belong in the YAML — it belongs in the store, and it must survive unmount.

**Git is opt-in per vault but visible when off.** A vault that is not a repo gets an "Enable history" affordance, not silence. Tolaria gates on a `git_enabled` setting ([gitSettings.ts](../../tolaria-main/src/lib/gitSettings.ts)) plus a real `is_git_repo` probe; keep both — the setting is intent, the probe is fact.

**No new non-functional chrome.** Standing product rule. Every badge, count, and indicator added in M9 must be actionable or answer a question the user asked. The knowledge-model rule ("nothing speaks first") extends here: a git sync badge that merely counts is chrome; one that tells you the assistant has uncommitted edits is information.

## Out of scope for M9

- Calendar and timeline layouts (`Presentation['type']` gains the slot in M9.1; the views themselves are M10).
- Multi-vault. Tolaria's AI panel takes `vaultPaths: string[]`; cerebro stays single-vault and the port drops that parameter.
- Detached AI window (`openAiWorkspaceWindow`). Noted in M9.5 as deferred, not dropped.
