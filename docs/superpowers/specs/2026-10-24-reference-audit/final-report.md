# Final report: M93-M99 against 10 reference apps (2026-10-27)

- **What:** our 2026-10-24 audit (verified twice) cross-checked against Codex's 2026-10-26 [example review](../2026-10-26-example-review/README.md) in 12 verified files ([codex-crosscheck/](codex-crosscheck/)). The [backlog](backlog.md) now holds 252 rows (26 P0 · 110 P1 · 116 P2), 53 new phases and 90 owner decisions (rev. 2026-10-27, critic: +BL-252, +D89, +D90).
- **Bottom line:** both audits agree the plans are sound and Cerebro's write path, policy-as-data and rails lead all ten apps. The gaps are at the seams, and they have not moved: of 26 P0 rows, 20 are open, 5 partly done, 0 done and 1 superseded (BL-22) (rev. 2026-10-27, critic). Five got worse in three days, and no plan cites the backlog (grep 0). Adopt the 7 moves below before more code lands on them.

## Top moves now

Status re-grepped 2026-10-27. Paths are Cerebro's unless prefixed.

| # | Move | Why | Proof (repos) | Phase · priority | Status 2026-10-27 | Accept when |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Contain render faults** (BL-01, BL-27) | One throw blanks all four panes and unmounts the ⌘Q flush. Codex's own first priority (native quit) cannot pass without this (CX-XCUT-22) | Outline, AFFiNE, Plane, Tolaria, Activepieces, Morrow, Macro (7) | M93.12 (new) · P0 | open: bare `createRoot` (`src/main.tsx:15`); 0 boundaries in `src/` | A throw in pane 2 leaves pane 1's draft and the assistant mounted; ⌘Q still flushes after a root throw; Retry writes nothing; no fallback clears browser storage |
| 2 | **Measure typing, then serialize lazily with a max wait** (BL-02, BL-03, BL-196, BL-197) | `scheduleEmit` serializes the whole page on every keystroke (`src/editor/MarkdownEditor.tsx:892`); a trailing-only debounce never saves during steady typing | Outline, Tolaria, Morrow, Thought Desk, Macro (5; max wait: Macro only) (rev. 2026-10-27, critic) | M93.6 → M93.1 · P0 (196/197 P1) | open; no typing workload or ready marks | One serialization per debounce window on a 256 KiB page; exact text, IME included, survives unmount, Retry and quit; typing every 200 ms for 12 s lands a write at least every 5 s plus one debounce |
| 3 | **Close M99's four gaps before the first real `workspace.db`** (BL-23–26) | Schema text compared with no anchor; selected writes invisible to History, attribution and wakes; one outside edit closes the workspace; field keys become irreversible | AFFiNE, AppFlowy (frozen schema); AFFiNE, AppFlowy, Plane, n8n (field IDs); Outline, AFFiNE (change in the tx); AFFiNE, Morrow (per-record faults) | M99.6, M99.7 · P0 | 23, 24 open and grew (`selected_schema_v4.sql` added; 0 `vault_writes` in `workspace_service/`); 25 partly; 26 owner | A committed SHA-256 per shipped schema fails on any byte change; every selected writer records `vault_writes` or sits in `UNRECORDED`; a VS Code edit or `.mmd` leaves one per-record state; D67 recorded. Then BL-113's Accept on the built coordinator: a changed source or replaced destination is refused, restore stays inactive (CX-XCUT-24; rev. 2026-10-27, critic) |
| 4 | **One action row draws every menu; ContextMenu joins the layer stack** (BL-06, BL-07) | `fixed z-50` with no layer: chords run behind the menu and a Popover takes its Escape; `CommandDef` has no icon, danger or availability | Outline, AFFiNE, Plane, Morrow, Tolaria (5) | M94.5 · P0 | open (`src/components/ui/ContextMenu.tsx:96`; `src/app/commands/index.ts:17-37` unchanged) | With a menu open, `g p` and `j` do nothing; one Escape closes only the menu; page, row, context and peek menus render from `menuItemsFor`; a menu cannot apply after navigation changes its target |
| 5 | **Stamp saved answers now** (BL-14, D36) | Save answer shipped 10-24 without a stamp: each save registers model text as `human:owner`, and the re-key cannot be undone | AFFiNE, Outline | M95.8 (new) · P0 | open (`src/agent/artifacts.ts:62`) | A saved answer carries `generated {by, at, thread, attempt}` and registers content-only; a CV-58 test refuses an agent removing the stamp |
| 6 | **Finish one M96 effect journey: lost-create exit and one egress builder** (BL-15, BL-16, BL-209) | `reconcile:false` + `retry:never` fences a repository forever after one lost response; two duplicated `reqwest` builders and no ban leave a third client unguarded | AFFiNE (EE `safe_fetch`), Outline, Activepieces; none reconcile a lost create | M96.5, M96.9 (new) · P0 (209 P1; rev. 2026-10-27, critic) | both partly: 4xx → not applied is done; two hardened transports, no shared builder, no clippy ban | A lost create reconciles by exact title + body digest or stays `outcome_unknown` with the attended retry; clippy fails any `reqwest::Client::builder` outside one builder; Enable refuses an `external_mutation` definition until then |
| 7 | **Settle M98's live seams before Enable** (~~BL-19–21~~ BL-18–21; D58, D59, D78; rev. 2026-10-27, critic) | Move up/down changes nothing that runs (`src/library/WorkflowLibrary.tsx:78` vs successors in `workflows/definition.rs:64`); definitions sit in ignored `.cerebro/` with no history; reads are opaque mappings | Activepieces, n8n, Plane | M98.1 · P0 | 19, 21 open and worse; 20 open; 18 partly | Reorder never edits successors and the list shows them (or Move goes); renaming a read field flags drafts and holds the activation; `.cerebro/workflows/` survives a checkpoint behind a secret-shape check, or the docs say versions are the only history |

- **Also P0:** reload as a leave path (BL-04), one `isImeEnter` (BL-05, ~20 sites, grew), DS and evidence rails (BL-08–12), the Ask again gate (BL-13), the reveal map (BL-17); BL-22 superseded (V47 origins) (rev. 2026-10-27, critic) → [P0 table](#p0-status), [backlog](backlog.md#p0---change-current-work).

## P0 status

20 open · 5 partly · 0 done · 1 superseded. Worse since 10-24: BL-05, -19, -21, -23, -24. Evidence per row: [status-drift](codex-crosscheck/status-drift.md).

| BL | Change | Status 2026-10-27 | Accept when |
| --- | --- | --- | --- |
| 01 | Contain render faults | open | Pane 2 throw spares pane 1 and the assistant; ⌘Q flushes after a root throw; Retry writes nothing |
| 02 | Typing workload before M93.1 | open | p95 keystroke→frame and serialize-ms at 64/256 KiB and 2,000 blocks, plus ready marks, before M93.1 commits |
| 03 | Serialize lazily | open | One serialization per debounce window at 256 KiB; exact text, IME included, survives unmount, Retry, quit |
| 04 | Reload is a leave path | open | Packaged: no Reload outside editables; a reload after first ready is refused at the entry door |
| 05 | One `isImeEnter` | open, grew (`SelectedTitleInput.tsx:85`) | A `keyCode:229, isComposing:false` case is ignored by every listed input; a rail finds no `isComposing`-only guard |
| 06 | ContextMenu on Popover + layer | open | `g p`/`j` inert with a menu open; one Escape closes only the menu; a blocked row shows its reason |
| 07 | `CommandDef` draws every menu | open | Menus render from `menuItemsFor`; a rail checks ids; Rename title ≠ Rename file; target re-checked after navigation |
| 08 | CSS-variable definer rail | open | The rail fails on `--info-700`, `--danger`, `--floating-chat-available-height` today, and passes after the fixes |
| 09 | Contrast pairs; dark synapse ink | open | Every declared pair ≥4.5:1 text / ≥3:1 UI in both themes; placeholder reads `--text-placeholder` |
| 10 | M94 specs under WebKit | partly (3 added, 5 missing) | WebKit `testMatch` holds the 5 specs; each result names its engine |
| 11 | Decide the 200% gate | open | Viewport ÷ 2 at DSF 2 reaches the narrow layout; native passes via `set_zoom` or is `environment_blocked` |
| 12 | Failed save never truncates | open | At 900×600 with panel and assistant, "Couldn't save" reads whole and Retry is reachable |
| 13 | Ask again replays the frozen request | open (unsafe Retry removed; now a gate) | Ask again ships only with the replay descriptor; its two named tests pass |
| 14 | Saved answers stamped `generated` | open (writer shipped unstamped) | Stamp present; content-only registration; CV-58 refuses agent removal |
| 15 | Lost GitHub create gets an exit | partly (4xx half done) | A lost response reconciles, never mints a new action identity; Enable gate holds |
| 16 | One egress builder + clippy ban | partly (two hardened clients) | clippy fails `reqwest::Client` outside one builder; identity reads host and timeouts from `github-transport.v1.json` |
| 17 | Reveal map from the real serializer | open | Construct matrix maps byte-exact as M97.1 cases; the 46 failing demo pages reveal |
| 18 | ACT dialect for workflow schemas | partly (parser, subset, semantic digest built) | Schemas parse only via `actions::schema`; a test pins D78's hash choice |
| 19 | Branch structure | open, worse (Move inert) | D58 re-decided; reorder never edits successors; a consumer above its producer is refused with a reason |
| 20 | Typed vault refs | open | A field rename flags draft and version and holds the activation; nothing is rewritten |
| 21 | Definition history | open, worse (on disk, ignored) | D59 recorded; tracked → survives a checkpoint behind a secret-shape check; else documented |
| 22 | ~~Reserve `source_kind='workflow'`~~ | superseded (V47 origins); D60 overtaken, owner ratifies (rev. 2026-10-27, critic) | ~~Pause or unpublish revokes the run's grant (test)~~ An explicit revoke revokes the run's grants, also across a new session (tests exist); pause/unpublish start nothing new, by the amendment (:46) the owner ratifies (rev. 2026-10-27, critic) |
| 23 | Digest-freeze schema text | open, grew (v4) | Committed SHA-256 for v1/v3/v4; a commented copy is refused; every statement prepares on each version |
| 24 | Selected writes in `vault_writes` | open, grew | The CV-33 rail scans both dirs; each selected writer records or is `UNRECORDED` |
| 25 | Fail per record | partly (editor read done) | Outside edit, `git pull`, `.mmd`, case rename, iCloud delete each leave a per-record state |
| 26 | Field identity | open (owner) | D67 recorded before the first real `workspace.db`; if IDs, a field table, with frontmatter and MCP name-keyed |

## What really works

1. **Faults stay in their section; Retry remounts by key.** Outline, AFFiNE, Plane, Tolaria, Activepieces, Morrow, Macro (7) → BL-01.
2. **Serialize at save** (5: Outline, Tolaria, Morrow, Thought Desk, Macro); **Macro adds a 5 s max wait** to its 500 ms debounce (1; the other four show lazy serialization only) → BL-03, BL-196 (rev. 2026-10-27, critic).
3. **One action row feeds menus, palette and buttons, with a blocked reason.** Outline, Plane, Morrow, Tolaria, AFFiNE (5) → BL-07.
4. **A role layer between ramps and components.** Translucent states (6), raised dark overlays (6), named depths (5); AppFlowy's 4 new vs 136 legacy popovers show adoption needs a rail → BL-60–62.
5. **Loading keeps geometry; a refresh keeps content.** Outline, Macro, Plane, AFFiNE, Tolaria (5) → BL-51.
6. **Dead ends become returns.** Trashed target opens with Restore (AFFiNE, Outline, AppFlowy, Morrow); a miss becomes a create (AFFiNE, Tolaria, Morrow) → BL-39, BL-45.
7. **Storage that cannot drift silently.** Frozen schema text (AFFiNE, AppFlowy); stable field IDs with tombstones (AFFiNE, AppFlowy, Plane, n8n); the change recorded in the mutation's transaction (Outline, AFFiNE) → BL-23, BL-26, BL-24.
8. **App-private data has its own safety net.** Snapshots (AFFiNE, Morrow, Thought Desk); in-process fault injection (AFFiNE, Morrow, Activepieces) → BL-104, BL-114.
9. **The desktop shell is product.** One process per install (Thought Desk, Morrow, AFFiNE; Tolaria bypasses it per vault, CX-TOL-08); window frame restored; real zoom (AFFiNE, Tolaria, Morrow) → BL-28, BL-66, BL-67.
10. **Small local features most ship, honestly bounded.** `$`/`$$` math (7 of 10); print/HTML export (6 of 10; direct PDF is edition-gated in Outline and a stub in Tolaria, CX-XCUT-07); AFFiNE zips the page's assets → BL-151, BL-73, BL-207.

## AFFiNE: what to take

Paths under `docs/examples/AFFiNE-canary/`, reopened 2026-10-27. MIT except `packages/backend/**` and `packages/common/native/**` (EE, ideas only). Re-implement all.

1. **Shipped schema text is frozen.** A trailing space in migration 3 made sqlx refuse every existing database until a checksum repair shipped (`packages/frontend/native/nbstore/src/storage.rs:89-112`) → BL-23 (P0).
2. **Values hang off stable field IDs.** `custom:<propertyId>`, with `isDeleted` tombstones kept (`packages/frontend/core/src/modules/db/schema/schema.ts:24,35-45`) → BL-26: IDs only in `workspace.db` (CX-AFA-19).
3. **SQLite safety proven in-process.** `vacuum_into` (`storage.rs:174-181`); `RAISE(ABORT)` fault triggers (`nbstore/src/doc.rs:443-456`) run on a Mac → BL-104, BL-114 (reuse Cerebro's built `snapshot_to`).
4. **States are layers; variants only set vars.** (`packages/frontend/component/src/ui/button/button.css.ts:7-60`; menus fill an overlay role) → BL-60, BL-61 (M94.10; owner).
5. **AI lands only through declared sets inside a frozen scope.** e2e asserts each landing set (`tests/affine-cloud-copilot/e2e/ai-action/translate.spec.ts:18`); `doc_read` refuses with `DOC_SCOPE_DENIED` (`packages/backend/server/src/plugins/copilot/tools/doc-read.ts:48`, EE) → BL-48, BL-83.
6. **Exports carry their assets.** `assetsIds` → `createAssetsArchive` zip (`packages/frontend/core/src/components/hooks/affine/use-export-page.ts:105-113`) → BL-207 (CX-AFA-02). Take the table clipboard (BL-218) but not its cut-before-write.

## Outline: what to take

Paths under `docs/examples/outline-main/`, reopened 2026-10-27. BSL 1.1: ideas only, re-implement.

1. **Serialize only when saving.** `onChange` hands over a `value()` getter (`app/editor/index.tsx:1062-1073`) → BL-03 (P0).
2. **One action definition, every surface.** `visible`, `disabled`, `dangerous`, `perform` resolved per context (`app/actions/index.ts:42-182`) → BL-07 (P0).
3. **Positions come from the serializer.** `serializeWithPositions` (`shared/editor/lib/markdown/serializer.ts:74`) → BL-17 (P0).
4. **Record the change in the mutation's transaction; fan out after commit.** `afterCommit` enqueue (`server/models/Event.ts:80-89`); add the re-drive Outline lacks → BL-24 (P0), BL-111.
5. **Tell the page's story where it is read.** A trashed doc says when it leaves "unless restored" and offers Restore (`app/scenes/Document/components/Notices.tsx:54`) → BL-39, BL-72.
6. **A duplicate is a new identity that names its origin.** `originalDocumentId` (`server/commands/documentDuplicator.ts:205-230`). Cerebro's two duplicate writers copy import stamps (`src/app/recordActions.ts:41`), so a copy can take over a re-import → BL-203 (P1, CX-OUT-01).

- **Not to take:** an empty zip member for a missing attachment (`server/queues/tasks/ExportTask.ts:262-268`); PDF behind `env.PDF_EXPORT_ENABLED` (`app/actions/definitions/documents.tsx:812`); "Clear cache + reload".

## By dimension

- **Architecture** ([dimension-architecture](dimension-architecture.md)): write path strongest of 11; both audits say retain it. Open: render faults, selected writes outside History, schema freeze, field IDs, per-keystroke serialization, reload. Codex adds export classes (BL-207), a capability union (BL-204) and lazy-engine retry (BL-195).
- **Features** ([dimension-features](dimension-features.md)): breadth is not the gap. M95 archive, M96 transports, M98 runner and M99 backup are now built, none enabled or accepted. Small misses remain: math, print/HTML export, restore in place, single instance. Codex adds item-key reuse (BL-202), a table clipboard (BL-218) and inline tags (BL-230).
- **Design system and components** ([dimension-design-system](dimension-design-system.md)): keep the system and add the M94.10 role layer (owner). Measured: 274 opaque hovers, a z tie at 1100, dark synapse ink 2.22/1.70:1. Insets decided 2026-10-25; roles pending. Codex's 16 component contracts go into M94.9 journeys (CX-XCUT-15); each now maps to a row or the Retain list ([xcut map](codex-crosscheck/xcut-cross-cutting.md#codex-priorities-map-rev-2026-10-27-critic)), and BL-252 carries the two no row held (rev. 2026-10-27, critic).
- **UI and journeys** ([dimension-ui-ux](dimension-ui-ux.md)): the parts lead, but journeys break at the seams: one throw blanks four panes, dead ends, an unowned native shell. Codex adds workflow waits missing from Waiting on you (BL-208), a missing vault folder (BL-201) and a restore that Cancel cannot stop (BL-225).
- **Editor** ([dimension-editor](dimension-editor.md)): keep Markdown truth (CV-24). P0: per-keystroke serialization, the reveal map, IME Enter. Codex adds plain-text paste loss (BL-200), the toolbar under IME (BL-226) and outline nesting (BL-231). Clipboard carriers are pinned, not built (CX-AFE-13).
- **AI and agents** ([audit-m95](audit-m95.md), [audit-m96](audit-m96.md), [audit-m97](audit-m97.md), [n8a](codex-crosscheck/n8a-n8n-agent-runtime.md), [wfc](codex-crosscheck/wfc-workflows-connectors.md)): the broker, fence, requestKey and Keychain match or beat every reference. P0: saved-answer stamp, the Ask again gate, lost-create exit, egress builder. Codex adds n8n's agent runtime: honest sibling reports, quiet-turn liveness, pins that never fall back, repair proposals (BL-240, BL-234, BL-245, BL-250). v1 native children never ask (D37).

## What Codex added / where Codex corrected us / where our audit is stronger

**Codex added** (folded as BL-195–BL-251, D75–D88; BL-252 and D89 from the critic, rev. 2026-10-27):

- **Method** (rev. 2026-10-27, critic: adopted only in part): an Accept-when on every row (CX-XCUT-08) now holds for the 26 P0 rows, the 58 new rows and 7 older rows; still pending: 91 older P1 and 70 older P2 rows, the five disposition words (CX-XCUT-09), built/enabled/accepted cells for "declared ≠ enabled ≠ accepted" (CX-XCUT-12, CX-AFA-10), a "cannot be claimed" column (CX-XCUT-10) and a coverage table (CX-XCUT-13). Codex's priorities are now mapped row by row ([xcut map](codex-crosscheck/xcut-cross-cutting.md#codex-priorities-map-rev-2026-10-27-critic)).
- **Contracts:** off/unsupported as states (CX-XCUT-01 → BL-204); status words licensed by recorded facts (CX-XCUT-02, CX-WFC-15 → BL-223); export classes with a loss report (CX-XCUT-14, CX-AFA-02, CX-OUT-09 → BL-207).
- **Live defects its rows led to:** Duplicate copies import stamps (CX-OUT-01); a saved view erases a rule it cannot parse (CX-PLN-01); item keys are reused after Trash (CX-PLN-02); plain-text paste drops `<tag>` (CX-TOL-01); lazy engines never retry (CX-AFA-01); no save max wait (CX-MAC-01); workflow waits are missing from Waiting on you (CX-WFC-01); a 429 fences a repository (CX-WFC-02).
- **Scope we skipped:** n8n's agent runtime (CX-N8A-01–06) and Plane's work-management half (CX-PLN-11 → D86, Defer).

**Codex corrected us:**

- **M98 status:** "no code yet" was false. `src-tauri/src/workflows/` (21 files), 26 commands, the Library editor and V47 origins all exist (CX-WFC-06, CX-XCUT-05). As a result BL-22 is retired (CX-WFC-10), BL-18 is partly done (CX-WFC-09) and D58 is re-posed (CX-XCUT-04).
- **BL-16:** "Rust makes no HTTP call" was stale; two hardened `reqwest` clients exist (CX-XCUT-03, CX-AFA-06, CX-OUT-06, CX-WFC-07). BL-15's 4xx half is done (CX-WFC-08).
- **BL-113:** the snapshot mechanism exists, rusqlite `Backup` with an inactive restore (CX-XCUT-06, CX-AFA-03).
- **Reference facts:** Outline's PDF is edition-gated (CX-XCUT-07); AFFiNE's synced doc is read-only (CX-AFE-10); Tolaria skips single-instance per vault (CX-TOL-08); Outline caps webhook bodies after an unbounded read (CX-OUT-08).
- **Agents:** children cannot ask today (`MAIN_ONLY`, CX-N8A-08), and BL-82's child half is built (CX-N8A-10).
- **Dropped from backlog:** MR-09 archive import (CX-MTD-06 → BL-239). ~~Macro's run-history P0 (CX-MAC-07, covered by M93.3).~~ (rev. 2026-10-27, critic: CX-MAC-07 was reclassified as already covered; see below.)

**Our audit is stronger:**

- **Live P0s:** seven open mechanisms that Codex's priorities never name (CX-XCUT-16). Render containment is P0 here and only a "candidate" there (CX-XCUT-22).
- **Correctness:** 1,672 claims checked twice, against Codex's 42 sampled paths (CX-XCUT-17). Codex measures coverage; we measure correctness.
- **Decisions:** options and a recommendation for each, licences per row, and a rejected list (CX-XCUT-18).
- **Measured design system:** 274 opaque hovers, the 1100 tie, 3,266 raw vs 217 role refs (CX-XCUT-19, CX-MAC-18).
- **Seams Codex lacks:** the native shell (CX-TOL-11), reload (CX-MTD-17), the lost-create exit (CX-WFC-19), typed refs (CX-WFC-20), AI turn contracts (CX-AFA-15) and Ask again (CX-N8A-14).
- **Already met:** Codex lessons Cerebro already meets go to a Retain list, not new rows (CX-XCUT-20, CX-AFE-24, CX-PLN-18, CX-TOL-15). Codex's baseline has drifted too (CX-XCUT-21). Macro's run-history P0 is already covered by M93.3 + DEC-16, so no row (CX-MAC-07; rev. 2026-10-27, critic).

## Do not copy

1. **Reload or "Clear cache + reload" as fault recovery after first ready** (Outline, AFFiNE, Morrow, Activepieces): drops memory-only owners, drafts and the open log (CX-OUT-10).
2. **Sync machinery and JSON/CRDT body authority** (AFFiNE, Outline, Plane, AppFlowy, n8n, Activepieces, Thought Desk, Macro): single user, one writer per file, Markdown truth (CV-21, CV-24).
3. **Save loops that give up; failure counted as zero** (Outline's 5-failure cap, AFFiNE, Activepieces; Plane's background jobs): REL-03, CV-05.
4. **Silent data changes at the edges** (AFFiNE cuts before the clipboard write lands and trims pasted cells; Plane and BlockNote clear the clipboard before building the copy; AppFlowy reads a failed migration history as "none applied" (rev. 2026-10-27, Gemini check); AppFlowy drops unmatched names; Tolaria clears unsaved state when the vault disappears; Morrow inflates archives before checking them).
5. **Labels that overclaim** (Tolaria's "Safe" modes that do not contain; n8n's presence-only tool accuracy, lease-loss run-on, pins that fall back to latest): CV-29, version honesty.
6. **Focus and confirm traps** (n8n autofocuses an approval with a session-wide allow pre-selected; AFFiNE, Outline and Morrow autofocus destructive confirms; AFFiNE's Escape commits): CV-28, CV-32, CV-25, CV-37.
7. **Library or styling swaps, custom themes, vault CSS, `content-visibility` rows** (AFFiNE, Outline, Activepieces, n8n; themes in 7 repos): they lose `layers.ts`, ghost exits and key claims, and measured AX.
8. **Server-shaped surfaces** (public APIs, OAuth apps, webhooks, BYOK models, enable-on-publish, unread-count inboxes): Reject. Product surfaces (mobile, publishing, multiplayer, multiple windows, a broad backend marketplace, always-on hosting (rev. 2026-10-27, critic)) → Defer (D88).

Full list: [backlog](backlog.md#rejected--do-not-copy-merged-list-with-reasons).

## Owner decisions

Top 10 of 90. Since 10-24, D43 was decided (opt-in archive, 2026-10-26) and the D16 inset half was decided (2026-10-25). D60 was ~~superseded by~~ overtaken by the build under a root amendment ("Root approved" in M98 docs is the orchestrating agent, not the owner), so it stays pending until the owner ratifies it. D75–D88 are new; D89 (cross-note sheet references: Defer) and D90 (item-key floor: host frontmatter plus git) are the critic's (rev. 2026-10-27, critic). All rows: [backlog](backlog.md#owner-decisions-deduplicated-each-with-its-options-and-a-recommendation).

| # | Decide | Recommendation | Status 2026-10-27 | Backlog |
| --- | --- | --- | --- | --- |
| 1 | Field identity | Stable IDs, only in `workspace.db`; frontmatter, `export_legacy` and MCP stay name-keyed | pending | D67 · BL-26 |
| 2 | Saved-answer provenance | Stamp `generated` as a fourth builtin; decide now, since every save re-keys irreversibly | pending; writer shipped | D36 · BL-14 |
| 3 | M98 packet | Keep the built graph with BL-19's editor acceptance; track `.cerebro/workflows/` behind a secret-shape check; canonical definition hash pinned by a test | pending (an implementation ruling ≠ owner) | D58, D59, D78 · BL-18–21 |
| 4 | Render faults | Explicit Retry, no auto-remount; a new CV rule "A render failure stays inside its section" | pending | D1 · BL-01 |
| 5 | Reload and startup | Remove Reload after first ready (refuse it at CV-16's door); one automatic reload only before first ready | pending | D2–3 · BL-04, BL-31 |
| 6 | M96 effects | Reconcile lost creates via the attended retry; one egress builder first; classify 429 from headers only | pending; build diverges (`reconcile:false`) | D44, D47, D81 · BL-15, BL-16, BL-209 |
| 7 | DS roles | Approve M94.10 for new and changed surfaces: translucent states, raised overlays, new `n-400/500` with paired captures | pending (10-25 covers insets only) | D10–12 · BL-60–62 |
| 8 | Native shell | Single-instance plugin with its own dev id; `set_zoom` to 200%; menu bar from command rows (CV-47 amendment); the ⌘W ladder | pending | D4, D17–19 · BL-28, BL-66–69 |
| 9 | Storage safety | Rolling app-data snapshots on the built `snapshot_to`, beside the user-chosen bundle; D70 moot while selected opens suspend agents | pending | D68, D70 · BL-114, BL-118 |
| 10 | Chat and children | Ask again replays and names what changed; one click only with a recorded no-dispatch fact; "Only these sources" with web off; v1 native children never ask (end `partial`) | pending | D37–40 · BL-13, BL-74, BL-75, BL-83 |

## Confidence and limits

- **Our method:** 20 dossiers (389 findings) fed 13 stage-2 files, each given a reference-fidelity pass and a Cerebro-fit pass. Reference claims: 1,132 checked → 917 confirmed / 212 corrected / 3 removed. Cerebro claims: 540 → 239 confirmed / 294 corrected / 7 reclassified.
- **Codex's method:** a 244,437-path census; 1,990 reference files with body evidence (1,933 with exact ranges); 3,217 catalogued entries (1,608 source-traced, 1,609 declarations), with 3,575 anchors path/line-validated. Its independent check sampled 31 reference and 11 Cerebro paths.
- **Cross-check:** 12 files, ~~335 rows → 207 confirmed / 108 corrected~~ 336 rows → 209 confirmed / 107 corrected / 18 reclassified / 2 removed (CX-MAC-13, -14) (rev. 2026-10-27, critic: xcut's own table reads 19/7, not 18/8; CX-TOL-19 added). Every reference path was reopened, and Cerebro was re-grepped on 2026-10-27. The whole audit folder was grepped before any row was called missed.
- **This report:** re-grepped every Top-7 and P0 status claim on 2026-10-27 (all held) and reopened 16 AFFiNE and Outline files.
- **Gemini check (2026-10-27):** 9 items, each re-read in source. Applied 5 in whole or part (stale chat Retry in BL-75, UX-28 and M95-A03; empty Ask AI answer in BL-76; find cap in BL-232, measure first; copy order in BL-164, BlockNote included; migration read in BL-112) plus one status-drift citation. Rejected 4 on source (first-match Ask AI, the BL-231 premise, Plane bulk stub, `void copyText`). Counts unchanged ([changelog](backlog.md#gemini-check-2026-10-27)).
- **Unproven:**
  - Native WKWebView behaviour (IME order, ⌘W, Reload, zoom, quit timing): inferred from code and docs, never run.
  - Runtime: nothing was built, run or tested by either audit, and no reference app was run.
  - Live providers: GitHub, Keychain import and CLI login were not exercised.
  - Typing cost: unmeasured until BL-02 exists.
  - Built ≠ accepted: the implementation record says no milestone is complete.
- **Tree drift:**
  - HEAD `6c92709` plus uncommitted work by agents building M93–M99 now. Five P0 rows got worse in three days. Re-grep at phase start.
  - ~~Still dated, with fixes listed in [status-drift](codex-crosscheck/status-drift.md): this folder's README (:12, :62, :64, :176), stage-2 headers, the baselines.~~ Stage-2 files and both baselines were annotated 2026-10-27, and README's stale lines (:14, :64, :66, :100, :191) are struck. Still dated: the stage-1 leads (delta-morrow MR-01–05, delta-tolaria and stage1-findings-index phase labels, OUT1-18, OUT5-16, AFN2-06) and the 10-22 dossiers (rev. 2026-10-27, critic).
  - Codex's raw evidence is local-only (`docs/acceptance/2026-10-26-example-review/`).

## Files

| File | What |
| --- | --- |
| final-report (this file) | Owner summary, 2026-10-27 |
| [backlog](backlog.md) | 252 rows, 53 new phases, 90 decisions (rev. 2026-10-27, critic), conflicts, rejected; [changelog 2026-10-27](backlog.md#changelog-2026-10-27-codex-cross-check) |
| [README](README.md) | 2026-10-24 entry point, method and verification counts |
| [codex-crosscheck/](codex-crosscheck/) | 12 verified files: [status-drift](codex-crosscheck/status-drift.md), [xcut](codex-crosscheck/xcut-cross-cutting.md), and one per Codex chapter (afa, afe, out, mac, mtd, n8a, pln, tol, wfc, afy) |
| `audit-m93` … `audit-m99` (8) | Milestone verdicts: keep, amend, add, cut |
| `dimension-{architecture,features,design-system,ui-ux,editor}` | Cross-repo dimensions |
| 20 stage-1 dossiers + [index](stage1-findings-index.md) | Leads only (unverified) |
| [Codex packet](../2026-10-26-example-review/README.md) | Codex's 2026-10-26 review: [priorities](../2026-10-26-example-review/comparison-and-priorities.md), chapters, coverage |
