# M93-M99 reference audit - 10 apps (2026-10-24)

> **Start here:** [final report](final-report.md) (2026-10-27, after the Codex cross-check). This README is the 2026-10-24 entry point.

- **What:** AFFiNE and Outline audited fresh, and the 8 repos studied 2026-10-22/23 re-read for misses, all against the M93–M99 plans and the uncommitted tree: 389 stage-1 findings → 13 verified stage-2 files → one [backlog](backlog.md) of 194 changes (26 P0 · 95 P1 · 73 P2), 46 new phases, 74 owner decisions. **Now** (rev. 2026-10-27, critic): 252 rows (26 P0 · 110 P1 · 116 P2), 53 new phases, 90 owner decisions, 83 conflicts resolved, after the Codex cross-check ([final report](final-report.md)); text struck below was stale.
- **Why / verdict:** to fix work being built now before it lands. All 8 milestone audits say *sound with amendments*. Cerebro's write path, policy-as-data, rails and keymap lead all ten; the references confirm its bets (the user's own CLI agent, Markdown as truth, pinned workflow versions, deterministic gates). The gaps are at the seams: render faults, leave paths, menus, storage activation.

## Top 5 moves

1. **Contain render faults.** 0 error boundaries in `src/` and a bare `createRoot` (`src/main.tsx:15`) [read]: one throw blanks all four panes and unmounts the ⌘Q flush · Outline, AFFiNE, Plane, Tolaria, Activepieces, Morrow, Macro (7) · M93.12 (new; BL-01, BL-27) · **P0** core (root hook; quit host, keymap root and job runner outside the crashing tree; pane, peek, editor), P1 for the rest.
2. **Measure typing, then serialize lazily.** Uncommitted M93.1 runs `blocksToMarkdownNow` on every change (`src/editor/MarkdownEditor.tsx:886-892`) [read]; HEAD did not · Outline, Tolaria, Morrow, Thought Desk, Macro notebook (5) · M93.6 workload gates M93.1 (BL-02, BL-03) · **P0**.
3. **Close M99's four gaps before any real `workspace.db`.** Digest-freeze the schema text (an exact compare with no anchor, `selected.rs::verify_schema` [read]); record selected writes in `vault_writes` (0 hits in `workspace_service/` [read]), then relay them; fail per record, not per workspace; decide field IDs · AFFiNE, AppFlowy, Outline, Morrow (+Plane, n8n on IDs) · M99.6, M99.7 (BL-23–26) · **P0**.
4. **One action row draws every menu; ContextMenu joins the layer stack.** `CommandDef` has no icon, danger or availability, and ContextMenu's 10 consumers register no layer at `z-50` (`src/app/commands/index.ts:17-38`, `src/components/ui/ContextMenu.tsx:6-11,96`) [read]: chords run behind them, rows cannot carry M94.5's blockers, and "Rename" ≠ "Rename…" · Outline, AFFiNE, Plane, Morrow, Tolaria (5) · M94.5 (BL-06, BL-07) · **P0**.
5. **Fix the two seams that cannot be undone later.** Save answer files model text as the owner's words: no stamp (`src/agent/artifacts.ts:61-62`), so it registers as Authored (`src-tauri/src/ingest/source.rs:99-110`) [read], and the re-key is irreversible. ~~Rust's first HTTPS call would carry a Keychain token with no host, redirect or size guard (no HTTP client crate today, `src-tauri/Cargo.toml` [read])~~ Rust now calls GitHub through two hardened `reqwest` clients with no shared builder or clippy ban (`Cargo.toml:114`; BL-16 partly) (rev. 2026-10-27, critic; status-drift S8) · provenance: AFFiNE, Outline; egress: AFFiNE (EE), Outline, Activepieces · M95.8 (new; BL-14), M96.9 (new; BL-16, before M96.2's identity read) · **P0**.

- Also P0 (15 rows): reload as a leave path (BL-04), WebKit IME Enter (BL-05), DS rails and WebKit, zoom and failed-save evidence (BL-08–12), Ask again replay (BL-13), lost GitHub create (BL-15), reveal map (BL-17), M98 packet (~~BL-18–22~~ BL-18–21; BL-22 retired, superseded by V47 origins) → [backlog P0](backlog.md#p0---change-current-work) (rev. 2026-10-27, critic).
- New ids (M93.12+, M94.10+, M95.8+, M96.9+, M97.9+, ~~M98.10~~ M98.10–M98.11 and unnumbered NEW:sheet-goal-seek (rev. 2026-10-27, critic), M99.9+) are the backlog's proposals, not plan phases yet ([new phases](backlog.md#new-phases-proposed-id-title-scope-exit-check-depends-on)).

## What really works

1. **Faults stay in their section; Retry remounts by key.** Outline, AFFiNE, Plane, Tolaria, Activepieces, Morrow, Macro (7). Morrow saves its editors in the catch; Tolaria adds React's root error hooks → BL-01, BL-27 (M93.12).
2. **Serialize at save, not per keystroke.** Outline, Tolaria, Morrow, Thought Desk, Macro notebook (5); AFFiNE and AppFlowy never do (CRDT) → BL-03 (M93.1).
3. **One action row feeds menus, palette, buttons and the native menu, with a blocked reason.** Outline, Plane, Morrow, Tolaria, AFFiNE (5) → BL-07, BL-68 (M94.5, M94.12).
4. **A role layer between ramps and components, held by down-only ratchets.** Translucent hover/press: AFFiNE, Macro, AppFlowy, Morrow, n8n, Thought Desk (6; Activepieces dissents). Raised dark overlay: AFFiNE, Morrow, Thought Desk, Outline, Plane, Macro (6). Named depths: Outline, n8n, Macro, AFFiNE, Thought Desk (5). AppFlowy's 4 new vs 136 legacy popovers show adoption without a rail → BL-42, BL-53, BL-60–62 (M94.5, M94.10).
5. **Loading keeps geometry; a refresh keeps content.** Outline, Macro, Plane, AFFiNE, Tolaria (5) → BL-51 (M94.11).
6. **Dead ends become returns.** A trashed target opens with Restore: AFFiNE, Outline, AppFlowy, Morrow (4). A miss or dangling link becomes a create: AFFiNE, Tolaria, Morrow. A new record stays in its filtered view: AFFiNE, Thought Desk → BL-39, BL-45, BL-47 (M94.4–M94.6).
7. **Storage that cannot drift silently.** Frozen or append-only schema text: AFFiNE, AppFlowy. Stable field IDs with tombstones: AFFiNE, AppFlowy, Plane, n8n. The change recorded in the mutation's transaction: Outline, AFFiNE → BL-23, BL-26, BL-24, BL-111 (M99.6, M99.7).
8. **App-private data has its own safety net.** Snapshots (`VACUUM INTO` or rolling): AFFiNE, Morrow, Thought Desk. In-process fault injection that runs on any OS: AFFiNE, Morrow, Activepieces → BL-104, BL-113, BL-114 (M95.3, M98.3, M99.8).
9. **The desktop shell is product.** One process per install: Tolaria (default launch only; per-vault bypass, CX-TOL-08; rev. 2026-10-27, critic), Thought Desk, Morrow, AFFiNE. Window frame and theme restored: Thought Desk, Morrow, Tolaria, AFFiNE. Real app zoom: AFFiNE, Tolaria, Morrow → BL-28, BL-66, BL-67 (M93.13, M94.12).
10. **Small local features most ship.** ~~Page PDF/print export: AFFiNE, Outline, Tolaria, Plane, Morrow, Thought Desk (6)~~ Print/HTML export (6 of 10); direct PDF is edition-gated in Outline and a stub in Tolaria (CX-XCUT-07; rev. 2026-10-27, critic). `$`/`$$` math: AFFiNE, Outline, Tolaria, AppFlowy, Macro, Morrow, Thought Desk (7) → BL-73 (M94.16, P1), BL-151 (M94.21, P2, owner).

## AFFiNE: the 5 lessons that matter

Paths under `docs/examples/AFFiNE-canary/`, all [read]; MIT unless marked EE (ideas only). Every take here is re-implement.

1. **Shipped schema text is frozen.** One trailing space added to migration 3 made sqlx refuse every existing database (`VersionMismatch(3)`) until a checksum repair shipped (`packages/frontend/native/nbstore/src/storage.rs:89-112`). Cerebro compares `selected_schema*.sql` byte for byte with no anchor → digest test and prepare test (BL-23; M99.6, M99.7; P0).
2. **Values hang off stable field IDs.** `custom:<propertyId>`; definitions kept with `isDeleted` tombstones (`packages/frontend/core/src/modules/db/schema/schema.ts:24,35-45`), so a rename touches one row. Cerebro's semantic producer writes name keys → decide before the first real `workspace.db` (BL-26; owner; P0).
3. **SQLite safety is cheap to prove in-process.** `vacuum_into` export plus a validated, re-keyed import (`storage.rs:174-181`); per-statement `RAISE(ABORT)` triggers (`packages/frontend/native/nbstore/src/doc.rs:443-456`) run on a Mac, where Cerebro's crash children are skipped → BL-81, BL-104, BL-113 (M95.3, M98.3, M99.8; P1). Rebuild on rusqlite.
4. **States are layers; overlays are a surface.** Button hover is a `::before` of `layer/background/hoverOverlay`, and variants only set vars (`packages/frontend/component/src/ui/button/button.css.ts:7-60`); menus fill `overlayPanel` with a role shadow (`…/ui/menu/styles.css.ts:10-17`). Cerebro: 274 opaque `hover:bg-n-*`, and menus fill `bg-n-0`, the dark app ground (`src/components/ui/Menu.tsx:91`) [read] → BL-60, BL-61 (M94.10; owner; P1).
5. **AI lands only through declared sets, inside a frozen scope.** The e2e suite asserts each surface's exact landing set (`tests/affine-cloud-copilot/e2e/ai-action/translate.spec.ts:18-35`); `doc_read` refuses reads outside the frozen turn scope with `DOC_SCOPE_DENIED` (`packages/backend/server/src/plugins/copilot/tools/doc-read.ts:48`, EE) → BL-48 (M94.7, M95.4), BL-83 (M95.9; owner); P1.

- Confirms Cerebro: CRDT truth makes Markdown one-way (the database adapter's `toBlockSnapshot: {}`, `blocksuite/affine/blocks/database/src/adapters/markdown.ts:25`), so CV-24 and pointer fences are the stronger design.

## Outline: the 5 lessons that matter

Paths under `docs/examples/outline-main/`, all [read]; BSL 1.1, ideas only, re-implement.

1. **Serialize only when saving.** `onChange` hands over a `value()` getter (`app/editor/index.tsx:1064-1073`); Tolaria's pending flag does the same → BL-02, BL-03 (M93.6 → M93.1; P0).
2. **One action definition, every surface.** `visible`, `disabled`, `dangerous` and `perform`, resolved against a context, feed menus, the command bar and buttons (`app/actions/index.ts:42-182`); Plane's rows add the reason line (`plane-preview/packages/blocks/src/context-menu/types.ts:17-40`) → BL-06, BL-07 (M94.5; P0).
3. **Positions come from the serializer, never a second grammar.** `serializeWithPositions` emits `{pmFrom, pmTo, mdFrom, mdTo}` per block (`shared/editor/lib/markdown/serializer.ts:74-97,268-282`). Cerebro's reveal grammar refuses any mark, link, `_` or `&` (`src/editor/sourceReveal.ts:31-35`) [read] → BL-17 (M97.2; P0). The same round-trip compare can later keep untouched blocks' bytes (BL-124; owner; P2).
4. **Record the change in the mutation's transaction, fan out after commit, and add the re-drive Outline lacks.** `Event` enqueues through `afterCommit` with no sweeper (`server/models/Event.ts:80-89`) → selected writes record `vault_writes` (BL-24; P0), relayed by a durable cursor replayed at startup (BL-100, BL-111; M98.5, M99.7; P1).
5. **Tell the page's story where it is read.** One meta sentence by precedence: deleted, archived, imported, updated since your last view (`app/components/DocumentMeta.tsx:73-178`). A trashed doc says when it leaves "unless restored" and offers Restore (`app/scenes/Document/components/Notices.tsx:38-54`, `app/actions/definitions/documents.tsx:1489-1516`). A move names the permission change (`app/components/ConfirmMoveDialog.tsx:58-76`) → BL-72 (M94.15; owner), BL-39, BL-40 (M94.5); P1.

- Confirms Cerebro: no in-app model at all (no LLM SDK import in `server/` or `app/` [read: grep]); its AI is a scoped MCP server built per request (`server/routes/mcp/index.ts:54-72`), so M96.4's modern inbound adapter is a thin wire layer (BL-88).

## Milestone verdicts

| Milestone | Verdict | Top change | File |
| --- | --- | --- | --- |
| M93 Reliable workspace | Sound with amendments | Render containment (M93.12, new); typing workload before lazy serialization (M93.6 → M93.1); Reload joins M93.2's leave paths | [audit-m93](audit-m93.md) |
| M94 A: baseline, sheet, four surfaces, evidence (M94.1–.3, .9) | Sound with amendments; geometry checked in Chromium only, "200%" is CSS zoom, contrast covers role tokens only | Var-definer rail and contrast pair table before any token edit; WebKit `testMatch`; decide the 200% gate (BL-08–11) | [audit-m94a](audit-m94a.md) |
| M94 B: drafts, commands, views, utilities (M94.4–.8) | Sound with amendments; the menu vocabulary has no mechanism | ContextMenu on Popover and the layer stack; `CommandDef.available()` draws every menu; one `isImeEnter` (BL-05–07) | [audit-m94b](audit-m94b.md) |
| M95 Chat and supervised agents | Sound with amendments | Ask again replays the frozen request; saved answers stamped `generated` (BL-13; BL-14 → M95.8) | [audit-m95](audit-m95.md) |
| M96 Connectors, MCP, actions | Sound with amendments; broker, fence, requestKey and Keychain match or beat every reference | Reconcile a lost GitHub create; ~~one egress door before the first HTTPS call~~ one egress builder and a clippy ban over the two live clients (rev. 2026-10-27, critic; status-drift S8) (BL-15; BL-16 → M96.9) | [audit-m96](audit-m96.md) |
| M97 Knowledge, evidence, evaluation | Sound with amendments | Reveal map from the real serializer; a `cited` producer for chat (BL-17, BL-95) | [audit-m97](audit-m97.md) |
| M98 Workflows | Sound with amendments; publish ≠ enable is stricter than Activepieces and n8n; ~~no code yet~~ definitions, runner, publication and editor built, Enable/restart open (rev. 2026-10-27, critic; status-drift S1) | Settle the packet: ACT schema dialect, ~~block-structured branches~~ branches (D58 re-posed: keep the built graph), typed refs, git history, ~~reserve `source_kind='workflow'` in V35~~ (BL-22 retired: V47 origins) (BL-18–21; rev. 2026-10-27, critic) | [audit-m98](audit-m98.md) |
| M99 Rust services and storage | Sound with amendments; SQLite metadata + Markdown bodies proven | Digest-freeze schema text, record `vault_writes`, fail per record, decide field IDs, all before activation (BL-23–26) | [audit-m99](audit-m99.md) |

## Dimensions

| Dimension | Bottom line | File |
| --- | --- | --- |
| Architecture | Write path is the strongest of the 11 (door-minted receipts, path locks, compare-before-write, journaled batches, `outcome_unknown` fence); import no sync machinery. P0: render faults, selected writes invisible to History, attribution and wakes, schema freeze, field IDs, per-keystroke serialization, reload | [dimension-architecture](dimension-architecture.md) |
| Features | Breadth is not the gap: 65 of 120 shipped, 16 partial, 7 planned; leads on typed records, supervised agents and guarded knowledge. Misses are small and local: containment 7/10, math 7/10, page export 6/10, restore in place and single instance 4/10 (Tolaria bypasses single instance per vault, CX-TOL-08; rev. 2026-10-27, critic); "what changed since I looked" is the top add | [dimension-features](dimension-features.md) |
| Design system | Keep the system, migrate nothing (more rails than any reference). Add the role layer (state layers, raised overlays, z and shadow roles, ink/line utilities) as owner-gated M94.10; build primitives first, adopt under down-only ratchets | [dimension-design-system](dimension-design-system.md) |
| UI/UX | Parts lead; journeys break at the seams: one throw blanks four panes; trashed page, failed search, dangling link and filtered create dead-end; the native shell is unowned (⌘W quits; no Settings… ⌘,; no app zoom; the window ignores the theme); panel state is global | [dimension-ui-ux](dimension-ui-ux.md) |
| Editor | Keep the model (Markdown truth, CV-24; Morrow and Tolaria converged on it). P0: per-keystroke serialization, M97.2's plain-page mapper, editor boundary, WebKit IME Enter; three carrier gaps (database fence, ⌘U and pasted styles, cell Enter) | [dimension-editor](dimension-editor.md) |

## Do not copy

- **Reload as recovery after first ready** (Outline, AFFiNE, Morrow, Activepieces): drops memory-only owners and creation drafts.
- **Sync machinery:** CRDT logs, collab servers, queues, HLC outboxes, presence, share links (AFFiNE, Outline, Plane, AppFlowy, n8n, Activepieces, Thought Desk, Macro): single user, one writer per file.
- **JSON or CRDT body authority; ids, marks or footnotes inside content; first-match patching** (AFFiNE, Outline, Plane, AppFlowy, Macro, Thought Desk, Morrow): Markdown is the truth (CV-24, CV-31, CV-35, KNOW-02).
- **Save loops that give up, die or halt** (Outline's 5-failure cap, AFFiNE's dead loop, Activepieces' halted queue): REL-03 retains through failure.
- **`content-visibility` rows; virtualizers without set size** (Thought Desk, Macro; n8n, Activepieces, Plane): measured AX loss (REL-08); measure first (M93.6).
- **Library or styling swaps, custom themes, vault CSS** (Radix, vaul, sonner, kbar, vanilla-extract, Storybook: AFFiNE, Outline, Activepieces, n8n; themes in 7 repos): they discard `layers.ts`, ghost exits and key claims; UX-01 identity; vault CSS could restyle approval cards.
- **Focus and confirm traps** (n8n's autofocused approval with "Always allow (session)" pre-selected; autofocused destructive confirms in AFFiNE, Outline, Morrow; AFFiNE's Escape that commits): CV-28, CV-32, CV-25, CV-37.
- **Server-shaped surfaces** (public APIs, OAuth apps, webhooks, hosted or BYOK models, enable-on-publish, inboxes with unread counts, absent usage stored as 0: Outline, AFFiNE, Plane, n8n, Activepieces, Macro, Tolaria, AppFlowy): no server, no API key, publish never enables, Home is pull-only (M64.4), CV-05.

Full list with reasons: [backlog](backlog.md#rejected--do-not-copy-merged-list-with-reasons).

## Owner decisions

Top 10 of 74 (now 89; the current top 10 is in the [final report](final-report.md); rev. 2026-10-27, critic) (D# = the backlog's decision number); options and rows in [backlog](backlog.md#owner-decisions-deduplicated-each-with-its-options-and-a-recommendation).

| # | Decide | Recommendation | Backlog |
| --- | --- | --- | --- |
| 1 | Field identity before the first real `workspace.db` | Stable field IDs; values, views and filters keyed by ID | D67 · BL-26 |
| 2 | Saved-answer provenance | Stamp `generated` and register content-only, as a fourth builtin (not `vault-import-v1`) | D36 · BL-14 |
| 3 | M98 decision packet | Approve ACT schema dialect, ~~block-structured branches~~ the built branch graph (D58 re-posed), typed refs, caps and a 30-day horizon; track `.cerebro/workflows/` in git behind a secret-shape check; ~~reserve `source_kind='workflow'` now~~ D60 overtaken by V47 origins, owner ratifies (rev. 2026-10-27, critic) | D58–60 · BL-18–21 (BL-22 retired), BL-103 |
| 4 | Render faults | Explicit Retry, no auto-remount; a new CV rule "A render failure stays inside its section" | D1 · BL-01 |
| 5 | Reload and startup | Remove webview Reload after first ready (refuse it at CV-16's door if a path remains); one automatic reload only before first ready | D2–3 · BL-04, BL-31 |
| 6 | Native shell | Single-instance plugin with its own dev id; real zoom via `set_zoom` up to 200%; menu bar from command rows plus a CV-47 amendment; the ⌘W close ladder | D4, D17–19 · BL-28, BL-66–69 |
| 7 | DS roles | Approve M94.10 (translucent states, raised overlays, ink/line roles) and new `n-400`/`n-500` values with paired captures in both themes | D10–12 · BL-60–62 |
| 8 | M96 order and scope | Native GitHub over the egress door first; reconcile lost creates via the attended retry; drop the MCP App host and the second-backend prototype from M93–M99 | D44, D47–48 · BL-15, BL-16 |
| 9 | Chat replay and scope | Ask again replays the original request and names what changed; one click only with a recorded no-dispatch fact; offer enforced "Only these sources" with web off | D38–40 · BL-13, BL-75, BL-83 |
| 10 | Storage safety at activation | Rolling app-data snapshots now; deny CLI `file_write` and Bash on selected workspaces until per-record reconciliation ships | D68, D70 · BL-114, BL-118 |

## Files

Start with the [backlog](backlog.md); open a milestone file before touching that milestone. Stage-1 files are leads: stage 2 re-opened only the claims it used.

| File | What | Verified? |
| --- | --- | --- |
| [affine-1-architecture-storage](affine-1-architecture-storage.md) | AFFiNE storage, sync, Rust (AFN1) | No (lead) |
| [affine-2-editor-blocks](affine-2-editor-blocks.md) | AFFiNE editor, blocks, data views, edgeless (AFN2) | No (lead) |
| [affine-3-design-system](affine-3-design-system.md) | AFFiNE tokens and components (AFN3) | No (lead) |
| [affine-4-product-surfaces](affine-4-product-surfaces.md) | AFFiNE navigation and journeys (AFN4) | No (lead) |
| [affine-5-ai-copilot](affine-5-ai-copilot.md) | AFFiNE chat, context, retrieval, MCP, actions (AFN5) | No (lead) |
| [outline-1-architecture](outline-1-architecture.md) | Outline server, client state, actions, plugins (OUT1) | No (lead) |
| [outline-2-editor](outline-2-editor.md) | Outline ProseMirror, Markdown fidelity, comments, revisions (OUT2) | No (lead) |
| [outline-3-design-system](outline-3-design-system.md) | Outline DS and components (OUT3) | No (lead) |
| [outline-4-product-surfaces](outline-4-product-surfaces.md) | Outline journeys (OUT4) | No (lead) |
| [outline-5-ai-mcp-integrations](outline-5-ai-mcp-integrations.md) | Outline AI, MCP, OAuth, integrations, webhooks, OKF (OUT5) | No (lead) |
| [delta-tolaria](delta-tolaria.md) | Tolaria DS, UI, missed architecture (TOL) | No (lead) |
| [delta-plane](delta-plane.md) | Plane DS, UI, missed architecture (PLN) | No (lead) |
| [delta-activepieces](delta-activepieces.md) | Activepieces DS, UI (APC) | No (lead) |
| [delta-n8n](delta-n8n.md) | n8n DS, UI (N8N) | No (lead) |
| [delta-macro](delta-macro.md) | Macro DS, UI (MAC) | No (lead) |
| [delta-appflowy](delta-appflowy.md) | AppFlowy DS, UI (AFY) | No (lead) |
| [delta-morrow](delta-morrow.md) | Morrow DS, UI, missed architecture (MOR) | No (lead) |
| [delta-thought-desk](delta-thought-desk.md) | Thought Desk DS, UI, missed architecture (TDK) | No (lead) |
| [cerebro-baseline-ui](cerebro-baseline-ui.md) | Cerebro DS, components, surfaces, counts (CBUI) | Snapshot about 10:40; stage 2 re-grepped what it used |
| [cerebro-baseline-architecture](cerebro-baseline-architecture.md) | Cerebro architecture, features, M93–M99 status (CBAR) | Snapshot about 10:40; stage 2 re-grepped what it used |
| [stage1-findings-index](stage1-findings-index.md) | 389 stage-1 findings by milestone | No (stage-1 verdicts) |
| [audit-m93](audit-m93.md) | M93.1–M93.11 keep, amend, add, cut | Yes: 2 passes (counts below) |
| [audit-m94a](audit-m94a.md) | M94.1–M94.3, M94.9 | Yes: 2 passes |
| [audit-m94b](audit-m94b.md) | M94.4–M94.8 | Yes: 2 passes |
| [audit-m95](audit-m95.md) | M95.1–M95.7 | Yes: 2 passes |
| [audit-m96](audit-m96.md) | M96.1–M96.8 | Yes: 2 passes |
| [audit-m97](audit-m97.md) | M97.1–M97.8 | Yes: 2 passes |
| [audit-m98](audit-m98.md) | M98.1–M98.9 | Yes: 2 passes |
| [audit-m99](audit-m99.md) | M99.1–M99.8 | Yes: 2 passes |
| [dimension-architecture](dimension-architecture.md) | Architecture vs 10 apps | Yes: 2 passes |
| [dimension-features](dimension-features.md) | 120-feature matrix, gaps to close and skip | Yes: 2 passes |
| [dimension-design-system](dimension-design-system.md) | Tokens, theming, primitives, rails | Yes: 2 passes (fit re-run) |
| [dimension-ui-ux](dimension-ui-ux.md) | Journeys, states, shell, keyboard | Yes: 2 passes |
| [dimension-editor](dimension-editor.md) | Editor and content model, Markdown fidelity | Yes: 2 passes (fit re-run) |
| [backlog](backlog.md) | ~~194 merged changes, 46 new phases, 41 conflicts resolved, 74 owner decisions~~ 252 rows, 53 new phases, 83 conflicts resolved, 90 owner decisions (rev. 2026-10-27, critic) | Yes: built from verified rows; every P0 Cerebro claim re-grepped; deciding reference files re-opened |
| [final-report](final-report.md) | Owner summary after the Codex cross-check (2026-10-27): top moves, P0 status, decisions | Every Top-move and P0 status claim re-grepped 2026-10-27; 16 AFFiNE/Outline files reopened |
| [codex-crosscheck/status-drift](codex-crosscheck/status-drift.md) | P0 rows, Top 5 and decisions on the 2026-10-27 tree; stale claims in this folder | Yes: 77 rows → 60 / 11 / 6 / 0 |
| [codex-crosscheck/xcut-cross-cutting](codex-crosscheck/xcut-cross-cutting.md) | Codex priorities, baseline and method vs ours; a row-by-row map of Codex's priorities (critic) | Yes: 26 rows → ~~18 / 8~~ 19 / 7 / 0 / 0 (rev. 2026-10-27, critic) |
| [codex-crosscheck/afa-affine-application](codex-crosscheck/afa-affine-application.md) | Codex AFFiNE application chapter vs ours | Yes: 21 rows → 12 / 9 / 0 / 0 |
| [codex-crosscheck/afe-affine-editor](codex-crosscheck/afe-affine-editor.md) | Codex AFFiNE editor, data views, canvas vs ours | Yes: 27 rows → 13 / 14 / 0 / 0 |
| [codex-crosscheck/out-outline](codex-crosscheck/out-outline.md) | Codex Outline chapter vs ours | Yes: 22 rows → 11 / 11 / 0 / 0 |
| [codex-crosscheck/mac-macro](codex-crosscheck/mac-macro.md) | Codex Macro chapter vs ours | Yes: 28 rows → 14 / 8 / 4 / 2 |
| [codex-crosscheck/mtd-morrow-thoughtdesk](codex-crosscheck/mtd-morrow-thoughtdesk.md) | Codex Morrow and Thought Desk chapter vs ours | Yes: 27 rows → 19 / 8 / 0 / 0 |
| [codex-crosscheck/n8a-n8n-agent-runtime](codex-crosscheck/n8a-n8n-agent-runtime.md) | Codex n8n agent runtime chapter vs ours | Yes: 23 rows → 14 / 8 / 1 / 0 |
| [codex-crosscheck/pln-plane](codex-crosscheck/pln-plane.md) | Codex Plane chapter vs ours | Yes: 21 rows → 11 / 6 / 4 / 0 |
| [codex-crosscheck/tol-tolaria](codex-crosscheck/tol-tolaria.md) | Codex Tolaria chapter vs ours | Yes: ~~18 rows → 12~~ 19 rows → 13 / 6 / 0 / 0 (CX-TOL-19 added; rev. 2026-10-27, critic) |
| [codex-crosscheck/wfc-workflows-connectors](codex-crosscheck/wfc-workflows-connectors.md) | Codex workflows and connectors (Activepieces, n8n) vs ours | Yes: 27 rows → 17 / 9 / 1 / 0 |
| [codex-crosscheck/afy-appflowy](codex-crosscheck/afy-appflowy.md) | Codex AppFlowy chapter vs ours | Yes: 18 rows → 6 / 10 / 2 / 0 |
| README (this file) | Entry point | Spot checks (below) |

## Method and limits

- **Agents:** workflow subagents: stage-1 writers (20 dossiers → [index](stage1-findings-index.md)), stage-2 writers with a reference-fidelity and a Cerebro-fit verifier per file, the backlog merger, this README. Each file records its own method.
- **Files read:** stage 2 re-opened every reference path that decides a row (e.g. all 159 cited paths in M94 part B; 83 reference files in UI/UX; 53 in editor; about 45, plus about 40 Cerebro reads, in features) and read or grepped every Cerebro has/lacks claim. This README read the backlog, every stage-2 header, bottom line and Verification section, and the 20 dossiers' Top findings. It re-checked 27 Cerebro claims (HEAD's lack of `onDraft` via a read-only `git show`) and 40 reference files (one by name only) behind the Top 5 and the lessons, plus the 10 LICENSE files: all held.
- **Verification counts:**

| File | Reference fidelity: checked → confirmed / corrected / removed | Cerebro fit: checked → confirmed / corrected / reclassified / removed |
| --- | --- | --- |
| audit-m93 | 42/42 → 28 / 14 / 0 | 25 → 5 / 20 / 0 / 0 |
| audit-m94a | 43/43 → 31 / 12 / 0 | 39 → 21 / 18 / 0 / 0 |
| audit-m94b | 62/62 → 45 / 17 / 0 | 62 → 37 / 24 / 1 / 0 |
| audit-m95 | 55/55 → 46 / 7 / 2 | 29 → 8 / 20 / 1 / 0 |
| audit-m96 | 52/52 → 35 / 17 / 0 | 40 → 26 / 14 / 0 / 0 |
| audit-m97 | 42/42 → 27 / 15 / 0 | 34 → 20 / 14 / 0 / 0 |
| audit-m98 | 49/49 → 31 / 18 / 0 | 38 → 18 / 20 / 0 / 0 |
| audit-m99 | 50/50 → 38 / 12 / 0 | 31 → 7 / 24 / 0 / 0 |
| dimension-architecture | 163/182 → 151 / 12 / 0 | 51 → 26 / 22 / 3 / 0 |
| dimension-features | 188/215 → 165 / 22 / 1 | 62 → 17 / 43 / 2 / 0 |
| dimension-design-system | 130/159 → 111 / 19 / 0 | 58 → 34 / 24 / 0 / 0 |
| dimension-ui-ux | 159/166 → 129 / 30 / 0 | 50 → 15 / 35 / 0 / 0 |
| dimension-editor | 97/99 → 80 / 17 / 0 | 21 → 5 / 16 / 0 / 0 |
| **Total** | **1,132 → 917 / 212 / 3** | **540 → 239 / 294 / 7 / 0** |

- **Reading the counts:** reference claims held (81% confirmed; corrections run from line ranges to narrowed rows, e.g. M95-A02 P0 → P1). Cerebro claims drifted: 54% needed a correction on the moving tree, so cite stage-2 rows, not dossiers.
- **Licences:** ideas only for Outline (BSL 1.1), Plane, AppFlowy, Macro, Thought Desk and Tolaria (AGPL-3.0) and n8n (Sustainable Use). AFFiNE is MIT except `packages/backend/**` and `packages/common/native/**` (EE); Activepieces is MIT except `packages/ee/**` and `server/api/src/app/ee/**`; Morrow is Apache-2.0. Every row is re-implement except port with notice (BL-08, BL-49, BL-54, BL-57, BL-90, BL-151, BL-185; MIT, or Apache-2.0 for Morrow in BL-57) and adopt dependency (BL-28 `tauri-plugin-single-instance` 2.5.3, BL-66 `tauri-plugin-window-state` 2.5.0; both Apache-2.0 OR MIT).
- **Nothing built, run, installed, linted or tested;** no git write (one read-only `git show`); `docs/examples/**` read only; only this file written.
- **Tree:** HEAD `6c92709` plus about 62k uncommitted lines from agents building M93–M99 now. Line numbers drift (some rows cite symbols). Stage-2 files were written 12:36–16:29; the [implementation record](../../plans/2026-10-23-m93-m99-implementation-record.md) moved at 17:19, and an M99.8 RED backup scaffold appeared at 17:11 (`src-tauri/src/workspace_migration/backup.rs`, ~~no mechanism yet, so BL-113 stands~~ the mechanism has since shipped through rusqlite `Backup`; BL-113 is mostly done, with clone re-key and native chooser acceptance open; rev. 2026-10-27, critic; status-drift S18). Re-check status before acting.
- **Limits:** stage-1 claims stage 2 did not use stay unverified. Native WKWebView behaviour (IME order, ⌘W, Reload, zoom) is inferred from code and docs, never run. [docs] rows (ADRs, decision records) were not re-opened. Counts are greps on a moving tree (±1).
