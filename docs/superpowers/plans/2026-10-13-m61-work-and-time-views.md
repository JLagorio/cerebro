# M61 — Work and time views

**Goal.** Boards, deadlines and calendars handle real work. Projects open as pages that list and file their work. Every assignee gets its band, deadlines fall into relative buckets, and formulas compute on read. CSV goes in and out, the composer gets better, checklist lines become records, and calendars gain hours and recurrence.

Roadmap: `2026-10-12-macro-port-roadmap.md`, § M61. House style and rails: the M53–M60 and M70 plans.

**Read first (Macro, behaviour only), by part:** .1 `apps/web/src/features/tasks-view/core/task-board.ts`, `task-board-optimism.ts` · .2, .2b `apps/web/src/features/projects/core/assignment.ts` (and its add-project-tasks view) · .3, .3b `crates/models_grouping/src/date_buckets.rs`, `apps/web/src/features/home/queries/home-date-buckets.ts` · .4 `crates/database_sql/src/formula.rs` (grammar only) · .5, .5b `crates/databases/src/domain/service/transfer.rs`, `apps/web/src/features/database/core/csv.ts`, `apps/web/src/lib/core/util/csv.ts` · .6 `apps/web/src/features/block-md/component/ComposeTask.tsx`, `TaskDuplicateList.tsx` · .6b `crates/task_dedup/src/domain/service.rs` · .7 `apps/web/src/lib/core/component/LexicalMarkdown/plugins/checkbox-to-task/checkboxToTaskPlugin.ts` (+ `checkboxParsing.ts`, `checkboxDetection.ts`), `apps/web/src/lib/core/util/taskCreation.ts` · .8, .9 `apps/web/src/features/calendar/utils/calendar-date.ts`, `event-interaction.ts`, `components/CalendarGrid.tsx` · .10, .10b `apps/web/src/features/calendar/utils/recurrence.ts`.

## Status

- **Precondition:** M53–M57, M70, M58, M59 and M60 are closed, in that order, with green gates and updated roadmap statuses. They are being built unstaged in this checkout today, so this plan names their finished functions, never today's lines.
- **Built:** nothing. All 11 roadmap parts were scouted against those plans and today's tree, and all build. Seven split by their own sentences, giving 19 parts.
- **Effort:** 1 S + 8 M + 10 L ≈ 14.3 L; the roadmap said ≈7 L. Re-measured: .1, .2, .4, .6 and .11 M → L. New: .2b, .5b, .6b, .10b and .11b M; .3b and .3c L; .4b S.
- **Crash risk:** none. No schema step or spawn-path change. The one write-path change, .5's possible parent folders in `apply_batch`, adds no crash point, and CI Linux re-runs the batch's `crash_` tests.
- **Packaged checks:** .5, .5b, .9. **Live check:** .6b (CLI 2.1.250).
- **Schema steps:** none; a step found necessary takes the next free `user_version` at build time. **New refusal codes:** one, `note_exists` (.6b), operational. **New CV ids:** none. **New dependency:** `rrule@2.8.1` (.10).
- **Artifacts:**
  - `field-kinds.v1` bumps five times (.11b, .3, .3b, .4, .10);
  - `dates.v1` bumps once (.3c);
  - `policy.v3` and `tools.v1` bump in .6b, and `tools.v1` again in .4 only if `set_fields`' description lists the computed kinds.
- **demo-vault:** .11 (45 items, two Type docs), .11b (project.md) and .3b (work-item.md). Each is a test change and regenerates the scan golden.
- **Closes left-open items:** from M60, relative date operators (.3c), item-key minting (.11) and UTC created/edited display (.8). M53.16's `createOnDayValue` gains a time slot (.9).

## Decisions

- **Owner decisions**, as they bind M61:
  - D0: Macro is read for behaviour only, with no copied code, names or fixtures. `rrule` is adopted upstream: pinned, attributed, and used only behind `engine/recurrence.ts`.
  - D1: bulk writes, imports, promotions and detaches are `human:me` batches or creates. A promotion sets no "me" assignee.
  - D2 (c):
    - batch rows carry their read hash, and a mismatch refuses the whole batch as `stale_content`: bulk Set and Delete (.2), Add existing and reciprocal edits (.2b), and This event (.10b);
    - creates carry none (.5, .6, .7);
    - cell edits, calendar drags (.9) and the promoted page's save (.7) stay last-write-wins;
    - .6b's refuse needs no hash, since nothing exists yet to compare.
  - D3 (a): twins grow only through artifacts with cases:
    - field-kinds.v1: percent_done (.11b), groupable dates (.3), deadline cases (.3b), formula (.4), repeat (.10);
    - dates.v1: relative tokens (.3c);
    - policy.v3 and tools.v1 (.6b).

    TS-only, so no twin: CSV (.5, .5b), date buckets (.3), formula evaluation (.4), time-grid placement (.8, .9) and recurrence expansion (.10). Two Rust readers land with no caller yet: `deadline_field` (.3b, for M62.3) and `resolve_relative` (.3c, for M62.2).
  - D4 (a): .6b rides per-turn `claude -p` and the loopback; no transport change.
  - D5 and D7: untouched.
  - D6 (b): untouched. .6b's `if_exists` joins M57.4b's editable draft.
  - D18:
    - every object opens as a page with one anatomy: projects (.11, built first), composed and promoted records (.6, .7), imported databases (.5), detached occurrences (.10b);
    - every acceptance includes round-tripping as files;
    - no new screen: Import and the composer are dialogs, and Set and occurrences are popovers.
  - **Governed types hold:** agents still may not write Agent pages or Type docs, and .6b keeps those guards first. The composer, promotion and CSV import never offer or create Type, Collection, Skill or Agent.
  - **D8+, default taken:**
    - D13 (a)+(i): two scoped dialects. .4 is field arithmetic over number, date and formula fields. Excel A1 on IronCalc belongs to M67, and no parser is shared.
    - D11 (b): ⌘Enter is composer-local until M65's registry, and Escape stays with `layers.ts` (.6, .9, .10b).
    - D9 (b): My work's deadline sections are pull-only: no nav count, badge or push (.3b).
    - D15: not taken here. .5's import is a plain human batch, and provenance waits for M69.
- **Rules:**
  - One part, one commit: `type(scope): sentence (M61.n)`. Each commit deletes the comments it falsifies.
  - Parts start on M60's closed tip, and edits anchor by name or text, never line number.
  - The waves are fixed, and parts in a wave share no file.
    - Each part builds in its own worktree, confined to its declared files, with its own e2e `PORT`.
    - cargo runs one at a time with a shared `CARGO_TARGET_DIR`; waves 1 and 9 each hold two cargo parts, and wave 5 does too if .5 fixes batch.rs.
    - Parts cherry-pick in numeric order, the wave tip is re-gated, and the branch stays in the main checkout.
  - Artifacts use the `policy-artifact-edit` skill: bump `artifact_version`, set `rule_version` to `<name>/<commit date>`, and regenerate by the README's ignored test. Never run prettier over `shared/`, and never hand-merge a digest.
  - demo-vault edits are test changes. Every other spec seeds `window.__cerebroMockFs`.
  - CLI pinned at 2.1.250. No part has crash risk, so push at close, with the owner's OK.
- **Contracts between parts.** Whichever part lands second does the shared work:
  - **One create path (.11).**
    - `createTarget(type, {host?, entries, schema, groupBy?, groupValue?})` with `FiledUnder {host, field}`, plus `useQuickAdd(type, host)` and `useCreateOnDay(type, host)`.
    - .6, .7 and .10b pass no host; .9 forwards its slot through `useCreateOnDay`.
  - **One band write (.1 → .3 → .3b).**
    - Create seeds through `bandSeedFor`, and a drop goes through `movedBandValue`, which gives `{value} | {refused}`.
    - .3 adds the date arms: a day key seeds `createOnDayValue` and drops through `dropDateValue`, and multi-day and ghost bands refuse in words. .3b adds `bandEndpoint`.
    - BoardView keeps one move path and one refusal toast.
  - **.2's shared pieces.**
    - `readRows` (`readNoteSource`, eight at a time) serves .2b.
    - FieldEditor's `onPatch(value)` serves .6. .6 extends it to the text commit and makes derived relations and files read-only in draft mode. `HeadingProperties` wraps it as `{[name]: value}`.
    - `applyEntryPatch` serves both drafts.
    - .2 exports `engine/batch.ts`'s caps if M60.6 left them private, and .5 reads them.
  - **One clock (.3):** `bandContext()` is the only clock read for buckets (.3, .3b) and relative filters (.3c). Weeks start on Sunday.
  - **One deadline (.3b):** `TypeDef.deadline` and Rust's `deadline_field` serve .6's composer fallback, .7's 📅 mapping and M62.3. .6 builds in wave 6, after .3b's wave 5, and adds its fallback then.
  - **One CSV module and one note composer (.5):** `engine/csv.ts` serves .5b and M69. `composeNote(frontmatter, body)` in `engine/frontmatter.ts` serves .10b; if M60 already left a composer, .5 uses that one.
  - **.6 → .7:** `initialStatus` and `recordSlug`.
  - **One time grid (.8 → .9 → .10b):** timeGrid placements and `CalendarTimeGrid`. .9 owns useTimeDrag's minute axis, and .10b feeds both grids from `expandForCalendar`.
  - **Kinds only append (.4 → .10):** FIELD_KINDS, the artifact and the cast columns grow at the end (formula, then repeat). From .4 on, prose names no kind count.
  - **Artifact order:** field-kinds.v1 bumps in wave order (.11b, .3, .3b, .4, .10), each from the committed version. The scan golden regenerates in .11, .11b and .3b.
- **Scout reconciliations** (no part changed wave):
  - .6 drops its ListView and QuickAdd edits. .11 removes ListView's containment lane and its `'Work item'` default (CV-08), and after .11 no caller passes a null type.
  - FieldEditor's draft adapter takes .2's signature, `onPatch(value)`. .6's `(patch)` form becomes HeadingProperties' wrapper.
  - `engine/batch.ts`'s caps move from .5 to .2, their first reader. Wave 3 holds .2 alone.
  - `composeNote` moves from .10b's conditional to .5, its first writer. Nothing else in wave 5 edits `frontmatter.ts`.
  - .9 adds `ViewTabEmbed.tsx`, so a related tab's calendar forwards the slot too.
  - `deadline` does not join typeActions' `RESERVED`. It is a Type-doc key, and a property may still be called Deadline. .5's column names follow `RESERVED` as it stands.
  - .10b mints a detached page's key from the series' own item key (`itemKeyOf`, then `nextItemKey`), never by field name (CV-08). It never copies `key`, and it calls createTarget with no host.
  - In wave 1, .11's conditional edits to `DetailPanel.test.tsx` and `mockIpc.test.ts` would share files with .8 and .6b. .11 cherry-picks last and makes them on those tips.

## Waves

| Wave | Parts | Theme |
| --- | --- | --- |
| 1 | M61.11, M61.6b, M61.8 | project pages · `create_note` `if_exists` · calendar hours, read-only |
| 2 | M61.11b, M61.1 | project progress · multi-value bands |
| 3 | M61.2 | bulk Set, Delete and Duplicate, per record |
| 4 | M61.2b, M61.3 | Add existing · date bands |
| 5 | M61.3b, M61.5 | declared deadlines · CSV import |
| 6 | M61.6 | record composer (alone: it reads .3b's `TypeDef.deadline`, and .7 and .9 build on it) |
| 7 | M61.3c, M61.9, M61.7 | relative date filters · calendar editing · checklist promotion |
| 8 | M61.4 | formula kind |
| 9 | M61.4b, M61.5b, M61.10 | skipped counts · CSV export · Repeat property |
| 10 | M61.10b | repeating records in the calendar |

**Before wave 1:**

- Commit this plan on M60's closed tip.
- Re-read the finished names it leans on:
  - M60: `fieldValue`, `bandDef` and `bandWritable` (.1); the field-kinds and dates readers (.3); `convertValue` (.5); `applyBatch` and the caps (.6); undo labels (.7); `itemKeyOf` and `linkTargetOf` (.9); `readNoteSource` (.10);
  - M55.14's `statusFieldOf`; M59.4's `useContentSearch`, `rank_query` and `docs_of`; M53.16's `createOnDayValue`.
- Ask each wave's questions before it starts: Q1–Q8 before wave 1, Q9–Q12 before 2, Q13–Q16 before 3, Q17–Q21 before 4, Q22–Q27 before 5 (and 6), Q28–Q33 before 7, Q34–Q37 before 8, Q38–Q41 before 9, Q42–Q43 before 10. The default applies if unanswered.

**Roadmap acceptance, by part:**

| Roadmap bullet | Parts |
| --- | --- |
| Dragging a Decision card from one decider's band to another person keeps the other decider | .1 |
| Bulk Set on 20 rows reports per row, and failures stay selected | .2 |
| A work item past its due date shows under Overdue in My work and in a board grouped by due | .3b on .3 |
| A formula over an absent input renders blank, and its footer says "1 skipped" | .4, .4b |
| A CSV with quoted newlines imports as one batch, and one ⌘Z removes it | .5 |
| Promoting `- [ ] Ship docs 📅 2026-10-20 @[[person]]` creates a work item with due and assignee set, and rewrites the line as a link | .7 on .3b, .6 |
| A 10:00–11:00 record is a block in Week, a date-only record sits in the all-day lane, and a resize writes HH:MM | .8, .9 |
| A Project page lists its work items and docs, and a work item created from it is filed under the project | .11 |

The rest of the roadmap rows: .11b (progress), .2b (Add existing), .3c (relative filters), .5b (export), .6 (composer), .6b (`if_exists`), .10 and .10b (recurrence).

## Parts

### M61.11 Project pages: Tasks and Docs tabs; a related tab creates, files under its host and mints keys

- **What:** D18, WORK-16. Work item declares no `project` field, and project.md describes a relation that doesn't exist. Epic's Work items tab (M45.4) shows that related tabs work, but ViewTabEmbed passes no `onCreate`, so no tab can create. createTarget files and mints only through a dead project.md branch: every caller passes `project: null`. M60.9 left minting to this part.
- **Files:**
  - demo: `demo-vault/types/{work-item,project}.md`, the 45 items under `demo-vault/projects/*/items/`, `conformance/scan/entries.json`;
  - engine: `src/engine/{createRecord,itemKeys,viewTab}{,.test}.ts`;
  - views: `src/views/{QuickAdd,ViewTabEmbed,ListView,ViewCanvas}.tsx`, `src/views/{ViewTabEmbed (new),ListView}.test.tsx`;
  - other: `src/app/CreateMenu.tsx`, `src/detail/{RelationPicker,FieldEditor}.tsx`, `src/pages/DocPage.test.tsx`, `e2e/{project-pages (new),database-rename}.spec.ts`, `AGENTS.md`;
  - only if an assertion moves: `src/detail/DetailPanel.test.tsx`, `src/engine/fieldRefs.test.ts`, `src-tauri/src/vault/schema.rs`, `src/lib/mockIpc.test.ts`.
- **Approach:**
  - **Demo.**
    - Work item gains `project: { kind: relation, target: Project, limit: 1 }` after `blocked_by`; layout and views are untouched.
    - Each of the 45 items gains `project: "[[<its folder's stem>]]"` after `key:`.
    - project.md gains `tabs:` in Epic's flow style:
      - `overview`;
      - `tasks`: Tasks, icon square-check, a view over Work item, `scope: related`;
      - `docs`: Docs, icon file-text, a view over Spec, `scope: related`.
    - project.md's prose says a project is a page, Tasks and Docs list what names it through `project`, new work takes the next key, and a cycle is a saved view over `window`.
    - Regenerate the golden with `UPDATE_CONFORMANCE=1 cargo test --lib vault::scan::tests::scan_golden` (skip list), then run `pnpm test:run src/lib/scanGolden`.
  - **Keys.**
    - `keyPrefixOf(host)` returns `properties.key` when it is a string that, ASCII-trimmed, matches `^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$` and is not an item key (`itemKeyOf` null).
    - `nextItemKey` matches case-insensitively and keeps the host's spelling.
  - **createTarget.**
    - The `project` option becomes `host?: FiledUnder | null`.
    - A host writes `[field] = formatWikilink(linkTargetOf(host))`, which wins over a band seed on the same field.
    - A key is minted only when the host has a prefix and the new type declares a status field (task-like, CV-08).
    - The folder is always the database's home: `folder:`, else `recordsFolder`. The `/project.md` → `/items` branch goes.
    - Frontmatter order: type, key, band seed, host link.
  - **Callers.**
    - CreateMenu, RelationPicker, FieldEditor and `useNewRecord` drop `project: null`.
    - The hooks become `useQuickAdd(type, host = null)` and `useCreateOnDay(type, host = null)`.
    - ListView loses `project`, `createType` and its fallback, so `canCreate = onCreate !== undefined`.
    - ViewCanvas drops `project`; TableView keeps `sourceType`.
  - **Tabs.**
    - viewTab's ok arm gains `filedUnder`: `{host, field}` on a related tab, else null.
    - A related tab's `filtered` becomes `active.filters !== null`, so an empty project invites the first record. This reverses M45.4 for the related scope only (Q5).
    - ViewTabEmbed calls both hooks before its early return. It passes `onCreate` when `sourceType` is set, and `onCreateOn` when `resolveDateField` finds a date field.
    - Every view tab can create, and a related tab files under its host, Epic's Work items tab included.
  - **Cycles, docs and specs.** Cycles need no code: the prose names the pattern and viewTab.test proves it. AGENTS.md's repo map gains "**A project is a page** (M61.11)" after M55.12's agent bullet. database-rename.spec asserts that project.md's Tasks source reads Task after the rename.
- **Comments to delete:**
  - createRecord: the `project` doc, the M12.2 containment paragraph and the folder branch;
  - QuickAdd: useQuickAdd's "previously ListView's private QuickAddRow…";
  - ListView: the `project`, `createType` and onCreate notes, the M15 note, and `project:<path>` in its scope doc;
  - ViewCanvas: the `project` prop doc, the list-arm note and its scope doc;
  - viewTab and viewTab.test: "Related IS a narrowing…" and the `filtered` doc's "or the related scope";
  - itemKeys: the case-sensitive doc and the "case-mismatched" test name;
  - createRecord.test's containment doc, and project.md's stale prose.

  ViewTabEmbed's docblock gains create and filing.
- **Tests:**
  - itemKeys.test: a keyPrefixOf table. FLD gives FLD and ' FLD ' trims; FLD-12, C++, '', 7 and a list give null; `fld-9` counts.
  - createRecord.test: the host link goes through linkTargetOf. A task-like type under a FLD host gets FLD-13; a Spec-like type, a keyless host or no host gets no key. The home folder holds even with a host, and the host beats the band. The containment cases go.
  - viewTab.test: filedUnder; related `filtered` flips. A cycle case: a related tab whose view holds `is_between` over a daterange lists only the host's items in range.
  - ViewTabEmbed.test (new): a related quick-add writes `project: '[[atlas]]'`, the next key and records/<plural>. An unscoped tab creates plain. A calendar day passes its date field. A broken tab has no create row.
  - ListView.test: add rows appear only with onCreate. DocPage.test: guided-onboarding-ga shows the three tabs, and Tasks embeds 12 rows.
  - e2e `project-pages.spec.ts`:
    - ⌘K to Guided onboarding GA, then the full page. Tasks shows 12 rows, including "Blank-state coaching copy" and not "Campaign brief".
    - "New record in Todo" with "Ship docs" writes `records/work-items/ship-docs.md` with Work item, FLD-13, todo and `project` naming guided-onboarding-ga (quote-tolerant). The tab then shows 13 rows.
    - Docs reads "No records yet", and Phoenix's Docs lists "Phoenix cutover — go-live PRD".
- **Acceptance:**
  - Roadmap: a Project page lists its work items and docs, and a work item created from it is filed under the project.
  - All 45 demo items are filed under their project, and the golden matches in cargo and vitest.
  - Only a task-like record under a keyed host gets PREFIX-N, and it lands in its database's home.
  - An empty Tasks tab invites the first record, and a filtered view still says "Nothing matches". A cycle is a saved view, not a type.
  - D18: the project opens as a page, and its tabs, membership and new records are files.
- **Wave** 1 · **Depends** M60.1, .2, .9, .10b, .11; M55.2, .11–.13; M53.16, .20 · **Size** L (roadmap M, with .11b) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(projects): a project page lists its work and docs, and files what it creates (M61.11)`.

### M61.11b Project progress: a Percent done rollup through the field-kinds artifact

- **What:** the roadmap row ends with "a progress rollup". No rollup calc can express done over total. This part splits from .11 because it edits M60.3's digest-pinned artifact.
- **Files:** `shared/schema/{field-kinds.v1.json, field-kinds.v1.sha256, README.md}`, `src/engine/types.ts`, `src/engine/{fieldKindTable,properties,schema}{,.test}.ts`, `src/detail/RollupConfigEditor{.tsx, .test.tsx (new)}`, `demo-vault/types/project.md`, `conformance/scan/entries.json`, `e2e/project-pages.spec.ts`. Only if needed: `src-tauri/src/vault/schema.rs` (if it enumerates calcs), `src/engine/fieldRefs.test.ts`.
- **Approach:**
  - **Artifact (ritual).**
    - Rollup calcs gain `percent_done` (result: number) after `max`.
    - A field-def case: a status rollup with `percent_done` parses with its calc kept.
    - The README's judgment calls: closed statuses leave the denominator; a property that is neither status nor checkbox is left out; nothing measured reads blank.
    - Regenerate with `write_field_kinds_digest` (skip list).
  - **TS.**
    - `RollupCalc` gains `'percent_done'`, held by the tripwire. ROLLUP_CALCS gains Percent done (needsProperty, numeric, yieldsNumber).
    - `computeRollup` takes an optional `ctx {fieldDef, statuses}`. For a status: closed is left out, done counts as done, and active, ghost or empty counts as not done. For a checkbox: true is done, and every target counts. Any other kind is left out.
    - It returns round(done / counted × 100, 2). Zero counted gives '' (CV-05).
  - **Editor:** RollupConfigEditor lists only status and checkbox properties for Percent done, and shows the hint when there are none.
  - **Demo:**
    - project.md gains `progress: { kind: rollup, from: { type: Work item, field: project }, property: status, calculate: percent_done, format: progress, precision: 0 }`;
    - regenerate the golden.
- **Comments to delete:** none known. The README's judgment-call list gains percent_done.
- **Tests:**
  - properties.test: done, active, closed, ghost and empty statuses; checkbox; a select or undeclared property gives ''; no targets or all closed gives ''; 1 of 12 gives '8.33'.
  - schema.test: a demo-shaped project's progress is the number 25, displayed as 25%.
  - fieldKindTable.test and schema.rs replay the case, and the digests pass. RollupConfigEditor.test (new) covers the offer, the filtered list and the hint.
  - e2e: Progress reads 25% on Guided onboarding GA, 0% on Field App launch campaign (its cancelled item left out) and 8% on Phoenix. GA reads 23% after "Ship docs" is created.
- **Acceptance:**
  - Roadmap: a Project page shows a progress rollup.
  - Progress is done over (linked minus closed). No linked work reads blank, never 0%.
  - The calc is shared data, replayed by cargo and vitest.
  - D18: the rollup is declared in project.md and shows in the page's properties and in table cells.
- **Wave** 2 · **Depends** M61.11; M60.1–.3 · **Size** M (split from .11) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(projects): a project shows how much of its work is done (M61.11b)`.

### M61.1 Multi-value bands: a record sits in every band it holds; a move replaces only the source value

- **What:** WORK-1. groupEntries bands a record by its first value, so a Decision with two deciders shows under one of them. A board drop writes one link over the whole list, which silently loses data. Multi-select drops are refused, and multi-select bands seed nothing.
- **Files:** `src/engine/{grouping,createRecord,chart}{,.test}.ts`, `src/engine/rows.test.ts`, `src/views/{BoardView,ChartView,TableView,ViewCanvas}{,.test}.tsx`, `src/views/{ListView,GalleryView}.test.tsx`, `e2e/board-multi-value.spec.ts` (new).
- **Approach:**
  - **Membership, on M60.1's reads.**
    - `bandsEveryValue(def, raw)`: true for a multi kind (M60.3's table) without `limit: 1`, or an undeclared list.
    - `bandKeysOf(raw, def)` replaces firstValue. It gives each distinct value in stored order, else the first value, and a scalar gives `[String(raw)]`.
    - groupEntries puts each entry once into each of its keys' buckets; an entry with no keys goes to No value. Person and relation labels resolve their own key.
  - **`bandSeedFor(key, def)`:** No value gives null; a non-writable band gives undefined; multiselect gives `[key]`; person and relation give `formatWikilink(key)`; anything else goes through `bandValueFor`. bandValueFor loses its multiselect refusal, and createTarget seeds through bandSeedFor.
  - **`movedBandValue(entry, field, from, to, schema)`** gives `{value}` or `{refused}`:
    - a computed band refuses in M60.1's words;
    - a single-value field gives `bandValueFor(to)`;
    - a multi-value field replaces `from` with `to` in place: a move from No value appends, and a move to No value removes;
    - the list is deduped, keeping the first; an emptied list gives null; links are re-wrapped, and lists stay lists.
  - **BoardView.**
    - A card's drag id is `JSON.stringify([column.path, entry.path])`, with `data: {path, column}`. `data-path` stays, and React keys stay per column.
    - handleDragEnd reads `active.data.current`, so the source is the column the card was grabbed from.
    - Column and lane both go through movedBandValue. A refusal toasts once and patches nothing.
  - **Counts count records.**
    - chart.ts: `total` counts distinct records drawn; a new `ringTotal` (sum of visible slices) drives arcs and share; a new `overlap` counts records drawn more than once.
    - ChartView's centre prints `total`, and the caption names the overlap. bandRule's comment says `any_of` restates every value.
    - TableView's footer and ViewCanvas's detail siblings list each path once.
- **Comments to delete:**
  - grouping: "(key = first target by construction)", and bandValueFor's multi-select refusal and "`undefined` means … single write";
  - createRecord: the multi-select "nothing is seeded";
  - ChartView: bandRule's "bands by its FIRST value";
  - tests: ChartView.test's first-value note, BoardView.test's "M1.x interim" note and refusal test, createRecord.test's "one scalar" note;
  - chart.ts: `total`'s "the donut's whole".
- **Tests:**
  - grouping.test:
    - a two-decider record sits in both bands; a value listed twice bands once; `limit: 1` ignores a hand-written second link; undeclared lists band by every value;
    - the bandSeedFor and movedBandValue tables: [a,b] a→c gives [c,b]; a→b gives [b]; a→none gives [b]; the last value to none gives null; computed refuses.
  - createRecord.test: a multi-select band seeds `[value]`.
  - BoardView.test:
    - a card in two bands has two drag ids and one data-path;
    - A→C patches `{deciders: ['[[c]]','[[b]]']}` and toasts "Moved from A to C"; grabbing it in B moves B;
    - a multiselect move works; a drop on No value removes only the source;
    - existing events gain `data.current`.
  - chart.test and ChartView.test (total, ringTotal, overlap, arcs, the caption); TableView.test (a two-band record counts once); ViewCanvas.test; and the List, Gallery and rows tests (one card per band, distinct keys, add rows kept).
  - e2e `board-multi-value.spec.ts`:
    - at 1920 wide, an init script adds a "By decider" board to types/decision.md;
    - drag dec-no-custom-scanner-hardware from marcus-webb to sam-ito;
    - the file then lists [[sam-ito]], [[elena-vasquez]]; the card shows in both of those columns and not marcus-webb's; the toast reads "Moved from Marcus Webb to Sam Ito".
- **Acceptance:**
  - Roadmap: dragging a Decision card from one decider's band to another person keeps the other decider.
  - A move replaces only the grabbed band's value, in place, with no duplicates. `limit: 1` stays scalar, and computed bands still refuse.
  - Chart totals, the table footer and the peek's "n of m" count records once, and the caption says how many were counted twice.
  - Moves round-trip as frontmatter lists.
- **Wave** 2 · **Depends** M61.11; M60.1, .3; M46.2 · **Size** L (roadmap M) · **Crash risk** no · **Packaged check** no
- **Commit:** `fix(views): a record sits in every band it holds, and a move changes only the band you moved it from (M61.1)`.

### M61.2 Bulk Set, Delete and Duplicate answer per record and keep failures selected

- **What:** WORK-7. The bulk bar has no Set. Delete and Duplicate clear the selection whatever happened, and after M60.6 a bulk delete is all-or-nothing with no per-row answer. "Add existing" is split into .2b.
- **Files:** `src/engine/{bulkPlan,entryPatch}{,.test}.ts` (new), `src/engine/batch.ts` (caps, if private), `src/app/bulkActions{,.test}.ts` (new), `src/app/recordActions.ts`, `src/app/recordActions.test.ts` (new), `src/stores/vaultStore{,.test}.ts`, `src/detail/FieldEditor.tsx`, `src/detail/FieldEditor.test.tsx` (new), `src/views/BulkSetMenu{,.test}.tsx` (new), `src/views/TableView{,.test}.tsx`, `e2e/bulk-set.spec.ts` (new).
- **Approach:**
  - **Shared pieces.**
    - vaultStore's private `applyPatch` moves verbatim to `applyEntryPatch(entry, patch)`.
    - FieldEditor gains `onPatch?: (value: unknown) => void`. When it is set, patch and patchList hand the value over and write nothing. Option and person creation still write.
    - batch.ts exports its two caps if they are private.
  - **`bulkPlan.ts`** (pure).
    - `bulkSetFields`: the source type's fields, or the union over a typeless table's types, minus computed kinds, `from` relations and files.
    - `planBulkSet` judges each row, in this order: a knowledge/ path; a type that lacks the field; a choice outside the row's own options; validatePatch; a read error; a read hash that differs from `entry.hash`; then an unchanged value, which is skipped.
    - The rest become `{path, set, expectHash}` patches. Going over the cap fails them all.
    - `planBulkDelete` and `bulkFailureText` follow the same pattern.
  - **`bulkActions.ts`** (never throws, CV-03).
    - `readRows` reads each row, eight at a time.
    - `bulkSetField` sends ONE labelled `applyBatch`. A null result fails every ready row, and skips get one toast.
    - `bulkDelete` works the same way, with M60.7's label.
    - `bulkDuplicate` runs a new `duplicateRecordQuietly` per row. `duplicateRecord` wraps it and keeps its toast.
    - Each returns `{failed: Map<path, reason>}`.
  - **BulkSetMenu.**
    - `bulk-set` opens a popover with one row per field (`bulk-set-field-{name}`).
    - The editor works on a draft row with the field cleared, updated through applyEntryPatch.
    - `bulk-set-apply` stays disabled until a value is chosen (a clear counts). There is a Back button, and Escape goes through useEscapeLayer.
  - **TableView.**
    - Set… comes first in the bar, and all three actions go through bulkActions.
    - Afterwards only the failed paths stay checked.
    - `bulk-report` (role status) shows the reasons. A failed row carries `data-bulk-failed` and a titled circle-alert.
    - A manual toggle, Clear or Escape clears the report.
- **Comments to delete:** TableView deleteRecords' doc and per-item toasts (as M60.6 and .7 left them); duplicateChecked's "keeping the originals ticked…"; applyPatch's doc, which moves with the function. recordActions' header gains the quiet variant.
- **Tests:**
  - bulkPlan.test: each rule in order, with its words; skips; ready ops carry the read hash; the cap; bulkSetFields' exclusions; three named, then "and N more".
  - bulkActions.test: exactly one batch, holding only ready ops; null fails all; nothing throws; Duplicate makes no per-row toast.
  - entryPatch.test and vaultStore.test (behaviour unchanged); FieldEditor.test (new: onPatch never calls patchFrontmatter); BulkSetMenu.test; TableView.test (only failures stay checked, marked and reported; a toggle clears the report); recordActions.test (new).
  - e2e `bulk-set.spec.ts`:
    - check row 1 and Shift-check row 20, which reads "20 selected"; append a line to row 5's file in the mock fs; Set… → Priority → Low → Apply;
    - 19 files hold `priority: low`, and row 5 keeps its edit and old value;
    - "1 selected"; the report names row 5 with "changed since the table showed it";
    - Delete on three rows with one edited trashes two, and the edited one stays checked.
- **Acceptance:**
  - Roadmap: Bulk Set on 20 rows reports per row, and failures stay selected.
  - What is written lands as one batch with one Undo (CV-38, M60.7). Failures drop out row by row and never block the rest.
  - Delete and Duplicate report per record and keep failures selected.
  - Nothing throws, and single-cell saves stay last-write-wins.
- **Wave** 3 · **Depends** M61.1; M60.6–.8, .10, .10b; M55.2; M58.2 · **Size** L (roadmap M, with .2b) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(databases): bulk Set, Delete and Duplicate answer per record and keep what failed selected (M61.2)`.

### M61.2b Related tabs gain Add existing; derived-relation edits become one batch

- **What:** the roadmap's "Add existing" sentence. A related tab shows only what already points at its host, so filing a record means opening it. WORK-7 also names FieldEditor's reciprocal writes, which patch one record at a time and append a second link on a limit-1 owner.
- **Files:** `src/engine/linkDelta{,.test}.ts` (new), `src/app/relatedActions{,.test}.ts` (new), `src/detail/{RelationPicker,FieldEditor}{,.test}.tsx`, `src/views/ViewTabEmbed{,.test}.tsx`, `e2e/add-existing.spec.ts` (new).
- **Approach:**
  - **`linkDelta.ts`** (pure).
    - `pointsAt`: any stored spelling in the field resolves to the host.
    - `fileUnderPatch`: limit 1 replaces; otherwise the stem link is appended once; null when the record is already filed.
    - `unfileFromPatch`: drops every spelling of the host; an emptied key gives null.
  - **`relatedActions.ts`** (never throws).
    - `addExistingToHost` reads rows through .2's `readRows` and fails changed or unreadable ones. The rest go in one labelled `applyBatch`, and null fails all.
    - It returns `{failed, moved}`, where `moved` counts rows that left another host.
    - `writeReciprocal` sends one unlabelled batch, each op carrying the other record's hash.
  - **RelationPicker confirm mode** (`confirm: {label(n), exclude, onConfirm}`).
    - Rows stage instead of linking. Linked reads "Selected · N", and there is no Create row.
    - `relation-picker-confirm` is disabled at 0, beside Cancel.
    - Failures stay staged under `relation-picker-error` (role alert), and success closes. Live mode is unchanged.
  - **ViewTabEmbed:** a related tab renders `view-tab-add-existing`. It opens confirm mode over the source type, excluding every record already filed under the host, even ones the view hides.
  - **FieldEditor's relation branch** calls writeReciprocal. A derived edit becomes one batch, and a limit-1 owner side gets its link replaced, never doubled.
- **Comments to delete:** patchReciprocal's inline add/remove comments; M12.4's sentence gains "as one batch through writeReciprocal". RelationPicker's header gains confirm mode, and "Links save as you make them." shows only in live mode.
- **Tests:**
  - linkDelta.test (stem, title, case; no duplicates; limit 1; null when filed); relatedActions.test (one labelled batch, failures with reasons, null fails all, `moved`, never throws).
  - RelationPicker.test: confirm mode stages, excludes, counts, keeps failures, closes and offers no Create.
  - ViewTabEmbed.test: Add existing only on related tabs, with hidden-but-filed records excluded. FieldEditor.test: one writeReciprocal call and no per-record patch.
  - e2e `add-existing.spec.ts`:
    - on GA's Tasks, Add existing stages "Campaign brief" and "Positioning + message house", then "Add 2 records";
    - lnc-1 and lnc-2 then name [[guided-onboarding-ga]]; 14 rows; the Undo toast shows;
    - a staged item edited in the mock fs stays staged and named, and keeps field-app-launch-campaign.
- **Acceptance:**
  - Roadmap: related tabs gain "Add existing".
  - One batch and one Undo. On a single-link relation, an added record moves rather than double-filing. Failures stay staged, with a reason.
  - A derived-relation edit is one batch and never leaves two links on a single-link owner.
- **Wave** 4 · **Depends** M61.11, .2; M60.6, .7, .10, .10b; M59.2 · **Size** M (split from .2) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(databases): a related tab adds existing records and reports what it couldn't add (M61.2b)`.

### M61.3 Date bands: relative, day, week, month or year buckets, with create-in-band answered

- **What:** WORK-5, WORK-14. M20.5 turned date grouping off: raw dates made no buckets, and a create in such a band wrote junk. Date kinds are `groupable: false`, and `dueBucket` serves doc tasks only. Deadlines and My work are split into .3b, and relative filters into .3c.
- **Files:** `shared/schema/{field-kinds.v1.json, field-kinds.v1.sha256, README.md}`, `src/engine/dateBuckets{,.test}.ts` (new), `src/engine/{types,fieldRefs}.ts`, `src/engine/{grouping,views,rows,createRecord,tasks}{,.test}.ts`, `src/engine/{fieldRefs,fieldKinds,fieldKindTable}.test.ts`, `src/views/{BoardView,TableView,ViewSettingsPanel}{,.test}.tsx`, `src/views/ChartView{,.test}.tsx` (added on review), `e2e/date-bands.spec.ts` (new).
- **Approach:**
  - **Artifact (ritual):** date, daterange, created_time and last_edited_time become groupable. The README's M20.5 line becomes the bucket rule. No Rust source changes.
  - **Types:**
    - `DATE_BUCKETINGS` and `DateBucketing`;
    - `GroupSpec.dateBucket?` holds day, week, month or year, and absent means relative;
    - `Group.seedable?: false`;
    - views.ts parses only the four calendar values, so relative and junk drop.
  - **`dateBuckets.ts`** (pure). Only `bandContext()` reads the clock (todayIso, Sunday weeks).
    - `bandDayOf` reads a range's start, and an instant as local wall time.
    - The forward scale serves stored dates: Earlier, Today, Tomorrow, This week, Next week, Later.
    - The back scale serves created and edited time: Later (only when filled), Today, Yesterday, Past 7 days, Earlier this month, Last month, Older.
    - Today, Tomorrow and Yesterday key by ISO day, the rest by `rel:<name>`, and a bucket covering no day is left out.
    - Calendar buckets: an ISO day, `week:<start>`, `month:YYYY-MM` and `year:YYYY`, ascending, filled only.
    - `dropDateValue` shifts by the day delta, keeping time and length; an open range stays open.
  - **grouping.**
    - Date-family bands bucket by their scale or calendar unit, and relative buckets are emitted even when empty.
    - A non-date value gets a ghost band (CV-05), and an absent value goes last.
    - Multi-day and ghost bands carry `seedable: false`.
    - groupTree passes dateBucket and one ctx per level.
    - The date arms go in .1's functions. In bandSeedFor, a day key seeds `createOnDayValue`. In movedBandValue, a day key goes through `dropDateValue`, and multi-day and ghost bands refuse in words.
  - **Surfaces.**
    - rows.ts and TableView offer no add row or insert under a non-seedable band.
    - BoardView hides New there and toasts the refusal.
    - ViewSettingsPanel's Group page gains a Dates block (`group-date-bucket-{i}`: Relative, Day, Week, Month, Year). Choosing Relative deletes the key.
    - ChartView's drilldown Save: `bandRule` reads the band's `dateBucket`, since a relative Today key is also an ISO day. A calendar Day saves `equals <day>`, and a week, month or year saves `is_between` its first and last days. No value keeps `is_empty`; every other date band returns null, which disables Save.
  - **Elsewhere:** dueBucket becomes a projection of the forward scale, with unchanged answers, so Home and the chips are untouched. fieldRefs classifies `dateBucket` as 'nothing'.
- **Comments to delete:** createTarget's multi-select "`undefined` means …" names the multi-day date band; types.ts' pinned note after `Group` gains the relative buckets; GroupPage's footnote (Appendix A); the README's M20.5 line; bandRule's docblock gains the date arms.
- **Tests:**
  - dateBuckets.test:
    - forward keys on 2026-07-28 with weekStart 0 and 1, including Friday through Sunday; empty buckets left out; the back scale (the 1st of the month, a future stamp); calendar labels;
    - an instant in Los Angeles; dropDateValue keeps 14:30 and a range's length;
    - a source scan: no `Date.now` and no zero-argument `new Date`.
  - grouping.test: relative by default in scale order; a month grouping; ghosts; the back scale; the seedable table; groupTree per level.
  - views.test (round trips), rows.test, createRecord.test (Today seeds the day or `{start, end: null}`; This week seeds nothing), BoardView.test (a drop on Today keeps the time; This week and ghosts refuse), TableView.test, ViewSettingsPanel.test, fieldKinds.test, fieldRefs.test, tasks.test (answers unchanged).
  - ChartView.test, one case per bucket kind: Day saves `equals 2026-07-28`; week, month and year save `is_between` their bounds; No value saves `is_empty`; Today, This week and a ghost band disable Save.
  - e2e `date-bands.spec.ts`:
    - a Work item board grouped by Due: Today is empty; Tomorrow holds SYN-1; This week holds OPS-4, LNC-2 and OPS-3;
    - SYN-1 → Today writes `due: 2026-07-28`; a This-week card → Next week refuses with the file unchanged;
    - New shows on Today only; Month writes `dateBucket: month`;
    - the past column isn't asserted, since .3b changes it.
- **Acceptance:**
  - Roadmap: date and daterange become groupable, with create-in-band answered. Today, Tomorrow and day bands take creates and drops; multi-day bands take neither, and say why.
  - Roadmap: `dateBucket` covers relative, day, week, month and year, forward for stored dates and back for stamps, and extends `dueBucket`.
  - A drop keeps time of day and range length. A non-date value gets its own band. Only `bandContext()` reads the clock, so e2e's pinned clock decides.
  - A chart's Save on a date band mints only a rule that still means that band tomorrow; otherwise Save is disabled.
- **Wave** 4 · **Depends** M61.11, .1, .2; M60.1–.3, .5; M53.16 · **Size** L · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(views): dates group into relative, day, week, month and year bands (M61.3)`.

### M61.3b Declared deadlines: a Type-doc `deadline:` key, Overdue for unfinished work, deadlines in My work

- **What:** WORK-5. No record deadline reaches My work: FLD-4, due 2026-07-24, never shows. The capability must be declared on the Type doc, never read from a field name (M47 D3, CV-08). M61.7 and M62.3 read this key.
- **Files:** `shared/schema/{field-kinds.v1.json, field-kinds.v1.sha256, README.md}`, `shared/policy/README.md`, `src-tauri/src/vault/schema.rs`, `src/engine/types.ts`, `src/engine/{schema,dateBuckets,grouping,myWork,fieldRefs}{,.test}.ts`, `src/engine/fieldKindTable.test.ts`, `src/pages/MyWorkPage{,.test}.tsx`, `src/views/{BoardView,PropertyEditor}{,.test}.tsx`, `src/app/typeActions{,.test}.ts`, `demo-vault/types/work-item.md`, `conformance/scan/entries.json`, `e2e/deadlines.spec.ts` (new).
- **Approach:**
  - **The rule, for both readers:** `deadline:` resolves when it is a string that, trimmed, exactly names a date or daterange field declared on the same doc. Anything else means no deadline.
    - field-kinds.v1 gains `deadline_cases`: date, daterange, select, an unknown name, a miscased name, a padded name, a number, a list. Apply the ritual.
    - The registry row in shared/policy/README.md names the new replays.
  - **Readers.** Rust: `TypeSchema.deadline` and `deadline_field(type)`, which has no caller until M62.3. TS: `TypeDef.deadline`, parsed in buildSchema.
  - **`myWork.ts`** drops its `./columns` import, which would become a cycle once grouping reads myWork.
    - `workState`: open; finished (the first status field resolves to done or closed through statusSetFor); or unknown.
    - `workSections`: Overdue, Today, Tomorrow, This week, Next week and Later (non-empty only; rows sorted by day, time, type, title), then "Not a date", then by database in statusSetFor order.
  - **Buckets.**
    - The deadline scale splits the past into `rel:overdue` (red) and `rel:earlier`.
    - `bandEndpoint`: a deadline daterange bands and drops by its end.
    - Open or unknown work past its day goes to Overdue, and finished work to Earlier.
    - Overdue is always emitted, and Earlier only when filled. movedBandValue passes bandEndpoint.
  - **MyWorkPage.**
    - Each section is a `mywork-section` with `data-bucket` (overdue, today, tomorrow, this_week, next_week, later, unreadable, or the database) and a mono count.
    - Each row is a `mywork-row` with a `mywork-deadline` chip: red when overdue, amber today.
    - Rows open pages, and the empty state is unchanged.
  - **Editing and coherence.**
    - PropertyEditor gets a `property-deadline` switch on stored date and daterange fields. `typeActions.setTypeDeadline` never throws.
    - The key changes in the same Type-doc op as its field: planFieldRename rewrites it (fieldRefs classifies it as 'field'); removeFieldFromType drops it; changeFieldKind drops it when the field leaves the date family.
    - work-item.md gains `deadline: due` after `color:`; regenerate the golden. The product brief is unchanged (Q25).
- **Comments to delete:** MyWorkPage's "Grouped by database because …" docblock now says deadline sections come first and status order comes from statusSetFor. myWork.ts' header gains the sections; "No assignee filter" stays.
- **Tests:**
  - schema.rs (`replays_the_deadline_cases`; the demo reads `due`; the digest) and fieldKindTable.test (the same cases through buildSchema). schema.test covers each case.
  - myWork.test: workState, section order, row sort, "Not a date", by-database order, no rows.
  - MyWorkPage.test: the Overdue count and red chip; a vault with no deadline renders as before; the empty state is words, never 0.
  - grouping.test and dateBuckets.test: Overdue vs Earlier; mixed types; ranges by their end. BoardView.test: a deadline range drop moves its end.
  - PropertyEditor.test, typeActions.test (write, delete, rename, field delete, kind change; nothing throws) and fieldRefs.test.
  - e2e `deadlines.spec.ts`:
    - My work's Overdue holds 7 rows, including "Blank-state coaching copy" (Jul 24, 2026);
    - Tomorrow holds "Conflict resolution UX spec", and there is no Today;
    - the board's `rel:overdue` holds the first, and `rel:earlier` holds "Rack layout sign-off" (done);
    - switching Deadline off removes `deadline:` and the sections.
- **Acceptance:**
  - Roadmap: a work item past its due date shows under Overdue in My work and in a board grouped by due.
  - Roadmap: a Type-doc `deadline:` key exists, and My work shows deadlines. Rust and TS resolve it from one case table.
  - Finished work is never Overdue. Renaming, deleting or retyping the field keeps `deadline:` true in the same write.
  - `deadline: due` round-trips in work-item.md.
- **Wave** 5 · **Depends** M61.3, .11; M60.2, .3, .5–.7; M55.2 · **Size** L · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(work): a Type doc declares its deadline, and overdue work shows in My work and on boards (M61.3b)`.

### M61.3c Relative date filters on an injected clock, held as shared date grammar

- **What:** WORK-14. Filters take absolute dates only, so "due before today" goes stale the next day. M60.1 left "within 7 days" as a fixed date. Tokens go in dates.v1 with cases, so M62.2 replays them instead of re-deriving them (D3).
- **Files:** `shared/calendar/{dates.v1.json, dates.v1.sha256, README.md}`, `shared/policy/README.md`, `src-tauri/src/vault/dates.rs`, `src/engine/{dateGrammar,viewFilters}{,.test}.ts`, `src/engine/relativeDates{,.test}.ts` (new), `src/views/FilterValueEditor{,.test}.tsx`, `src/views/FilterChips.test.tsx`, `src/views/ChartView{,.test}.tsx` (added on review), `e2e/relative-filters.spec.ts` (new).
- **Approach:**
  - **Grammar (narrow):**
    - tokens: `today`, `tomorrow`, `yesterday`; `today+N` and `today-N` (N 1–999, no leading zero); this, last and next week and month;
    - each resolves to an inclusive day range from today and the week start;
    - reads trim, and case must match exactly. Tokens are stored as plain strings in a rule's `value`.
  - **Artifact (ritual):**
    - `relative` holds the days, offsets, periods, week starts and words.
    - `relative_cases` cover week edges for both starts, a year boundary, Jan 31's next month, Feb 2028 and the invalid forms.
    - Regenerate with `write_dates_digest`. Both READMEs are updated.
  - **Readers.** Rust: `dates.rs` checks the section, and `resolve_relative(text, today, week_start)` reads no clock and has no caller until M62.2. TS: dateGrammar checks the section in Rust's words; `relativeDates.ts` holds `parseRelative`, `resolveRelative`, `relativeLabel` and `RELATIVE_PRESETS`.
  - **viewFilters.**
    - `evaluateFilters(entry, group, schema, ctx = bandContext())` passes the context to compareValues.
    - A token resolves to [from, to], and the value's day compares as −1, 0 or 1, so every date op keeps its meaning. Absolute bounds behave as today.
    - describeFilterValue reads relativeLabel first. Callers keep the default context.
  - **FilterValueEditor:**
    - a Relative list (`filter-relative-{token}`);
    - a days box with ago and from-now buttons (`filter-relative-days|ago|ahead`, 1–999);
    - then Exact date. The trigger shows the words, capitalised.
  - **ChartView:** `bandRule` restates a relative band only where its tokens say it exactly (Today as `equals today`, Tomorrow as `equals tomorrow`, …). The rest stay null, including .3b's Overdue and Earlier, which also read status, and any band of a deadline daterange, which .3b reads off its end while filters read its start.
- **Comments to delete:** DateValue's "A date bound, picked rather than typed." gains the relative choices. Any M60.1 comment saying relative operators wait for M61.3 goes. bandRule's docblock gains the relative bands.
- **Tests:**
  - Rust: `dates.rs`' `replays_the_relative_date_cases`, the malformed-section refusals, the digest, and `nothing_in_this_module_reads_the_clock`.
  - TS: dateGrammar.test; relativeDates.test (cases, singular and plural words, the strict forms).
  - viewFilters.test:
    - every date op with today, today-7 and this_week on 2026-07-28: Jul 26 and Aug 1 are in the week, Jul 25 and Aug 2 are out;
    - `is_between`; local-day reads; moving ctx.today flips a rule; a token never matches a non-date.
  - FilterValueEditor.test (presets; days refuse 0 and 1000; an exact pick still writes YYYY-MM-DD) and FilterChips.test.
  - ChartView.test: on 2026-07-28 each relative band saves a rule matching exactly its records, or disables Save; Overdue and a deadline range's band disable it.
  - e2e `relative-filters.spec.ts`:
    - "Due is on or before today" shows the 12 items due by 2026-07-28, and work-item.md holds `value: today`;
    - "Due is this week" shows FLD-5, SYN-1, OPS-4, LNC-2 and OPS-3.
- **Acceptance:**
  - Roadmap: relative date filters run on an injected clock. The same saved file lists a different set when the clock moves.
  - Rust and TS resolve every token from one case table.
  - Chips state relative rules in words, and tokens round-trip as plain strings.
  - A chart's relative band saves as tokens where they state it exactly, so the saved view means that band tomorrow too.
- **Wave** 7 · **Depends** M61.3, .3b; M60.1, .3; M59.2 · **Size** L · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(views): date filters take today, this week and N days ago on an injected clock (M61.3c)`.

### M61.4 Formula kind (D13): field arithmetic over number, date and formula fields, computed on read

- **What:** DATA-4. M16 deferred formulas. Macro reads an empty number as 0, which CV-05 forbids. Excel A1 belongs to M67's sheets. The "N skipped" footer is split into .4b.
- **Files:**
  - artifact and Rust: `shared/schema/{field-kinds.v1.json, field-kinds.v1.sha256, README.md}`, `src-tauri/src/vault/schema.rs`, `src-tauri/fixtures/set-fields-cases.json`;
  - engine: `src/engine/formula{,.test}.ts` (new), `src/engine/types.ts`, `src/engine/{properties,fieldKindTable,schema,castRules,fieldRefs}{,.test}.ts`, `src/engine/fieldKinds.test.ts`;
  - surfaces: `src/app/typeActions{,.test}.ts`, `src/detail/FormulaConfigEditor{,.test}.tsx` (new), `src/detail/FieldEditor.tsx`, `src/detail/RecordProperties.test.tsx`, `src/views/{PropertyEditor,TableView}{,.test}.tsx`, `e2e/formula.spec.ts` (new);
  - only if `set_fields`' description lists the computed kinds: `shared/policy/{tools.v1.json, tools.v1.sha256, README.md}`.
- **Approach:**
  - **Dialect.**
    - Operators: `+ - * /`, unary minus and parentheses.
    - Names are bare keys or `{Label}`. A name matches a key ignoring case, then a label ignoring case, and is stored canonically by key.
    - number op number gives a number. date ± number gives a date (days, fractional, kept to the minute). date − date gives days. Anything else is refused.
    - CV-05: an absent or unreadable input, ÷0, a non-finite number or a date outside 0001–9999 gives an absent result, never 0.
  - **Kind (ritual).**
    - `formula` is appended last to FIELD_KINDS and the artifact: computed, orderable, numeric, filters any. Add a value case and a field-def case that keeps `formula:`.
    - The README records the dialect boundary: no shared parser, and Rust reads `formula:` but never evaluates it.
    - Rust gains `FieldKind::Formula` and `FieldDef.formula`. set-fields-cases gains a refusal case on a new corpus Type doc.
  - **Plumbing.**
    - KIND_UI gains formula (square-function, after rollup), with arms in validateValue and coerceValueToKind.
    - parseFieldDef keeps `formula`, and typeActions' KIND_KEYS and setFieldConfig accept it.
    - TableView's READ_ONLY and FieldEditor's computed branch read `kindMeta(kind).computed`, which retires two hand-kept lists.
  - **`formula.ts`** (pure).
    - Functions: `parseFormula`; `checkFormula` (refs, result type and canonical text; cycles and depth over 32 refused); `evaluateFormula` through `schema.fieldValue`; `renderFormula`; `renameFormulaRefs`; `formulaReads`.
    - Dates are computed in epoch days, with no Date object and no clock.
    - resolveField's formula branch is memoized per schema. Invalid or absent gives ''. Through M60.1, filters, sorts, charts and dashboards read the value.
  - **Coherence.**
    - castRules gains a formula row (the text row, own cell S) and column (N from every stored kind).
    - Changing a field a formula reads, in place, is Never; Convert stays.
    - fieldRefs classifies `FieldDef.formula` as 'formula'. planFieldRename re-renders formulas and flags unreadable ones, and `formulaUses` serves removeFieldFromType's refusal.
  - **FormulaConfigEditor.**
    - Elements: `formula-input` (monospace), the live line `formula-result`, field buttons `formula-field-{name}`, and `formula-save`, enabled only when the text is valid and changed.
    - Enter saves the canonical text, and Escape reverts.
    - PropertyEditor shows the editor, plus FormatRow when the result is a number.
- **Comments to delete:** properties.ts' "computed kinds (created/last-edited time, rollups)" gains formulas; TableView READ_ONLY's doc goes with the set; every prose kind count in castRules.ts, the README and schema.rs becomes "every kind"; `set_fields`' kind list changes, if it has one (tools.v1 ritual).
- **Tests:**
  - formula.test: precedence, unary minus, labels, case, the canonical render, every problem's words, the type table, date math (including a zone), the absent rules, cycles, depth 33, renames.
  - schema.test (number and date formulas; absent and invalid read empty, never 0), properties.test, fieldKinds.test, fieldKindTable.test (digest, cases, 18 kinds), castRules.test (18×18; an input change is Never and names the formula), fieldRefs.test, typeActions.test (a delete is refused while a formula reads the field).
  - FormulaConfigEditor.test, PropertyEditor.test, TableView.test (no cell editor) and RecordProperties.test (the lock, and '—').
  - Rust: schema.rs (the enum check and cases) and set_fields' replay, with no code change.
  - e2e `formula.spec.ts`:
    - on Key result, add Formula "Gap" as `{Target value} - current_value`; the file holds `formula: target_value - current_value`;
    - Webinar attendance reads 70; clearing Weekly active crews' Current value reads '—';
    - renaming Current value to Current rewrites the formula; deleting Target value is refused.
- **Acceptance:**
  - Roadmap: arithmetic over number, date and formula fields, computed on read. An absent input gives an absent result, never 0.
  - D13 default taken: field arithmetic here, Excel A1 in M67, no shared parser.
  - The canonical formula follows renames and blocks deleting or retyping an input. An invalid formula can't be saved, and a hand-edited one reads empty everywhere.
  - Formula values filter, sort and chart like stored ones. set_fields refuses them in Rust and TS.
- **Wave** 8 · **Depends** M61.2, .3b, .3c; M60.1–.7 · **Size** L (roadmap M, with .4b) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(databases): a formula property computes number and date arithmetic on read (M61.4)`.

### M61.4b Every numeric footer says how many rows it skipped

- **What:** DATA-4's second sentence, and CV-05: "a total that had to skip unmetered rows says how many it skipped". aggregate.ts drops blanks silently. This applies to every numeric column, not only formulas.
- **Files:** `src/engine/aggregate{,.test}.ts`, `src/views/TableView{,.test}.tsx`, `e2e/formula.spec.ts`.
- **Approach:**
  - `aggregateSkipped(calc, cells)`: sum, avg, min, max and range count the cells with no number reading (toNumber null), blanks included. Counting calcs give 0, and `aggregate` keeps its string result.
  - TableView's calcResults keeps `{value, skipped}` over .1's deduped rows.
  - CalcCell adds `calc-skipped-{field}` with "· {n} skipped" and a title (Appendix A) when n > 0, and nothing at 0.
- **Comments to delete:** none.
- **Tests:**
  - aggregate.test: blanks and prose skip; counting calcs give 0; an all-number column gives 0.
  - TableView.test: a Sum over one blank shows "· 1 skipped" with its title, and nothing when every row has a number.
  - e2e: with Gap as above and one Current value cleared, Gap's Sum reads 373.6 with "1 skipped", and Current value's Sum reads 519.4 with "1 skipped".
- **Acceptance:**
  - Roadmap: a formula over an absent input renders blank, and its footer says "1 skipped".
  - Every numeric footer names what it skipped. Counting footers don't change.
- **Wave** 9 · **Depends** M61.4 · **Size** S (split from .4) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(views): numeric footers say how many rows they skipped (M61.4b)`.

### M61.5 CSV import into a new database as one batch: one RFC 4180 module, a preview, limits and kind inference

- **What:**
  - DATA-11, the import half. No CSV reader exists, and createDatabase makes an empty Type doc.
  - M60.6 and M60.7 give the contract: one batch, one ⌘Z. No schema step, refusal code or MCP tool is needed.
  - The CSV code is TS-only, so no twin. D18: the new database opens as its page. D15's provenance is M69's.
- **Files:** `src/engine/{csv,csvImport}{,.test}.ts` (new), `src/engine/frontmatter{,.test}.ts` (`composeNote`), `src/app/{csvActions{,.test}.ts, CsvImportDialog{,.test}.tsx}` (new), `src/app/Sidebar{,.test}.tsx`, `e2e/csv-import.spec.ts` (new), `AGENTS.md`. Only if M60.6's batch lacks parent folders (added on review): `src-tauri/src/vault/batch.rs`, `src-tauri/fixtures/batch-cases.json`.
- **Approach:**
  - **`engine/csv.ts`** (pure): `parseCsv` and `encodeCsv`. .5b and M69 reuse them, and nothing writes a second parser.
    - Records:
      - one leading `\uFEFF` is stripped; records end at CRLF, LF or a lone CR;
      - quoted fields use `""` and keep CR and LF as LF; a quote inside an unquoted field is literal;
      - problems: after-quote, unclosed-quote, nul and long-row, with row numbers counting the header as 1;
      - blank rows are skipped and counted, and short rows are padded.
    - Header: names are trimmed; a blank name becomes `Column N`; duplicates in any case get " 2".
    - Limits: `CSV_MAX_BYTES` (16 MiB), `CSV_MAX_COLUMNS` (100), `CSV_MAX_COLUMN_NAME` (200). `csvProblemText` gives the words.
    - Writing: `encodeCsv` uses CRLF and quotes only when needed.
  - **`csvImport.ts`** (pure).
    - `inferKind` takes the first kind that holds every non-blank cell:
      - number: M60.5's strict `convertValue`, so '007', '1,200', '$5' and '1e3' stay text;
      - checkbox, then date (M60.3);
      - url and email (validateValue);
      - select: at least 3 values, at most 8 distinct, fewer distinct values than cells, each at most 24 chars;
      - text otherwise.
    - `viableKinds` always includes text.
    - It never infers status, multiselect, person, relation, daterange, phone, files or a computed kind.
  - **`planCsvImport`.**
    - The Type doc goes to the first free `types/<slug>.md`, with `{type: Type, icon: table-2, folder: home, fields}` (selects get seeded options) and `# <name>`.
    - Row titles are collapsed, and a blank one becomes Untitled (counted). Slugs are cut to 80 chars at a dash, else `row-<n>`, unique case-folded.
    - A blank cell writes no key (CV-05). Content goes through the new `composeNote` (yaml `stringify`, as views.ts uses it).
    - Ops: the Type doc first, then one create per row. Past `engine/batch.ts`' caps it refuses in words.
  - **`csvActions.ts`** (never throws).
    - `readCsvFile` refuses an oversized file before reading and decodes strict UTF-8.
    - `columnNames`: normalizeFieldName; blank → `column_<n>`; `type`, `title`, `icon`, `cover` and `RESERVED` names get `_2`.
    - `nameProblem` uses NewTypeDialog's words.
    - `importCsv` sends one `applyBatch(ops, {undo})`, rescans and navigates to the database; null returns null.
  - **UI.**
    - `csv-import-dialog`: a file button over a hidden `csv-file-input`.
    - The preview shows the name, the title column, per-column kind selects (viable kinds only) with three samples, the count line and the problems.
    - `csv-import-submit` is disabled on any problem or while writing. Nothing is stored.
    - The Sidebar's Databases header gains Import CSV between Adopt vault schema and New database. AGENTS.md names `engine/csv.ts` as the one RFC 4180 module.
  - **Parent folders (check before wave 5).**
    - `records/books/` doesn't exist before the import, and the mock's files Map has no folders, so e2e can't tell.
    - If M60.6's `apply_batch` doesn't make a create's missing parents and remove them on an in-process rollback, .5 adds what's missing to batch.rs.
    - batch-cases.json then gains "create into a missing folder", which cargo and the mock replay, and .5 runs cargo.
- **Comments to delete:** none found. Re-check `createDatabase`'s and `homeFolderFor`'s docs if either claims to be the only `folder:` writer. With the batch.rs fix, `apply_batch`'s doc gains parent folders.
- **Tests:**
  - csv.test:
    - quoting, a quoted LF and a quoted CRLF, the three line ends, BOM and NUL written as `\uFEFF` and `\u0000` (CV-13);
    - blank, short and long rows; headers; limits;
    - `parseCsv(encodeCsv(t))` round-trips quotes, commas, newlines, emoji and blanks.
  - csvImport.test:
    - the inferKind table; the op order; blank cells; YAML scalars; multi-line text; Untitled;
    - unique slugs and the `-2` Type doc; caps refused in words;
    - every planned content parses back through `splitFrontmatter` and yaml `parse`, never mockParse (the M53.20 rail keeps it to the mock).
  - csvActions.test (size and UTF-8 refusals, columnNames, nameProblem, one labelled batch, null navigates nowhere, never throws), CsvImportDialog.test and Sidebar.test.
  - Only with the batch.rs fix: cargo and the mock replay "create into a missing folder", and a batch that fails midway leaves no folder.
  - e2e `csv-import.spec.ts`:
    - books.csv with a quoted CRLF, a quoted comma and a doubled quote previews as Books, with Text, Number and Checkbox and "3 records";
    - Import shows 3 rows; books.md declares the kinds and `folder: records/books`; dune.md parses to `notes: "A desert\nplanet"`, `pages: 412`, `read: true`;
    - the four creates share one batch id; ⌘Z (focus blurred) removes all four, and Books leaves the sidebar;
    - a long row shows "Row 3 has more values than the header." and writes nothing.
- **Acceptance:**
  - Roadmap: a CSV with quoted newlines imports as one batch, and one ⌘Z removes it.
  - A refused batch writes nothing and leaves the dialog open.
  - The import works when `records/books/` doesn't exist yet, and a batch that fails midway leaves no folder.
  - Strict inference: leading zeros and '1,200' stay text. A blank cell writes no key, and untitled rows are counted.
  - Limits, bad UTF-8 and malformed rows are refused in words before any write.
  - D18: the database opens as its page, and its records are files.
- **Packaged check:** in a mac-build app with no records/books/ yet, Import CSV opens the native panel and imports books.csv. If WKWebView opens no panel, fall back to a Rust `pick_csv_file` (dialog plugin, CSV filter, ≤ 16 MiB, strict UTF-8) behind ipc.ts, with the mock keeping the input.
- **Wave** 5 · **Depends** M61.3; M60.3, .5–.8; M58.1; M53.20 · **Size** M · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(databases): import a CSV as a new database in one batch (M61.5)`.

### M61.5b CSV export of a view: its rows and visible columns as RFC 4180 text, through a native save dialog

- **What:** DATA-11, the export half. The only exports today are images. Export is a read: no receipt, batch, refusal code or schema step, and it writes outside the vault funnel, as `export_svg` does.
- **Files:** `src/engine/csvExport{,.test}.ts` (new), `src/app/csvActions{,.test}.ts`, `src-tauri/src/lib.rs`, `src/lib/{ipc,mockIpc,mockIpc.test}.ts`, `src/views/ViewTabs{,.test}.tsx`, `src/pages/{TypePage,ListPage}{,.test}.tsx`, `e2e/csv-export.spec.ts` (new).
- **Approach:**
  - **Rows and columns.**
    - `exportRows`: buildRows → entryRows, depth-0 rows only, deduped by path (.1), in band order.
    - `exportColumns`: the visible columns in order; unknown names are skipped; no stated columns falls back to defaultColumnsFor.
  - **`cellText`**, through `schema.fieldValue`:
    - absent gives ''; text kinds are verbatim; numbers use `String(n)`; checkbox gives true or false; dates are verbatim; a daterange gives `start → end`;
    - select and status give labels, and ghosts keep their ids; multiselect labels join with ", ";
    - person and relation give titles, else the stem; computed kinds give their value.
  - **`guardFormula`:**
    - a cell that comes from neither a number nor a checkbox field and starts with = + - @, TAB or CR gets a leading `'`.
    - `viewCsv` is the BOM (written `\uFEFF`, CV-13) plus `encodeCsv`, with a Name header and humanized column names.
  - **Plumbing.**
    - Rust `export_csv(app, default_name, csv)` sits beside `export_svg` with the same shape. Cancel gives `Ok(None)`, and it is registered in `generate_handler!`.
    - ipc.ts `exportCsv` is behind `inTauri()`. The mock downloads a `text/csv;charset=utf-8` Blob.
  - **Action and menu.**
    - `exportViewCsv(sel, views)` resolves that tab's surface: its saved filters and sort, never the search box. It calls `exportCsv(slugify(title + view) + '.csv')`. Cancel returns false with no toast, and it never throws.
    - ViewTabs `onExport?` adds "Export as CSV…" (file-down) after Duplicate, on record-listing layouts only. TypePage and ListPage pass it.
- **Comments to delete:** none found.
- **Tests:**
  - csvExport.test: cellText per kind; exportRows (band order, nested rows dropped, a two-band record once); exportColumns; guardFormula never touches numbers; the BOM and the Name header.
  - csvActions.test (file name, a closed tab's own filters, cancel, failure, never throws); mockIpc.test; ViewTabs.test (absent on chart, dashboard and whiteboard); TypePage.test and ListPage.test.
  - e2e `csv-export.spec.ts`:
    - All's export starts with `\uFEFF`, and its header is `Name,Status,Priority,Assignee,Due,Estimate`;
    - the line count equals the Work item files; a line starts `Landing page refresh,`;
    - At risk exports exactly its rows.
- **Acceptance:**
  - A view exports its own rows, in filter, sort and band order, with its visible columns: CRLF, a BOM, labels and titles.
  - Absent exports as empty, never 0, and a two-band record exports once.
  - Formula-looking text is guarded. Cancel writes nothing. Chart, dashboard and whiteboard tabs don't offer export.
- **Packaged check:** export a Work item view, then open it in Numbers: UTF-8 names and the multi-line cell hold.
- **Wave** 9 · **Depends** M61.1, .4, .5; M60.1; M54.3 · **Size** M (split from .5) · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(views): export a view as CSV (M61.5b)`.

### M61.6 Record composer: heading fields, Create more, ⌘Enter and Similar records, with nothing stored

- **What:** WORK-8. NewRecordDialog asks only for a title and a type, and still says "Opens in the record panel, never in Docs.", which has been stale since M47 and D18. It has no fields, Create more, ⌘Enter or duplicate hints. The agent half (WORK-12) is .6b.
- **Files:** `src/engine/recordDraft{,.test}.ts` (new), `src/app/RecordComposer{,.test}.tsx` (new), `src/app/CreateMenu{,.test}.tsx`, `src/detail/{FieldEditor,HeadingProperties}{,.test}.tsx`, `e2e/record-composer.spec.ts` (new).
- **Approach:**
  - **`recordDraft.ts`** (pure).
    - `composerFields`: the layout heading minus computed kinds, `from` relations and files. When that is empty, the status field (`statusFieldOf`), then `TypeDef.deadline`'s field.
    - `draftEntry`: path `(draft)` and hash null; links go into relationships, bracket-stripped (CV-09).
    - `initialStatus` and `initialValues`; `recordSlug` (80 chars at a dash, else a fallback); `draftFrontmatter` (target first, values minus null, '' and [], plus validatePatch problems); `pickSimilar` (none when widened; at most two of the type).
  - **Draft mode** extends .2's `onPatch(value)`. The text commit goes there too, and derived relations and files render read-only. Option and person creation still write. HeadingProperties forwards it as `{[name]: value}`.
  - **`RecordComposer`** (`record-composer`, "New record").
    - `composer-title` autofocuses, and Enter submits.
    - `composer-database` lists non-reserved types, sorted.
    - The heading strip is HeadingProperties over draftEntry, with showEmpty. Changing type resets to initialValues.
    - `similar-records` shows at most two `similar-record` rows from M59.4's `useContentSearch`, and a click opens the page. Unavailable shows `similar-unavailable`, and pending or no hits show nothing.
    - Then `composer-create-more` and Create record.
  - **Create.**
    - ⌘ or Ctrl+Enter submits (dialog-local, D11), and a blank title shows `composer-error`.
    - The path: `createTarget(type, {entries, schema})`, then draftFrontmatter, then `createItem` with `# {title}` in try/catch.
    - Without Create more, the composer closes and opens the page. With it, the title clears, values stay, the title refocuses and a toast shows.
    - A failure toasts and keeps the draft, and a double submit is ignored. No draft or choice is stored.
  - **CreateMenu:** NewRecordDialog renders RecordComposer, so the Knowledge prefill stays, and the stale line goes.
- **Comments to delete:** CreateMenu's "Opens in the record panel, never in Docs." NewRecordDialog's docblock is reworded, and the M1 double-click comment moves with its guard.
- **Tests:**
  - recordDraft.test: each helper, including the fallbacks and widened.
  - FieldEditor.test: draft writes never reach the store; derived relations and files are read-only; without onPatch nothing changes. HeadingProperties.test.
  - RecordComposer.test:
    - reserved names excluded; the type reset; ⌘Enter and Enter create, then open;
    - a blank title; Create more; a failed create; a double submit;
    - similar rows; the unavailable state; no localStorage write.
  - CreateMenu.test.
  - e2e `record-composer.spec.ts`:
    - Work item "Landing page" shows similar "Landing page refresh"; set Priority High; ⌘Enter opens the page, and the file holds backlog, high and the H1;
    - Create more makes Alpha and Beta, keeps High and stays open;
    - with `__cerebroFailSearchVault('down')`, similar-unavailable shows, and Create still writes.
- **Acceptance:**
  - The composer shows the heading fields, prefilled and editable before the record exists, and what you pick is what lands.
  - ⌘Enter and Enter create, and Create more keeps fields and clears the title.
  - At most two similar pages of the chosen database show. A failed search says so. Nothing is stored.
  - The composer never offers Type, Collection, Skill or Agent. D18: the record opens as its page.
- **Wave** 6 · **Depends** M61.1, .2, .3, .3b, .11; M60.3; M59.4; M55.14 · **Size** L (roadmap M, with .6b) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(records): the new-record composer shows heading fields, Create more and similar records (M61.6)`.

### M61.6b `create_note` gains `if_exists: refuse` (new operational code `note_exists`) and lists advisory similar notes

- **What:** WORK-12. `tool_create_note` always numbers a copy, so an agent that re-creates a record silently writes `<slug>-2.md`, and its answer says only "Created {path}". The roadmap's DATA-21 cite is a mislabel. No new tool, no `propose_` name, no D2 hash.
- **Files:** `shared/policy/{policy.v3.json, policy.v3.sha256, tools.v1.json, tools.v1.sha256, README.md}`, `src-tauri/src/vault/write.rs`, `src-tauri/src/{mcp.rs, lib.rs, search.rs, policy/table.rs}`, `src-tauri/src/runtime/operational.rs` (only if it lists codes), `src-tauri/fixtures/write-doors.json`, `src/lib/policy/table.test.ts`, `src/lib/{mockIpc,mockIpc.test}.ts`, `src/agent/{mockAgent,mockAgent.test}.ts`, `src/engine/writeDraft.test.ts`, `SECURITY.md`.
- **Approach:**
  - **policy.v3 (ritual).**
    - `note_exists` joins `rejection_destinies` as operational and `transport_rejections`, both sorted.
    - Regenerate with `policy::table::tests::write_policy_digest -- --ignored`.
    - The README records why: it stops at the write door before a byte and claims nothing, and it isn't `stale_content`, since no hash was named. Fix any stated count.
  - **write.rs.**
    - `IfExists {Suffix, Refuse}`. Suffix numbers as M55.1 left it.
    - Refuse judges `<folder>/<slug>.md` under its path lock, re-checks it there (a case-folded twin counts where the disk folds case) and returns `NoteWriteError::Exists {path}`: no write, temp or `vault_writes` row.
    - lib.rs' human command passes Suffix, so its bytes and words are unchanged.
  - **mcp.rs.**
    - `parse_if_exists`: absent means suffix; exact 'suffix' or 'refuse'; anything else is a plain error naming both values.
    - The governed, knowledge and grant guards run first, unchanged.
    - Then `similar_notes`:
      - the title is the H1, else `title`, else the humanized slug;
      - candidates come from M59.4's `docs_of` over `readable_entries`, minus templates, knowledge/ and the planned path;
      - they share the type (ASCII case-insensitive); with no type, the same folder, and at the root, none;
      - ranked by `rank_query(title, docs, 3)`, and a widened answer lists nothing.
  - **Answers (Appendix A).**
    - Success names a numbered copy.
    - Refusal is isError `note_exists: …` plus the similar block, with one deduped operational row carrying the run id (M54.10's recorder). Nothing is announced.
    - A failed corpus read says "not checked" (CV-05).
  - **tools.v1 (ritual).**
    - create_note gains `if_exists` (enum suffix, refuse) and one sentence. It names no other tool, so M54.8's retired-terms test holds. Rebase, then regenerate `write_tools_digest`.
    - write-doors.json gains one refused agent row.
    - The mock's `agentCreate(…, ifExists = 'suffix')` follows Rust's order and words, with containment matches only (no ranker twin).
    - mockAgent gains `create "<title>" in <folder> if new`, and writeDraft.test gains the select.
    - SECURITY.md: similar notes are read-scoped, and refuse reveals nothing the numbered copy didn't.
- **Comments to delete:** write.rs' `create_note` doc gains "unless if_exists refuses", and `write_concept`'s "does not uniquify" is reworded. Any stated transport-code count in the README is fixed.
- **Tests:**
  - write.rs: refuse leaves bytes, mtime, temps and rows alone; the default still numbers; two refusing creates of one free slug write one file; the case-folded twin.
  - mcp.rs: refuse names the note and records one row, and a repeat adds none; an unknown value is refused; the numbered-copy sentence; at most three similar notes of the type, never itself and never unreadable; the untyped root; guards keep their words; the door and tool replays; `every_served_tool_is_valid_api_input`.
  - policy/table.rs and table.test.ts: `note_exists` is an operational transport code, and the digest passes. mockIpc.test, mockAgent.test, writeDraft.test.
- **Acceptance:**
  - Refuse over an existing slug writes nothing, answers `note_exists` naming the note, records one row per run, and announces nothing.
  - Without `if_exists`, behaviour is unchanged, and the answer says when it numbered a copy.
  - Answers list up to three readable similar notes as advice, and a failed read says "not checked".
  - The code went through the README ritual, and the mock refuses in Rust's words.
- **Live check:** on CLI 2.1.250, an agent that creates an existing note with refuse gets the code and the similar list. Time one call on the owner's vault.
- **Wave** 1 · **Depends** M59.2, .4; M58.1; M57.4, .4b, .4c; M55.1, .3; M54.1, .10 · **Size** M (split from .6) · **Crash risk** no · **Live check** yes
- **Commit:** `feat(mcp): create_note can refuse a taken name and lists similar notes (M61.6b)`.

### M61.7 Promote checklist lines to records in any status-bearing database, reported per line

- **What:** WORK-6, EDITOR-8. Checklist lines only roll up as doc tasks, and nothing turns one into a record. Status-bearing is a capability: a Type with a status field (CV-08). The deadline comes from .3b's `deadline:`. Records are made through `createItem`, so Rust and the mock don't change.
- **Files:** `src/engine/promote{,.test}.ts`, `src/editor/{promoteLines,promoteLines.test}.ts`, `src/editor/PromoteDialog{,.test}.tsx` and `src/app/promoteActions{,.test}.ts` (all new); `src/editor/{MarkdownEditor,SelectionToolbar}.tsx`; `e2e/promote-checklist.spec.ts` (new).
- **Approach:**
  - **`promoteLines.ts`** (BlockNote block JSON).
    - `readChecklistLine` gives `{blockId, checked, title, due, extraDates, people, flattened, onlyLink, text}`:
      - `due` is the first due chip, and `people` are the deduped assignees;
      - the title comes from text, link text and wikilink labels (alias, else M59.6's label), with citation, due and assignee chips dropped;
      - `text` keeps chips as their text (`chipText` forms, trap 10).
    - `promotable` picks checklist blocks.
    - `linkPromotedLines` runs one `editor.transact` and one undo step. Each still-present checklist block becomes a bullet holding one wikilink chip, with its children kept.
  - **`promote.ts`** (pure).
    - `promotionTargets`: types with a status field, minus reserved names, sorted.
    - `promotionMapping`:
      - status; the deadline from `TypeDef.deadline`; person fields in declared order;
      - parents only from a task-like source: the target's stored relations to the source's type, where a same-type relation counts only with `limit: 1`;
      - parentDefault when there is exactly one candidate.
    - `planLine` gives a skip ('empty', 'link') or a plan:
      - status: `initialStatus` active, or done for a checked line;
      - deadline: `serializeDateProperty`; people as links, cut to one on `limit: 1`, with a note; the parent as a stem link;
      - the body keeps the line's text when anything was flattened or unmapped.
  - **`createPromoted`** creates in line order: createTarget, then `createItem` with `recordSlug`. Each failure is caught into its own line, and it never throws.
  - **PromoteDialog** (`promote-dialog`).
    - `promote-target` remembers the last choice in localStorage `cerebro.promoteTarget` (try/catch).
    - `promote-deadline`, `promote-person` and `promote-parent` show selects only when ambiguous.
    - `promote-line` rows; after Promote, a `promote-result` per row (`data-outcome`), then Done. `promote-none` shows when no database tracks status.
  - **MarkdownEditor.**
    - DragHandleButton gets a stable `dragHandleMenu`: BlockNote's four defaults in order plus `promote-line-item`, shown for a hovered checklist block. No side-menu button is added (trap 8).
    - Neither entry shows read-only or without a path.
    - After the creates come `linkPromotedLines` and `scheduleEmit()`, a human save (last write wins).
    - SelectionToolbar gains `selection-promote` after M70.2b's Comment when the selection holds checklist lines.
- **Comments to delete:** none found. MarkdownEditor's M48.4 grip comment gains a clause about Promote, and SelectionToolbar's header gains the non-AI button.
- **Tests:**
  - promoteLines.test (headless `BlockNoteEditor.create`): titles, chips, due, people, onlyLink, text. linkPromotedLines keeps children, skips changed blocks, is one undo step, and serializes `- [[ship-docs]]`.
  - promote.test (targets; mapping for an Epic source, a Work item source and a doc source; planLine cases), promoteActions.test (order, one failure, never throws), PromoteDialog.test.
  - e2e `promote-checklist.spec.ts`:
    - promote `- [ ] Ship docs 📅 2026-10-20 @[[maya-chen]]` from how-we-schedule.md to Work item through the grip;
    - `ship-docs.md` holds backlog, due, assignee and the H1, and the page holds `- [[ship-docs]]`;
    - three lines on an Epic through the toolbar give created, Empty line and Already a link, with epic set;
    - block-drag.spec's Delete stays green.
- **Acceptance:**
  - Roadmap: promoting `- [ ] Ship docs 📅 2026-10-20 @[[person]]` creates a work item with due and assignee set, and rewrites the line as a link.
  - 📅 maps only to a declared deadline and @person only to person fields. What can't map stays in the new page's body.
  - Results are per line: one failure never blocks the rest, and failed lines stay checklist items. A parent is set when unambiguous.
  - D18: each record opens as its page, and the source saves as `- [[stem]]`.
- **Wave** 7 · **Depends** M61.3b, .6; M60.10b; M59.6; M55.14; M70.2b · **Size** M · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(editor): promote checklist lines to records, each line becoming a link (M61.7)`.

### M61.8 Calendar hours, read-only: Day and Week draw timed blocks, point chips and a now line

- **What:**
  - CALENDAR-4 (the roadmap cell's CALENDAR-1 (1a) is relabelled).
  - spanOf drops times, Week is seven tall cells, and there is no Day view or now line.
  - A 22:00 → 00:00 range also covers the next day.
  - M60 handed over two UTC displays: formatTimestamp and DetailPanel's fetched line.
- **Files:** `src/engine/timeGrid{,.test}.ts` (new), `src/engine/{schedule,dates,properties,views}{,.test}.ts`, `src/engine/{dateGrammar,types}.ts`, `src/views/CalendarTimeGrid{,.test}.tsx` (new), `src/views/{CalendarView,ViewSettingsPanel}{,.test}.tsx`, `src/detail/{DetailPanel,DocProperties}{,.test}.tsx`, `e2e/calendar-hours.spec.ts` (new).
- **Approach:**
  - **Midnight ends.**
    - For spanOf, a range that ends at 00:00 on a later day ends on the day before, never before its start.
    - rescheduleValue restores the following midnight on write, so moves and resizes keep it.
    - `dayLabel(iso)` is added.
  - **`timeGrid.ts`** (pure, no clock).
    - `Placement` is allDay `{span}`, timed `{day, start, end, fixed}` or point `{day, at, fixed}`, built by `placementOfValue` and `placementOf`.
    - The rules:
      - no start time → allDay;
      - a start time with no usable end (none, a same-day dateless end, or an end at or before the start) → point;
      - a same-day timed range → timed, and 00:00 the next day → end 1440;
      - any other cross-day range → allDay.
    - `fixed` is true for an instant (dateGrammar's endpoint form, exported if private; no new regex).
    - `packDay` puts overlap clusters into first-free columns, and items under 30 minutes pack as 30.
  - **Local display:** `localDateOf(iso)`. formatTimestamp returns local `YYYY-MM-DD HH:MM`. DetailPanel's fetched line and Created/Modified, and DocProperties' Created/Modified, use local dates.
  - **Day span:** `calendarSpan` becomes `'month' | 'week' | 'day'`, and month is omitted when serialized. ViewSettingsPanel gains Day.
  - **`CalendarTimeGrid`** (read-only).
    - A gutter of 24 rows at 48 px, with the zone in the corner (`calendar-zone`), and one `calendar-hours-day` per day.
    - `calendar-block` carries data-start and data-end, with top start × 0.8 and height max(dur × 0.8, 18). `calendar-point` carries data-at.
    - `calendar-now` (data-minute) sits in today's column and refreshes each minute.
    - The scroller `calendar-hours` is capped at 70vh and opens at 07:00 once (layout effect plus ResizeObserver). It never moves after the reader scrolls.
    - Items are buttons that open the page, with no drag.
  - **CalendarView.**
    - `calendar-span-day`: Day steps one day and heads with dayLabel.
    - Week and Day show the header, one all-day row (the existing markup: DayAdd, bars, whole-day drag) holding allDay placements, then the grid.
    - Month is unchanged. An optional `now` prop serves tests.
- **Comments to delete:** CalendarView's "the month grid, and — since M16.23 — the week grid" and CELL_H's "A week has one row"; types.ts' calendar bullet and "Omitted = a month (M16.23)"; formatTimestamp's UTC doc; schedule.ts' header and spanOf's comment gain the midnight exception.
- **Tests:**
  - timeGrid.test: the placement table; an instant in Sydney and Los Angeles (TZ set and restored); packDay (halves, chains, a full width, a 30-minute point).
  - schedule.test (midnight ends, onDay, rescheduleValue, dayLabel), dates.test, properties.test (two zones; the UTC assertion goes) and views.test.
  - CalendarTimeGrid.test: a block at 480 px and 48 px tall; 50% widths; the now line; scrollTop 336 that holds after scrolling and paging (stubbed clientHeight); a click opens; a drag writes nothing.
  - CalendarView.test (Day; Week's all-day row; timed only in the hours), ViewSettingsPanel.test, DetailPanel.test and DocProperties.test (local dates).
  - e2e `calendar-hours.spec.ts`, with three seeded Work items:
    - standup-sync is a block 600–660 on 07-28; offsite sits in the all-day row;
    - late-deploy is 1320–1440 on 07-28 only, in Week and Month;
    - the now line is at minute 720; scrollTop is 336; Day reads "Tuesday, July 28, 2026".
- **Acceptance:**
  - Roadmap: a 10:00–11:00 record is a block in Week, and a date-only record sits in the all-day lane.
  - Day draws one column, overlaps split into columns, and a timed record with no end is a point chip.
  - 22:00 → 00:00 stays on its first day everywhere. The now line and the 07:00 opening scroll work.
  - Instants show at local wall time, and stamps print local dates. The grid writes nothing.
- **Wave** 1 · **Depends** M60.3; M53.16 · **Size** M · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(calendar): Day and Week draw hours, point chips and a now line (M61.8)`.

### M61.9 Calendar editing: move, resize and drag-to-create by the minute, 30-minute snaps, Escape to abandon

- **What:** CALENDAR-5 (the roadmap cell's CALENDAR-1 (1b) is relabelled). useTimeDrag moves whole days along X only and has no selection gesture, so .8's grid can't be edited, and nothing creates a record at a time of day.
- **Files:** `src/views/useTimeDrag.ts`, `src/views/useTimeDrag.test.tsx` (new), `src/engine/{timeGrid,schedule}{,.test}.ts`, `src/views/{CalendarTimeGrid,CalendarView,DatabaseBlockView}{,.test}.tsx`, `src/views/{QuickAdd,ViewCanvas,ViewTabEmbed}.tsx` (ViewTabEmbed added on review), `src/pages/TypePage{,.test}.tsx`, `src/pages/ListPage.tsx`, `e2e/calendar-hours.spec.ts`.
- **Approach:**
  - **useTimeDrag's minute axis.**
    - Options gain pxPerMinute, snapMinutes (default 30), dayLocked and onSelect.
    - `onCommit(id, edge, days, minutes)` leaves three-argument callers unchanged, and fires only when something moved.
    - Pointer moves snap the change. Days come from `hover`, and are 0 when dayLocked.
    - Keys: ↑ and ↓ move ∓30 minutes; ← and → move ∓1 day unless dayLocked; ⇧↑ and ⇧↓ resize the end.
    - Escape, a window blur or a hidden document abandons (useDragGesture).
  - **Drag-to-create.**
    - `slotProps(day)` applies to empty hours and ignores blocks and grips.
    - The selection runs from min to max + snap, clamped to 0–1440. Release calls onSelect, Escape calls nothing, and the trailing click is swallowed.
  - **Math.**
    - timeGrid: `snapDelta`; `moveTimed` keeps the duration within the day; `resizeTimed` keeps at least 30 minutes; `movePoint` keeps 0–1410.
    - `retimeValue` writes `D HH:MM`, and an end of 1440 is written as the next day at 00:00. A point keeps an open end, and a `date` stays scalar.
    - `createOnDayValue` gains `slot?`: a daterange gets `{start, end}`, and a date or undeclared field gets `D HH:MM`.
  - **CalendarTimeGrid.**
    - It owns `useTimeDrag({pxPerMinute: 0.8, snapMinutes: 30, dayLocked: days.length === 1})`.
    - Blocks get handle props plus 6 px grips (`calendar-block-grip-start|end`). Points move only, and fixed placements get no handles.
    - A commit runs dateKindOf → retimeValue → patchFrontmatter.
    - A new slot shows `calendar-new-slot`, which claims Escape through useLayer. Enter calls `onCreateOn(title, day, {start, end})`.
  - **Plumbing.**
    - ViewCanvas's `onCreateOn` gains `slot?: TimeSlot`.
    - TypePage, ListPage, DatabaseBlockView and ViewTabEmbed forward it to .11's `useCreateOnDay`. With no slot, the three-argument calls hold.
- **Comments to delete:** useTimeDrag's "Everything is measured in WHOLE DAYS" and "Never called with `days === 0`"; CalendarView onCommit's "only ever MOVES" narrows to the month grid and the all-day row; .8's read-only note; createOnDayValue's "the bare day" and useCreateOnDay's "dated to the day" gain the slot.
- **Tests:**
  - useTimeDrag.test (new; MouseEvents with clientY, as GanttView.test does): +20 px commits 30 and +10 px nothing; the keys; dayLocked; a slot from 480 to 560 gives (600, 720); a click gives 600–630; Escape gives nothing.
  - timeGrid.test and schedule.test (clamps, the 30-minute minimum, retimeValue forms, slots).
  - CalendarTimeGrid.test: 24 px down writes 10:30 → 11:30; each grip moves its own edge; the next column moves a day; Escape; keys; a date point; fixed blocks; create and Escape-only-the-input.
  - CalendarView.test, DatabaseBlockView.test (the slot passes; three-argument calls hold) and TypePage.test (a slot writes `D 14:00` → `D 15:00`).
  - e2e:
    - the bottom grip 24 px down writes `end: 2026-07-28 11:30`, and a 48 px move shifts both by an hour;
    - drag-to-create 14:00–15:00 on 07-29 with "Review" writes review.md;
    - Escape leaves bytes identical, and ArrowDown writes +30;
    - one move on Delivery's embedded This month calendar, in Week.
- **Acceptance:**
  - Roadmap: a resize writes HH:MM.
  - Blocks move in 30-minute steps and across days in Week. The grips resize, with a 30-minute minimum. The keys move and resize, and Escape abandons with nothing written.
  - Dragging on empty hours creates a slot record; a click creates 30 minutes. 24:00 is stored as the next day at 00:00 and stays on its day.
  - Points move but don't resize, instants don't move, and month and timeline drags are unchanged.
- **Packaged check:** in WKWebView, a drag, a resize and a drag-to-create write HH:MM, on the type page and on Delivery's embedded calendar.
- **Wave** 7 · **Depends** M61.8, .6, .11; M60.3; M53.16 · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(calendar): move, resize and drag-to-create by the half hour (M61.9)`.

### M61.10 Repeat property: an RRULE subset behind Cerebro's own parse and describe, on upstream rrule

- **What:** CALENDAR-7a (the roadmap cell's CALENDAR-2 is M60.3's grammar). No RRULE exists anywhere. The rule and the property land here, and the grid half is .10b. The Rust expander (7b) is deferred (Q41).
- **Files:**
  - dependency and rails: `package.json`, `pnpm-lock.yaml`, `THIRD_PARTY_NOTICES.md`, `eslint.config.js`, `scripts/lint-rails.test.ts`;
  - artifact and Rust: `shared/schema/{field-kinds.v1.json, field-kinds.v1.sha256, README.md}`, `src-tauri/src/vault/schema.rs`;
  - engine: `src/engine/recurrence{,.test}.ts` (new), `src/engine/types.ts`, `src/engine/{properties,castRules,schema}{,.test}.ts`, `src/engine/{fieldKindTable,fieldKinds}.test.ts`;
  - editor: `src/detail/FieldEditor.tsx`, `src/detail/RepeatEditor{,.test}.tsx` (new), `e2e/calendar-repeat.spec.ts` (new);
  - only if set_fields' kind match is exhaustive: `src-tauri/src/vault/set_fields.rs`, `src-tauri/fixtures/set-fields-cases.json`, `src/engine/setFields.ts`.
- **Approach:**
  - **Dependency (D0).**
    - `pnpm add --save-exact rrule@2.8.1` (BSD-3-Clause).
    - THIRD_PARTY_NOTICES.md (M59.3) gains its version, licence and copyright, copied from the installed LICENSE, and says only `engine/recurrence.ts` uses it.
    - ENGINE_IMPORTS admits `rrule$` with a reason. lint-rails: `import 'rrule'` passes, and a subpath fails.
  - **Kind (ritual).**
    - `repeat` is appended: text, single, filters text, not legacy, message "{name} must be a repeat rule".
    - A value case: a rule passes; 3 and [] are refused.
    - The README says Rust checks only that the value is text.
    - Rust gains `FieldKind::Repeat` in `ALL` and `validate_value`. set_fields gains an arm only if its match is exhaustive, with one case mirrored in setFields.ts.
    - TS: KIND_UI gains Repeat (repeat icon) after Date range; coerceValueToKind keeps understood text, else null.
    - Cast: Checked from the text row (text, email, phone, and the computed rows that copy it); Safe from repeat to text and to repeat; Never otherwise.
  - **`recurrence.ts`** (pure; Macro's file is read for behaviour only).
    - `parseRepeat`: absent gives null; a value is a bare rule line, or `RRULE:` plus `EXDATE:` lines, read case-insensitively.
    - The subset:
      - FREQ is DAILY, WEEKLY, MONTHLY or YEARLY; INTERVAL is 1–999;
      - BYDAY takes an ordinal (±1–5) only under MONTHLY or YEARLY; BYMONTHDAY is ±1–31; BYMONTH is 1–12 under YEARLY;
      - COUNT (1–1000) or UNTIL, never both; WKST is MO or SU.
    - Anything else is not understood, and its reason is kept.
  - **Serialize, describe, expand.**
    - `serializeRepeat` uses a fixed part order and round-trips. Exceptions become one sorted `EXDATE:` line in the anchor's form.
    - `describeRepeat` gives words (Appendix A).
    - `repeatFieldFor` pairs the type's first daterange, else its first date, with `repeatAnchor` and `repeatPresets`.
    - `occurrencesIn` builds an upstream RRule from the parsed rule (never `rrulestr` on raw text), with dtstart as `Date.UTC` of the wall-clock fields read back through `getUTC*`, so results don't depend on zone or DST.
    - Durations are kept and EXDATEs removed. DAILY and WEEKLY fast-forward, and a 5,000-step stop applies.
  - **Display and editor.**
    - resolveField shows the words, "Repeat rule not understood" or ''.
    - FieldEditor's repeat branch opens RepeatEditor (`repeat-editor`): Does not repeat, presets, and Custom… (every N units, weekday toggles, a day of month or nth weekday, ends never, on a date or after n).
    - Done writes `serializeRepeat` with the existing exceptions kept, and Does not repeat writes null.
    - A rule that isn't understood shows its raw text and the presets. With no anchor, only Clear is offered.
- **Comments to delete:** every prose kind count in the README, castRules.ts and castRules.test.ts becomes "every kind", if .4 left any.
- **Tests:**
  - recurrence.test:
    - parse tables with reasons; describe; round trips;
    - occurrencesIn: WEEKLY TU; the 31st skips short months; the last Friday; COUNT across windows; UNTIL inclusive; EXDATE;
    - a 2000 anchor; identical results under Sydney and Los Angeles across both DST days;
    - only recurrence.ts imports rrule.
  - properties.test, fieldKindTable.test, fieldKinds.test, castRules.test (`FREQ=WEEKLY;BYDAY=TU` converts; "every Tuesday" doesn't), schema.test.
  - RepeatEditor.test: presets for a Tuesday; Weekly writes `FREQ=WEEKLY;BYDAY=TU`; custom rules; COUNT and UNTIL; null; EXDATE kept; raw text; no anchor.
  - schema.rs (value cases, `a_repeat_value_must_be_text`, the digest, the enum check) and lint-rails.test.
  - e2e `calendar-repeat.spec.ts`, seeding a Standup type:
    - daily-standup reads "Weekly on Tuesday and Thursday"; Every weekday writes `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`;
    - odd-sync (BYSETPOS) reads "Repeat rule not understood" and shows its raw text;
    - Does not repeat removes the key.
- **Acceptance:**
  - Roadmap (property half): an RRULE subset behind Cerebro's own parse and describe, on upstream rrule, attributed.
  - The property reads in words. Presets and custom rules write fixed-order RRULE text, and hand-written exceptions survive edits.
  - A rule outside the subset reads "not understood" and is never rewritten unless replaced. Occurrences are the same in every zone.
  - The kind is shared data, and Add property offers Repeat. The value is plain RRULE text, native to ICS.
- **Wave** 9 · **Depends** M61.4; M60.3–.5; M59.3; M53.20 · **Size** L · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(databases): a Repeat property holds an RRULE subset, described in words (M61.10)`.

### M61.10b Repeating records in the calendar: read-only occurrences, This event / All, unknown rules render once

- **What:** the grid half of the roadmap's M61.10 row: "Occurrences are read-only in the grid, with This event / All in the editor. Unknown rule parts render once with 'repeat rule not understood'."
- **Files:** `src/engine/recurrence{,.test}.ts`, `src/views/{CalendarView,CalendarTimeGrid}{,.test}.tsx`, `src/views/OccurrenceMenu{,.test}.tsx` (new), `src/app/recurrenceActions{,.test}.ts` (new), `e2e/calendar-repeat.spec.ts`.
- **Approach:**
  - **Expansion.**
    - `expandForCalendar(entries, field, schema, window)` is memoized per entries, field and window.
    - A type that pairs a repeat field with the view's date field, holding an understood rule, yields one item per occurrence; any other record yields one item.
    - Both grids place items through spanOf and placementOfValue, keyed `${path}@${date}`.
  - **Marks.**
    - Occurrences carry `data-occurrence` and a repeat glyph, and get no drag props, grips or keys; their aria-label adds "repeats".
    - A rule that isn't understood renders once, with `data-repeat="not-understood"` and circle-alert, and doesn't drag. `data-count` counts occurrences.
  - **OccurrenceMenu** (`occurrence-menu`, a Popover with role dialog).
    - It shows the title, the date and time line, and the rule's words, with `occurrence-this` and `occurrence-all`.
    - Escape or an outside click closes it (useDismiss).
    - A click or Enter on an occurrence opens the menu. A not-understood record opens its page, and All events opens the series.
  - **`detachOccurrence`** (`app/recurrenceActions.ts`, never throws).
    - It flushes pages and reads the series with `readNoteSource`; a failed read toasts and stops.
    - Pure `planDetach` builds two ops:
      - (a) patch the series' repeat with this start added as an EXDATE (YYYYMMDD, or a floating YYYYMMDDTHHMMSS), carrying the read's hash (D2: `stale_content` refuses all);
      - (b) create the page.
    - The new page:
      - its folder comes from createTarget with no host;
      - it copies the declared stored fields and PAGE_CHROME_KEYS, minus repeat, date, computed, `from` and `key`;
      - its date is the occurrence, keeping times and duration;
      - it gets a fresh key when the series holds an item key;
      - its slug is `{stem}-{YYYY-MM-DD}` (with -2 and so on); its body is `# {Title}` plus the Split-from line, through .5's `composeNote`.
  - **Apply.** `applyBatch(ops, {undo})`. One Undo restores the series and trashes the page. Success opens the new page, and null does nothing. The detached page is then an ordinary record.
- **Comments to delete:** CalendarView's "A record appears on every day its span covers" gains "and on every day its repeat rule names". Any M61.10 note saying calendars don't draw occurrences yet goes.
- **Tests:**
  - recurrence.test: expandForCalendar (pairing, window, not understood, none, memo); planDetach (patch before create, EXDATE form, hash, the page's fields, key, slug collision, body).
  - recurrenceActions.test (a failed read; one labelled batch; open on success; never throws), OccurrenceMenu.test.
  - CalendarView.test: TU,TH shows on Jul 28, Jul 30, Aug 4 and Aug 6; drags and keys write nothing; a click opens the menu; not understood shows once. CalendarTimeGrid.test (blocks without grips).
  - e2e:
    - Month shows the four days, and Week shows 09:00 blocks;
    - This event on Aug 4 creates the page (09:00 → 09:15, Split from), and the series gains `EXDATE:20260804T090000`;
    - Undo trashes the page and restores the series byte-identical;
    - odd-sync shows once; All events opens the series.
- **Acceptance:**
  - Roadmap: occurrences are read-only in the grid, with This event / All, and unknown rule parts render once with "repeat rule not understood".
  - This event is one undoable batch, and a series changed since its read refuses it as `stale_content`.
  - This event works when the database's home folder doesn't exist yet; the batch makes it (M60.6, or .5's fix).
  - Both objects open as pages, and both files round-trip.
- **Wave** 10 · **Depends** M61.5, .8, .9, .10, .11; M60.6, .7, .9, .10; M55.2, .11 · **Size** M (split from .10) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(calendar): repeating records draw every occurrence, and This event makes one its own page (M61.10b)`.

## Done or dropped

- **Done:** none. **Dropped:** none; all 11 roadmap parts build.
- **Split**, each by its own roadmap sentence:
  - .2 → .2b (Add existing);
  - .3 → .3b (deadlines, My work) and .3c (relative filters);
  - .4 → .4b (skipped footers);
  - .5 → .5b (export);
  - .6 → .6b (`if_exists`);
  - .10 → .10b (the grid half);
  - .11 → .11b (progress).
- **Relabelled:**
  - M61.6's DATA-21 → none; DATA-21 is Recently deleted, M60.8's Trash, and .6b builds WORK-12;
  - M61.8's CALENDAR-1 (1a) → CALENDAR-4, and M61.9's CALENDAR-1 (1b) → CALENDAR-5;
  - M61.10's CALENDAR-2 → CALENDAR-7a.
- **Beyond the roadmap, on purpose:**
  - .11: every view tab creates, and keys match case-insensitively.
  - .1: counts dedupe, with an overlap caption.
  - .2: per-row pre-reads with hashes.
  - .2b: reciprocal edits become one batch.
  - .3: the back scale and ghost bands.
  - .3b and .3c: Rust readers ahead of M62.
  - .4: inputs can't be deleted or retyped.
  - .4b: every numeric column.
  - .5: select inference.
  - .5b: the formula guard.
  - .6: the first active status.
  - .7: the parent relation.
  - .8: local stamps and the Day span.
  - .9: keyboard moves.
  - .10b: This event detaches a page.
- **Not built unless asked or measured:**
  - CALENDAR-7b, the Rust expander (Q41); "This and following"; deleting one occurrence without a page;
  - autoscroll near the grid's edges; dragging between the all-day row and the hours;
  - Date range creatable again (Q30); a per-view week start (Q19); a pairing key for types with several dates;
  - bulk add/remove on multi-value fields (Q14); splitting a CSV over the cap (Q26); import provenance (D15, M69);
  - formula inputs beyond number, date and formula (Q34); Rust formula evaluation (Q37);
  - DATA-19, rectangle select (M58 pointed it at M60/M61, and no row builds it);
  - UTC stamps in InboxPage and CollectionPage, each a one-line follow-up.

## Owner questions

Each default applies if unanswered. Ask a wave's questions before it starts (Before wave 1).

| # | Part | Question | Default taken |
| --- | --- | --- | --- |
| Q1 | .11 | The Docs tab: the Spec database scoped to the project, or every page naming it through any relation (a new tab kind)? | Spec. Untyped pages under a project stay its sub-pages (M55.13). |
| Q2 | .11 | Where does work created from a project land? | Its database's home (records/work-items/), filed by `project:`. |
| Q3 | .11 | Mint PREFIX-N only for task-like records under a keyed host? | Yes; a Spec made from Docs gets no key. |
| Q4 | .11 | File all 45 demo items under their folder's project (WORK-16)? | Yes, as a test change. |
| Q5 | .11 | An empty related tab reads "No records yet / Create the first one below", reversing M45.4 for related tabs? | Yes. |
| Q6 | .6b | Agents' `create_note` default on a taken name: suffix or refuse? | Keep suffix; refuse is opt-in; every answer lists similar notes. |
| Q7 | .8 | Week becomes the hours grid (an all-day row, then hours) instead of seven tall cells? | Yes; Month stays the date overview. |
| Q8 | .8 | Day is a third Calendar span (`calendarSpan: day`), not a new view kind? | Yes. |
| Q9 | .11b | Closed (cancelled) work leaves progress's denominator? | Yes, as in Linear and Plane. |
| Q10 | .11b | Name it "Percent done", over a status or checkbox property only? | Yes. |
| Q11 | .1 | A drop on No <field> from a multi-value band: remove only that value, or clear all (Macro)? | Only that value. |
| Q12 | .1 | Donut arcs proportion by band values while the centre counts distinct records, with a caption? | Yes. |
| Q13 | .2 | Bulk Set sends one batch for the rows that pass, not independent writes? | One batch (CV-38). |
| Q14 | .2 | Set replaces multi-value fields, with no bulk add or remove? | Replace; deltas stay with `set_fields` and the record panel. |
| Q15 | .2 | Delete keeps a record changed since the table showed it selected, and names it? | Yes. |
| Q16 | .2 | Duplicate stays per-record creates, with no batch and no Undo? | Yes. |
| Q17 | .2b | On a single-link relation, Add existing moves a record out of its old project and counts it? | Yes, as Macro does. |
| Q18 | .2b | Derived-relation edits become one unlabelled batch, with no Undo toast per toggle? | Yes. |
| Q19 | .3 | Weeks start on Sunday for buckets and .3c's filters, while a Monday calendar keeps Monday for its grid only? | Yes; a per-view week start is a later S part. |
| Q20 | .3 | Multi-day bands take no create, and refuse drops with a toast? | Yes (WORK-5). |
| Q21 | .3 | The bucket sets: forward Earlier … Later, and back Today … Older? | Yes. |
| Q22 | .3b | A finished record past its deadline: Overdue or Earlier? | Earlier. |
| Q23 | .3b | Declare `deadline: due` on demo-vault's Work item? | Yes; a test change, and the golden regenerates. |
| Q24 | .3b | My work: deadline sections, then "Not a date", then by database for work with no deadline? | Yes. |
| Q25 | .3b | Name `deadline:` in the product brief? | No: that churns the prompt goldens; M62.2's `describe_database` names it. |
| Q26 | .5 | A CSV over the batch cap (1,999 rows): refuse, or split into several batches? | Refuse in words: one import, one undo. |
| Q27 | .6 | New records (composer and .7) start in their database's first active status? | Yes, prefilled and editable. |
| Q28 | .3c | Grammar: today, tomorrow, yesterday, today±N days, and this, last and next week and month; no years and no `overdue` token? | Yes; it grows only with cases. |
| Q29 | .3c | Land the Rust resolver now, with no caller until M62.2? | Yes, so dates.v1 stays a complete twin. |
| Q30 | .9 | Make Date range creatable again (drop `legacy`), so new databases hold durations? | Not in M61: a follow-up S part beside the Meeting risk. Until then a date field gets a point. |
| Q31 | .9 | Exact-moment (instant) values stay read-only in the grid? | Yes; a drag would rewrite an instant as floating time. |
| Q32 | .7 | Which relation is "subtask"? | Only from a task-like source: the target's single relation to the source's database (same database only with `limit: 1`). With several, the dialog asks, defaulting to none. |
| Q33 | .7 | A promoted line becomes a bullet holding `[[stem]]`, or a page card? | The bullet, children kept. |
| Q34 | .4 | Formula inputs: number, date and formula fields only? | Yes; it grows only with cases. |
| Q35 | .4 | Refuse deleting or retyping in place a property a formula reads? | Yes, naming the formula; Convert stays. |
| Q36 | .4 | Date arithmetic: numbers count days (fractional, kept to the minute), and date − date counts days? | Yes. |
| Q37 | .4 | Formula evaluation stays TS-only until M62.2 decides? | Yes. |
| Q38 | .4b | Numeric footers count blank cells as skipped? | Yes (CV-05). |
| Q39 | .5b | Guard formula-looking text cells with a leading apostrophe? | Yes, text cells only. |
| Q40 | .10 | A `repeat` kind holding RRULE text, with exceptions as EXDATE lines, paired with the first daterange, else the first date? | Yes. |
| Q41 | .10 | Defer the Rust expander (CALENDAR-7b) until `list_agenda` or reminders need it? | Yes; M62.3 marks a repeating row "repeats". |
| Q42 | .10b | Ask This event / All in a popover on the occurrence, or in a bar on the opened page? | The popover. |
| Q43 | .10b | A detached occurrence takes the series' fields but not its body, and links back with "Split from"? | Yes. |

## Risks

- **Size:** 10 L + 8 M + 1 S ≈ 14 L, about twice the roadmap. Seams if a part outgrows L:
  - .1: the count changes as .1c;
  - .3: the Dates block and the dueBucket projection as .3d;
  - .4: the editor as .4c;
  - .6: Similar records as .6c;
  - .9: drag-to-create and the slot plumbing as .9b;
  - .10: RepeatEditor as .10c.
- **Counts change** (a roadmap risk):
  - a multi-value record shows in every band, so boards and lists show more cards than records; charts say so, but tables don't;
  - numeric footers say "N skipped";
  - .1 moves the tests that assert band counts.
- **Demo churn:** .11 edits 47 demo files plus the golden, and .11b and .3b edit Type docs again. Every spec that reads project.md or work-item.md must hold. M60.11's packaged diff grows from 49 to 50 files.
- **D3 twins and their gaps:**
  - two Rust readers have no caller yet;
  - M62.2 must evaluate formula fields or refuse filters on them by name;
  - M62.3 must move the midnight-end and point rules into a case file;
  - repeats stay TS-only until CALENDAR-7b, so `list_agenda` and reminders see a repeating record once.
- **Two formula dialects (D13):** the README states the boundary, and M67 must not reuse .4's parser. Kinds 18 and 19 ripple through FIELD_KINDS, the cast rows, `FieldKind::ALL` and the tripwires. Append, never insert.
- **Clock and zones:**
  - Today and Tomorrow band keys, and memoized surfaces, re-key on the next render, scan or navigation after midnight;
  - vitest has no TZ pin, so every local-time assertion sets and restores `process.env.TZ`;
  - weeks start on Sunday except in a Monday calendar's grid;
  - a board drop rewrites an instant as local wall time (.3); the grid won't drag one (Q31).
- **Meeting declares a scalar `date`** (a roadmap risk): demo meetings sit in the all-day lane, and a timed meeting is a point chip until Q30.
- **Embedded calendars and drags:**
  - a page's database block is a BlockNote custom block, where a React `onPointerDown` may never fire (DOM trap 9);
  - .9's e2e drags on Delivery's embedded calendar. If it's dead, useTimeDrag binds pointerdown natively through a ref, as ColumnGutter does.
- **WKWebView unknowns:** the file input (.5, with a `pick_csv_file` fallback), the save dialog (.5b) and pointer drags (.9). The packaged checks decide.
- **Stale refusals and drafts:**
  - a write landing between a pre-read and its batch refuses the whole batch, and everything stays selected or staged (.2, .2b, .10b);
  - bulk actions pay N reads, eight at a time;
  - draft editors (.2, .6) still create options and people for real, as explicit acts.
- **Undo gaps:**
  - two undo stacks (.7): ⌘Z in the page restores the lines, and the records stay (Trash them);
  - calendar drags stay single-cell: last-write-wins and not undoable (M60.7 Q17).
- **Hot files** (the waves serialize them; parts in wave order):

  | File | Parts |
  | --- | --- |
  | FieldEditor.tsx | .11, .2, .2b, .6, .4, .10 |
  | types.ts | .8, .11b, .3, .3b, .4, .10 |
  | field-kinds.v1.json, its sha256, shared/schema/README.md, fieldKindTable.test.ts | .11b, .3, .3b, .4, .10 |
  | TableView.tsx | .1, .2, .3, .4, .4b |
  | vault/schema.rs | .11 (if), .11b (if), .3b, .4, .10 |
  | properties.ts | .8, .11b, .4, .10 |
  | schema.ts | .11b, .3b, .4, .10 |
  | grouping.ts, BoardView.tsx | .1, .3, .3b |
  | ChartView.tsx | .1, .3, .3c |
  | createRecord.ts | .11, .1, .3 |
  | ViewCanvas.tsx | .11, .1, .9 |
  | ViewTabEmbed.tsx | .11, .2b, .9 |
  | CalendarView.tsx, CalendarTimeGrid.tsx | .8, .9, .10b |
  | fieldRefs.ts | .3, .3b, .4 |
  | castRules.ts | .4, .10 |
  | typeActions.ts, PropertyEditor.tsx | .3b, .4 |
  | shared/policy/README.md | .6b, .3b, .3c, .4 (if) |
  | scan golden, demo Type docs | .11, .11b, .3b |
  | lib.rs, mockIpc.ts | .6b, .5b |
  | TypePage.tsx, ListPage.tsx | .9, .5b |
  | QuickAdd.tsx | .11, .9 |
  | schedule.ts, timeGrid.ts | .8, .9 |
  | AGENTS.md | .11, .5 |

- **Changes the owner will see:**
  - project pages with Tasks, Docs and Progress; every view tab creates; new project work gets the next key (.11, .11b);
  - a record in every band it holds; drags move one value; charts name double counts (.1);
  - Set… in tables, and bulk actions that keep failures selected and say why; Add existing on related tabs (.2, .2b);
  - date bands (.3); My work leading with Overdue; `deadline: due` on Work item (.3b); relative date filters (.3c);
  - a Formula property, and footers that say "N skipped" (.4, .4b);
  - Import CSV and Export as CSV… (.5, .5b);
  - the new record composer (.6), and agents' `create_note` that can refuse and lists similar notes (.6b);
  - Promote to record… (.7);
  - Week and Day hours with a now line, local stamps, and drag, resize and create by the half hour (.8, .9);
  - a Repeat property, occurrences, and This event / All events (.10, .10b).
- **Left open on purpose:**
  - the Rust expander (Q41) and Rust formula evaluation (Q37);
  - Date range stays legacy (Q30), and Meeting keeps `date`;
  - calendar drags are not undoable;
  - Sunday weeks (Q19);
  - UTC stamps in Inbox and Collection pages;
  - the Agents and Runs tabs on projects (M63.4).

## Gate

- **Each part,** before its commit:
  - `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test:run`. .11b, .3, .4 and .10 add `pnpm test:coverage`.
  - Parts that run cargo (.11, .11b, .6b, .3, .3b, .3c, .4, .5b, .10, and .5 with the batch.rs fix) add `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and the skip-listed `cargo test`. .11 and .3 run cargo only for the golden or the digest.
  - `PORT=<free> pnpm e2e <specs>`, once `lsof -iTCP:<port> -sTCP:LISTEN` shows the port free:

    | Part | Specs |
    | --- | --- |
    | .11 | `project-pages`, `view-tabs`, `one-workspace`, `pipeline`, `collections`, `database-rename`, `field-rename`, `smoke` |
    | .11b | `project-pages`, `collections` |
    | .1 | `board-multi-value`, `smoke`, `collections`, `view-tabs` |
    | .2 | `bulk-set`, `batch-writes`, `undo`, `trash`, `collections` |
    | .2b | `add-existing`, `project-pages`, `view-tabs` |
    | .3 | `date-bands`, `collections`, `view-tabs` |
    | .3b | `deadlines`, `date-bands`, `collections`, `view-tabs`, `workspace` |
    | .3c | `relative-filters`, `collections` |
    | .4, .4b | `formula`, `collections` |
    | .5 | `csv-import`, `undo`, `collections` |
    | .5b | `csv-export`, `collections` |
    | .6 | `record-composer`, `smoke`, `collections` |
    | .6b | `agent-writes`, `agent` |
    | .7 | `promote-checklist`, `block-drag`, `ai-block` |
    | .8, .9 | `calendar-hours`, `collections` |
    | .10 | `calendar-repeat`, `collections` |
    | .10b | `calendar-repeat`, `calendar-hours` |

- **Each wave tip:** the same gate on the branch, with the full e2e suite.
- **M61 closes when:**
  - the full gate passes on the tip, with `pnpm test:coverage` holding or raising every floor;
  - CI is green on the push;
  - every roadmap M61 acceptance bullet holds;
  - the owner has run the packaged checks (.5, .5b, .9) on a `./scripts/mac-build.sh` build and the live check (.6b) on CLI 2.1.250, and has looked at the built app;
  - the roadmap's M61 status is updated with the splits and the relabels.

On the Mac, cargo always runs as:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -- --skip crash --skip killed_ \
  --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite
```

## Appendix A — words the owner reads

- **.11:** an empty related tab reads "No records yet" / "Create the first one below". A tab whose saved view has filters keeps "Nothing matches".
- **.11b:**
  - calc "Percent done";
  - hint "Percent done reads a status or checkbox property."
- **.1:**
  - toasts:
    - "Moved to {target}" (single value);
    - "Moved from {source} to {target}" (multi value);
    - "Removed {source}" (to No value);
    - "Moved to {lane} · {target}" (lane);
  - caption "1 record counted more than once" / "{n} records counted more than once".
- **.2:**
  - "Set…" · "Set on {n} records" · undo label "Set “{Field}” on {n} records";
  - reasons:
    - "{Type} has no {Field}";
    - "“{label}” isn't one of {Field}'s options";
    - "couldn't be read";
    - "changed since the table showed it";
    - "the change didn't go through";
    - "more than {cap} at once";
  - toast "{k} already had it.";
  - report "Couldn't {set|delete|duplicate} {n}: “{title}” ({reason}), …" (three named), then " and {r} more.";
  - "Duplicated {n} records" · M60.7's "Moved {n} records to Trash".
- **.2b:**
  - "Add existing" · "Add {n} records" · "Selected · {n}";
  - error "{n} couldn't be added. {first reason}";
  - undo label "Added {n} records to “{host}”".
- **.3:**
  - forward bands: "Earlier" · "Today" · "Tomorrow" · "This week" · "Next week" · "Later";
  - back bands: "Later" · "Today" · "Yesterday" · "Past 7 days" · "Earlier this month" · "Last month" · "Older";
  - calendar bands: "Jul 26 – Aug 1, 2026" · "July 2026" · "2026";
  - refusals:
    - "Can't move to “{band}”: it spans several days. Set {Field} on the card instead.";
    - "Can't move to “{band}”: it isn't a date.";
  - settings: "{Field} by", with Relative, Day, Week, Month and Year;
  - footnote: "A property bands records by its value, a date by its bucket. A relation (↳) nests them under what they link to."
- **.3b:**
  - "Overdue" · "Not a date";
  - switch "Deadline", hint "Open records past this date show as Overdue, in My work and on boards grouped by it.";
  - toast "Couldn't update {Type}'s deadline".
- **.3c:**
  - chips: "Due is on or before today" · "Due is this week" · "Due is between 7 days ago and today";
  - words:
    - "today" · "tomorrow" · "yesterday";
    - "1 day ago" / "{n} days ago" · "1 day from now" / "{n} days from now";
    - "this week" · "last week" · "next week" · "this month" · "last month" · "next month";
  - editor: "Relative" · "days ago" · "days from now" · "Exact date".
- **.4:**
  - "Formula" · message "{name} is computed and can't be edited";
  - live line: "Returns a number" · "Returns a date" · "Write a formula over this database's number and date properties.";
  - "Save formula";
  - problems:
    - "“{text}” can't be part of a formula.";
    - "Close “{” with “}”." · "Close “(” with “)”." · "There's a “)” with no “(” before it.";
    - "The formula stops after “{op}”." · "Put an operator between “{a}” and “{b}”.";
    - "{Type} has no property called “{name}”.";
    - "{Field} is a {kind} property; formulas read number, date and formula properties.";
    - "{Field} reads this property back, so it can't be used here.";
    - "Formulas can't nest more than 32 deep.";
    - "A date can't be negative.";
    - "Two dates can't be added; subtract them to count the days between.";
    - "A date can't be subtracted from a number.";
    - "Only numbers can be multiplied or divided.";
  - cast: "The formula “{Formula}” reads {Field}; change that formula first.";
  - rename flag: "Not changed: the formula “{Formula}” couldn't be read.";
  - delete: "Can't delete “{Field}”: the formula “{Formula}” reads it. Change that formula first." plus " and {n} more".
- **.4b:**
  - "· {n} skipped";
  - titles "{n} rows have no number here, so the {calc} leaves them out." / "1 row has no number here, so the {calc} leaves it out."
- **.5:**
  - "Import CSV" · "Import a CSV" · "Choose a CSV file" · "{n} records · {b} blank rows skipped · {u} untitled" · "Import {n} records";
  - file problems:
    - "The CSV is empty." · "The CSV needs a header row." · "The CSV has a header and no rows.";
    - "Row {n}: a quote is never closed." · "Row {n}: text follows a closing quote.";
    - "Row {n} has more values than the header." · "Row {n} holds a NUL character.";
    - "A CSV can hold up to 100 columns; this one has {n}." · "Column {n} has a name longer than 200 characters.";
    - "Choose a CSV smaller than 16 MB.";
    - "This file isn't UTF-8 text. Save it as “CSV UTF-8” and choose it again.";
  - cap problems:
    - "One import can create up to {max} records; this CSV has {n} rows.";
    - "This import would write {x} MB; one change can write up to 16 MB.";
  - names: "Name the database." · "A database named “{name}” already exists." · "“{name}” is a name Cerebro reserves — choose another.";
  - undo label "Imported {n} records into “{name}”".
- **.5b:**
  - menu "Export as CSV…";
  - toasts "Exported {n} rows to {file}" · "Couldn't export the view: {reason}".
- **.6:** "New record" · "Database" · "Similar records" · "Couldn't check for similar records." · "Create more" · "Create record" · "Give it a title" · "Created “{title}”" · "Couldn't create “{title}”".
- **.6b:**
  - success suffix: " ({planned} was taken, so this note is {path})";
  - similar block: "Similar notes already in the vault (advice only; nothing was merged):", then "- {path}: {title}";
  - refusal: "note_exists: {planned} already exists, so nothing was written. Read it and change it there, or call again with if_exists \"suffix\" for a numbered copy beside it.";
  - failed read: "Similar notes: not checked ({reason}).";
  - `if_exists` description: "What to do when <folder>/<slug>.md already exists: \"suffix\" (the default) writes a numbered copy beside it; \"refuse\" writes nothing and names the existing note.";
  - tool sentence: "The answer may list up to three existing notes of the same type with matching titles, as advice; nothing is merged."
- **.7:**
  - "Promote to record…" · "Promote to records" · "Promote {n} lines" · "Done";
  - none: "No database tracks status yet. Add a Status property to one first.";
  - notes:
    - "The date stays in the page: {db} has no deadline field.";
    - "The people stay in the page: {db} has no person field.";
    - "Kept the first person: {field} holds one.";
  - skips "Empty line" · "Already a link";
  - changed line: "The record exists, but the line changed, so it wasn't linked."
- **.8:**
  - heading "Tuesday, July 28, 2026";
  - aria "{title}, {Tue Jul 28}, 10:00 AM to 11:00 AM", plus ", shown in your time" for an instant.
- **.9:**
  - slot "New record on {day} at {10:00 AM}";
  - fixed title "Stored as an exact moment; open it to change".
- **.10:**
  - "Repeat" · message "{name} must be a repeat rule";
  - words: "Daily" · "Every 3 days" · "Weekly on Tuesday" · "Every 2 weeks on Monday and Thursday" · "Every weekday" · "Monthly on the 15th" · "Monthly on the last day" · "Monthly on the first Friday" · "Annually on July 28" · "Annually on the first Monday of September";
  - suffixes " · 10 times" · " · until Dec 31, 2026" · " · 1 exception";
  - "Repeat rule not understood";
  - editor:
    - "Does not repeat" · "Custom…" · "Every weekday (Monday to Friday)";
    - "Repeat rule not understood — Cerebro shows this record once, on its date.";
    - "Repeats start from {Date field}: give it a date first."
- **.10b:**
  - menu: "{Tuesday, August 4} · {9:00 AM – 9:15 AM}" · "This event" / "Make this one its own page" · "All events" / "Open the repeating record";
  - body: "Split from [[{stem}]]: the {Tuesday, August 4, 2026} occurrence.";
  - undo label: "Made {Tue, Aug 4} of “{title}” its own page".
