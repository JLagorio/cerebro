# M62 — Agents query your data

**Goal.** Agents read databases the way views do. They describe a database and query its records with the filter JSON views store, evaluated in Rust and held to the TS view by shared cases. They list an agenda across dated records, and suggest a view the person adds as a tab in one click. Other MCP clients on this Mac may use the vault through Cerebro's guarded tools: opt-in, off by default (D17).

Roadmap: `2026-10-12-macro-port-roadmap.md`, § M62. House style and rails: the M53–M61 and M70 plans.

**Read first (Macro, behaviour only), by part:** .2 `crates/databases/src/inbound/toolset/describe_database.rs`, `crates/databases_sql/src/toolset/query_database.rs`, `crates/databases_sql/src/view_only.rs`, `apps/docs/AI/mcp/tools/query-database.mdx`, `describe-database.mdx`, `apps/web/src/lib/core/database-sql/driver.ts`, `answer.ts` (truncation, tables read) · .3 `crates/calendar_events/src/inbound/toolset/list_calendar_events.rs`, `crates/calendar_events/src/domain/team_availability.rs` (never infer free time) · .5, .5b `crates/user_api_key/src/domain/models.rs`, `service.rs`, `services/mcp_service/src/main.rs` (Host checks) · .5c `apps/web/src/lib/core/component/AI/component/mcpConstants.ts`.

## Status

- **Precondition:** M53–M57, M70, M58, M59, M60 and M61 are closed, in that order, with green gates and updated roadmap statuses. They are being built unstaged in this checkout today, so this plan names their finished functions, never today's lines.
- **Implementation, 2026-10-15:** .1 and .2 are built. The independent filter oracle covers all 19 field kinds; Rust structured database reads replay the shared filter/number cases and the actual Work item view's expected paths. The two tools are registered, read-scoped and read-only. .4 and .4b are built: checked suggestions become live, inert preview cards with one-batch tab creation and optional page placement. .3 is active; .5–.5c remain. New work stays unstaged and uncommitted at the owner's request.
- **Verification:** .2 has 33 focused Rust tests, 90 TS replay tests and the twin rails passing, plus clean Rust formatting and clippy. .4 adds 64 focused Rust tests and 89 authored shared cases replayed in Rust and the engine/mock; the wider TS regression groups pass. .4b has 103 focused tests, all three typechecks and four browser flows passing, including real preview scrolling, a seven-record board/number chart, closest-name refusal, and one Undo restoring both files byte for byte. The integrated gate and isolated CLI checks remain outstanding.
- **Effort:** 2 M + 6 L ≈ 7 L; the roadmap said ≈3.5 L. Re-measured: .3 M → L; .4 M → .4 + .4b (L each); .5 L → .5 and .5b (L) plus .5c (M).
- **Crash risk:** .5 (a schema step that rebuilds `runs.cause`) and .5c (a session's end spawns bounded git through M58.3).
- **Packaged checks:** .4b, .5, .5b, .5c. **Live checks** (the owner's: CLI 2.1.250, an isolated `CLAUDE_CONFIG_DIR`, never the main `~/.claude`): .2, .3 (optional), .4, .5b, .5c.
- **Schema steps:** one, .5's: the next free `user_version` at build time (v26 if M54–M61 and M70 took only their planned steps). **New refusal codes:** none. **New CV ids:** one, .5b (CV-42 if M53–M61 land as planned). **New dependency:** none; `rand`, `sha2`, `chrono-tz`, `iana-time-zone` and `tiny_http` are already in Cargo.toml.
- **Artifacts:** `tools.v1` bumps four times (.2, .4, .3, .5, in wave order); `views.v1` is new (.4). New case files, prettier-formatted with no digest: `filter-cases.json` (.2), `agenda-cases.json` (.3), `view-suggestion-cases.json` (.4), `client-tokens.json` (.5).
- **IPC:** five new commands, three in .5 and two in .5b, each with its adapter and caller (CV-18). .1–.4b add none.
- **demo-vault:** untouched. Demo counts in tests (45 Work items, 39 and 20 agenda entries, 7 overdue cards) are re-counted on each part's tip; a changed count is a test change.
- **Closes left-open items:**
  - the roadmap's first M62 risk, virtual-field precedence: settled by M60.1's one read and M60.3's pinned order;
  - M61 Q37 (Rust refuses formulas by name, .2) and Q25 (`describe_database` names `deadline:`, .2);
  - M61's no-caller Rust readers: `resolve_relative` (.2) and `deadline_field` (.2, .3);
  - M61's risk that the point and midnight-end rules move into a case file, and Q41's "repeats" (.3);
  - M54's "GET → 405 belongs on the client port" (.5b).

## Decisions

- **Owner decisions,** as they bind M62:
  - D0: Macro is read for behaviour only, with no copied code, names, words or fixtures. The case files are our own.
  - D1: query, agenda and suggestion calls write nothing. Accept is a `human:me` batch (.4b). A client session books its own run under actor `client:<slug>` (.5b).
  - D2 (c): Accept's Type-doc patch and page `replace_file` carry their read hash; a mismatch refuses the batch as `stale_content` (.4b). Clients write through the same tools, so `edit_note` and `set_fields` keep `expect_hash`. Human saves stay last-write-wins.
  - D3 (a), under M55.5's ruling as M60.3 extended it: each twin is a case file or artifact, replayed by cargo and vitest and listed in `shared/policy/README.md`'s registry:
    - `filter-cases` (.2): the view filter and sort, plus .1's decimal number grammar;
    - `agenda-cases` (.3): points, midnight ends, open and backwards ranges, repeat pairing;
    - `views.v1` and `view-suggestion-cases` (.4): the view vocabulary and the suggestion check;
    - `client-tokens` (.5): token names and grants, Rust and the mock.

    TS-only, so no twin: the oracle (.1, a test), formula and rollup evaluation (Rust refuses them by name), recurrence expansion, time-grid geometry.
  - D4 (a): no transport change. The client port (.5b) is a second loopback listener; M56.1's record holds the CLI facts.
  - D5, D6 (b), D7 (a): untouched. A client grant never holds the shell, never writes preferences, and never reaches M56.10's `recent` crossing, which answers only `process:` actors.
  - D18: answers name paths that open as pages. The suggestion card lives in the transcript; Accept adds a tab to the database's page and can place a block on the open page. Tokens live in a Settings section. No new screen; views and blocks round-trip as files.
  - **Governed types hold:** agents and clients still may not write Agent pages or Type docs. `suggest_view` writes nothing; only the person's Accept writes `views:`.
  - **D8+, default taken:**
    - **D17 (b):** other local MCP clients use the vault through Cerebro's guarded tools with opt-in loopback personal tokens: hash-only, one grant per token, the read toolset by default, a runs row per client session, off by default. This reverses M6's private-bearer rule for that second listener only; the per-run bearer stays as it is (.5–.5c).
    - **D13 (a)+(i)**, as M61 took it: field arithmetic stays TS-only, and `query_records` refuses formula fields by name (.2).
    - **D9 (b):** an unattended run's suggestion shows only in run detail, pull-only, offering Add as a tab and no placement (.4b).
- **Rules:**
  - One part, one commit: `type(scope): sentence (M62.n)`. Each commit deletes the comments it falsifies.
  - Parts start on M61's closed tip; edits anchor by name or text, never line number.
  - The waves are fixed, and parts in a wave share no file. Wave 4's two parts build in parallel worktrees, each with its own e2e `PORT`; cargo runs one at a time with a shared `CARGO_TARGET_DIR`. Parts cherry-pick in wave order, the wave tip is re-gated, and the branch stays in the main checkout.
  - Artifacts use the `policy-artifact-edit` skill: bump `artifact_version`, set `rule_version` to `<name>/<commit date>`, and regenerate the digest by the README's ignored test after rebasing. Never run prettier over `shared/`; never hand-merge a digest.
  - Hand-written tools never take the `propose_` prefix; M57 owns that namespace and its cards.
  - CV-19: no prompt line names a new tool; each description says when to use it. Descriptions name no other tool and no retired term: "work item" never enters the manifest, and only fixtures and tests name the demo type.
  - Read refusals (.2, .3) are plain error text, with no code and no operational row (M59.2's rule). `suggest_view` reuses `schema_invalid` through M54.10's recorder. A code found necessary goes through policy.v3's README ritual.
  - Schema: only .5, one step in its commit.
  - No builder runs the claude CLI; live and packaged checks are the owner's. CLI pinned at 2.1.250. With the owner's OK, push after waves 5 and 7, so CI Linux runs the crash suite on .5 and .5c.
- **Contracts between parts.** Whichever part lands second does the shared work:
  - **One number grammar (.1 → .2):** TS `numericText` is the rule; Rust `numeric_text` twins it through `filter-cases.json`'s `numbers`.
  - **One query core (.2 → .3, .4):** query.rs keeps `parse_request`, `source_for`, `check`, `field_value`, `numeric_text`, `evaluate`, `sort_rows`, `closest_name`, `answer_text` and `describe_text` pub(crate). .3 inherits `type_filtered` as .2 leaves it. .4 reuses the resolver, a per-rule filter check and `closest_name`, and edits query.rs only to widen visibility or split a whole-group check per rule with unchanged answers.
  - **One suggestion parser (.4 → .4b):** `viewSuggestion.ts` serves the card; .4's interim `view` arm (AiActionCard) is .4b's to replace.
  - **The read toolset (.2, .3 → .5):** after .3 it is get_vault_context, search_notes, list_notes, describe_database, query_records, list_agenda, get_note, knowledge_about, list_inbox. `suggest_view` sits in `propose`, never grantable to a token.
  - **Manifest order:** `tools.v1` bumps in wave order (.2, .4, .3, .5), each from the committed version; README rows land in the same order.
  - **SECURITY.md:** .3 can't edit it (.4b holds it in wave 4), so .5b adds list_agenda to .2's database-reads bullet.
  - **Tokens to listener (.5 → .5b → .5c):** .5's commands gain `State` in .5b and call `token_created` and `token_revoked`. .5b's `Session` gains .5c's `RunClaim`. `CLIENT_ACTOR_PREFIX` lives in client_access.rs, and authors.test reads it there.
- **Scout reconciliations** (no part changed wave):
  - .4 refuses a database whose Type doc is outside read scope exactly as .2 refuses an unknown type: the closest readable name and the types in use, never `read_outside_scope`, so no answer confirms a withheld database exists (M59.2's rule). Its `schema_invalid` row then targets the asked name.
  - .2's caps match the views' own: 4 sort keys (`MAX_SORT_KEYS`), 40 conditions and 3 levels (views.v1's), so any query can be suggested as a view.
  - .2 builds the closest-name rule in Rust only, so .4 adds TS `closestName`, held by `view-suggestion-cases`.
  - `client-tokens` gets a registry row in .5: an unlisted twin is review-blocking (CV-04 as M60.3 amended it).
  - `RunGrant::for_client`'s "narrowest" means ask-first off: a client can't answer a card, and Q13 lands its writes under the run guards. Every later grant field is set explicitly there, so a new field fails to compile until decided.
  - .3 adds `vault/agenda.rs` to AGENTS.md's repo map, beside .2's query.rs and .4's views.rs.
  - .2 is the first per-call reader of the system zone, so .2 (not .3) narrows `system_timezone`'s "Captured ONCE … never re-read" and Cargo.toml's iana-time-zone comment; .3 adds list_agenda to both. Likewise .2 rewrites `deadline_field`'s no-caller doc, and .3 adds its own use.
  - .2's live check asks about Work items: demo Decisions carry `decided`, not a due date.

## Waves

| Wave | Parts | Theme |
| --- | --- | --- |
| 1 | M62.1 | the filter oracle |
| 2 | M62.2 | describe_database and query_records |
| 3 | M62.4 | suggest_view, checked |
| 4 | M62.4b, M62.3 | the suggestion card · list_agenda |
| 5 | M62.5 | personal tokens (the schema step) |
| 6 | M62.5b | the client port |
| 7 | M62.5c | snippets, reach and client commits |

.4 builds before .3 so the card can build beside the agenda: .3 and .4 share mcp.rs and the manifest, while .3 and .4b share nothing.

**Before wave 1:**

- Commit this plan on M61's closed tip.
- Re-read the finished names it leans on:
  - M61: `bandContext`, `deadline_field` (.3b), `resolve_relative` and `resolveRelative` (.3c), the formula dialect (.4), `placementOfValue` and `spanOf` (.8), `FieldKind::Repeat` and `repeatFieldFor` (.10);
  - M60: `schema.fieldValue` (.1), `checkView` (.2b), `vault::schema`, `vault::dates` and the twin registry (.3), `set_fields` (.4), `applyBatch` (.6), undo (.7), `readNoteSource` and `replace_file` (.10);
  - M59: `readable_entries`, `type_filtered`, `arg_limit`, `CorpusCache` and list_notes's row; M58: `writes_booked`, `claim_run`, `settle_run`, `scopeAdmits` and PageAccess; M57.4's `confirmable`; M56: `runs.cause` (.7), renderers and fold (.8), readOnly (.9); M55.5's `dispatch_refusal`; M54: the manifest (.1), the loopback (.6), the grant mirror (.7), the refusal recorder (.10); M70.3's comment door and `forget_posts`.
- Ask each wave's questions before it starts: Q1 before wave 1; Q2–Q6 before 2; Q9 before 3; Q7, Q8, Q10 and Q11 before 4; Q12–Q15 before 5; Q16 and Q17 before 6; Q18–Q20 before 7. The default applies if unanswered.

**Roadmap acceptance, by part:**

| Roadmap bullet | Parts |
| --- | --- |
| The filter goldens pass in both suites, and the oracle matrix asserts exact ids | .1, .2 |
| `query_records` for "Work item where status group is active, sorted by due" returns the TS view's paths; an unknown field is refused with the closest name | .2 |
| `list_agenda` for one week returns due dates and decisions, counts undated records, and says when it truncated | .3 |
| Overdue work items as a board yield a card whose Accept adds a tab; an unknown field never reaches a card | .4, .4b |

The rest of the roadmap rows: .5 (tokens), .5b (401 and 405, Host and Origin, a runs row per session), .5c (snippets).

## Parts

### M62.1 The filter oracle: truth written without the evaluator, over every op × kind × boundary value

- **What:** PRACTICES-8. viewFilters tests pick values by hand, so a misreading stays hidden. Today `Number()` reads `' '` as 0 and `'0x10'` as 16, text in a number field orders against numbers, and a mapping matches contains "object". .2 twins these semantics in Rust (D3), so they are pinned first, by truth the evaluator doesn't write.
- **Files:** `src/test/filterOracle.ts` (new), `src/engine/viewFilters.oracle.test.ts` (new), `src/engine/viewFilters{,.test}.ts`.
- **Approach:**
  - **The oracle** imports only `import type` from `@/engine/types`. It holds hand-stated readings (raw, text, number, day, minute; a token's [from, to]), `OP_RULES` (`satisfies Record<FilterOp, …>`), `oracleIds(values, op, target)` and an all/any composer. Its truth is Appendix A1.
  - **The matrix:** `KIND_CASES satisfies Record<FieldKind, KindCase>` (all 19 kinds) and `FAMILY_TARGETS satisfies Record<FilterFamily, …>`, with boundary values and targets per A1. Per kind × `filterOpsFor` op × fitting target × zone, build one page per value plus the Type doc, run buildSchema and evaluateFilters on 2026-07-28, and assert kept ids equal `oracleIds` exactly, in page order. Date kinds run in UTC and America/Los_Angeles, `process.env.TZ` set and restored. Inadmissible cells don't run; M60.2b's checkView names them.
  - **Guards:** a registry test names every FILTER_OPS, FIELD_KINDS and FILTER_FAMILIES member missing from its table, and every stray key. Preconditions stay outside the oracle: stated days equal parseDateProperty per zone, tokens equal resolveRelative, computed values equal schema.fieldValue. A failure there is a table error.
  - **Fix what it finds** in viewFilters.ts, at least these, if still present:
    - export `numericText(raw)`: a finite JSON number, or text matching `^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$` once ASCII space, tab, LF, FF and CR are trimmed, and finite; compareValues reads numbers only through it;
    - when exactly one side reads as a number, the two don't compare;
    - a mapping or nested list has no text: matchesText skips it.

    Any other disagreement: fix the evaluator when a docblock, field-kinds.v1's collation words or dates.v1 back the oracle; otherwise write the code's behaviour into OP_RULES with a one-line reason.
- **Comments to delete:** matchesText's "applied to any element" becomes "any scalar element"; compareValues' docblock keeps "chosen from the VALUES" and gains the decimal grammar and the one-numeric-side rule; any viewFilters.test comment that relied on `Number()`.
- **Tests:** the registry guard; `the oracle imports no evaluator code` (a source scan); the three preconditions; `<kind> × <op> keeps exactly the oracle's pages`, one per admissible cell; `groups compose: all, any, nested, unfinished and empty`; `virtual fields read entry facts first`. viewFilters.test: `numericText reads decimal text only` (reads '5', '-3.5', '+5', '5.', '.5', '1e3', ' 5 ', `'\t5\n'`; refuses '', ' ', '0x10', '0o7', '0b1', 'Infinity', '1e400', '5 apples', '1,200', NBSP + '5'); `text in a number field never orders against a number`; `a mapping never matches a text condition`.
- **Acceptance:**
  - Roadmap: an oracle written without evaluator internals runs over op × kind × boundary values, the matrix asserts exact ids, and a registry guard fails on any op, kind or family not classified.
  - Every admissible cell runs, formula and repeat included; date cells run in two zones.
  - Blank, hex, octal, binary and non-finite text no longer read as numbers; text never orders against a number; a mapping never matches a text condition.
  - No Rust, artifact, schema, IPC or mock change.
- **Wave** 1 · **Depends** M60.1, .3; M61.3c, .4, .10 · **Size** M · **Crash risk** no · **Packaged check** no
- **Commit:** `fix(views): an independent oracle holds every filter operator on every kind (M62.1)`. The body is the release note: which saved views change rows (blank or hex text, text in a number field or a show rollup, mappings in text fields), and each old assertion it changed.

### M62.2 describe_database and query_records: the views' filter JSON, evaluated in Rust, held to the TS view

- **What:** DATA-8, WORK-2. Agents have no structured read: search_notes needs words and returns prose. M60.3's reader, M61.3c's `resolve_relative`, and M59's `readable_entries` and corpus supply every input. M61 left this part formulas (Q37) and naming `deadline:` (Q25).
- **Files:** `src-tauri/src/vault/{query.rs (new), mod.rs, schema.rs, dates.rs}`, `src-tauri/src/{mcp.rs, policy/tools.rs}`, `src-tauri/fixtures/{filter-cases.json (new), tool-cases.json, tool-grants.json}`, `shared/policy/{tools.v1.json, tools.v1.sha256, README.md}`, `src/engine/{filterCases.test.ts (new), tools.test.ts}`, `src/lib/policy/tools.test.ts`, `src/library/AgentProperties.test.tsx`, `AGENTS.md`, `SECURITY.md`; comments only: `src-tauri/src/runtime/budget.rs`, `src-tauri/Cargo.toml`. Only if needed: `shared/policy/goldens-tool-approval/` (a golden lists the read toolset; regenerated by the ritual), `shared/schema/README.md` (it says formulas wait for M62.2), `src/library/LibraryPage.test.tsx` and `e2e/agents.spec.ts` (they pin the read toolset), `src/engine/{viewFilters,surface}.ts` (a defect a case exposes, named in the commit body).
- **Approach:**
  - **Cases first** (Appendix A2): a Deal and Account corpus covering every kind; cases listing every match in order; `numbers` readings; and `acceptance`, the roadmap query (Work item, status any_of the active ids, sorted by due), its `expect` computed once from the TS view over the scan golden. `filterCases.test.ts` replays them through makeEntry, buildSchema, evaluateFilters and sortEntries, and the acceptance through resolveSurface on a copy of work-item.md. TS is fixed only where a docblock or an artifact says it is wrong.
  - **`query.rs`, pure** (no clock, I/O or lock), mirrors TS step for step:
    - `field_value`: virtual fields, then a declared created or edited time, then relationships, then properties (M60.3's order); `numeric_text` twins .1;
    - cmp follows compareValues: a date or token target compares the item's local day or minute through `read_date_value` and `resolve_relative(text, today, Sunday)`; JSON numbers compare as f64; mappings and lists have no text;
    - operators follow evalRule; sort follows compareBy (empties last in both directions; ranks from the first row whose type declares the field; status order through `status_set_for`; ranked before unranked); text sorts caseless by code point, lowercase first on ties (Q3); stable, so ties keep path order.
  - **`check`** lists every problem at once, by JSON position (`filters.all[1].any[0]`), before anything runs; a parse error stops it first:
    - unknown type, field, op or option: refused with `closest_name` (case, then spelling, then at most 2 edits, 3 at 8+ chars); a label names its id (Q5);
    - rollups, formulas and derived relations (a relation declaring `from`): refused by name (Q4), never by the computed flag, since created and edited times are computed kinds that filter and sort as dates; a misfit op, a wrong value shape, reversed bounds and unfinished conditions: refused;
    - caps: 40 conditions, 3 levels, 4 sort keys, 30 fields; `arg_limit(50, 100)`;
    - read scope first: names, fields and options come only from readable Type docs and records; an Agent's `recent`, `memory` and `preferences` read as absent (M59.2). A typeless query reads every readable record (Q6).
  - **Tools** (mcp.rs, arms beside list_notes's): each reads `readable_entries` through `&CorpusCache`, then `VaultSchema::from_entries(readable)`. The dispatch arm reads the zone from `system_timezone()` and today from `Utc::now()` in that zone, then passes the parsed `Tz` and today into `tool_describe_database` (its date line names both, B1) and `tool_query_records`. Neither handler nor query.rs reads the clock or the zone, so tests pass `chrono_tz::UTC` and no answer text depends on the Mac's zone (clippy bans `set_var`, so no test can pin TZ). Exact answers and refusals: Appendix B1. schema.rs gains only the accessors over `table()` it lacks (family, ops, orderable, range shape, virtual fields).
  - **Manifest and docs** (ritual): two rows after list_notes, in its shape (B1); tool-cases, every whole-catalog tool-grants case, the read toolset, the fold set and AgentProperties follow. The README gains the `filter-cases` registry row and its judgment calls (A2). AGENTS.md names vault/query.rs; SECURITY.md says both tools read only the read scope, take schema only from readable Type docs, and count withheld notes vault-wide.
- **Comments to delete:** call_tool's enumerating-readers note gains both tools; `resolve_relative`'s and `deadline_field`'s no-caller docs or dead-code expectations (deadline_field's becomes "describe_database reads it"); `system_timezone`'s "Captured ONCE … never re-read" narrows to the budget's own use and names the per-call read in describe_database's and query_records' dispatch arms, and Cargo.toml's iana-time-zone comment likewise; `shared/schema/README.md`'s formula line, if any, becomes "Rust never evaluates formulas; query_records refuses them by name (M62.2)".
- **Tests:**
  - query.rs: `replays_the_shared_filter_cases`; `replays_the_shared_number_readings`; `the_operators_are_the_artifacts`; `closest_name_prefers_case_then_spelling_then_edits` (Status→status, due date→due_date, dew→due, stauts→status, xyzzy→none); one test per refusal (unknown names, a label, a misfit op, unfinished, wrong shape, reversed bounds, a rollup, a formula and a derived relation, multi-value and range sorts); over A2's Deal corpus, `created_and_edited_times_filter_sort_and_return` (`made` and `edited`, never in the Not returned footer) and `describe_marks_rollups_formulas_and_derived_relations_only` (marks the three, never `made` or `edited`); `every_problem_is_listed_at_once`; `limits_are_refused_or_stated` (41 conditions, 4 levels, 5 keys, 31 fields; limit 0 refused, 101 cut); `a_typeless_query_refuses_a_field_two_databases_declare_differently`; `an_agents_memory_is_never_returned_or_matched`; `nothing_in_this_module_reads_the_clock`.
  - mcp.rs on demo-vault (read-only, a private CorpusCache; handlers called with `chrono_tz::UTC` and today 2026-07-28): `query_records_matches_the_work_item_view_on_the_demo_vault`; `query_records_refuses_an_unknown_field_naming_the_closest` ('dew' → "due"); `describe_database_names_fields_statuses_views_and_the_deadline` (45 records, `Deadline: due`, the At risk JSON, the UTC date line). On temp vaults: the withheld count is vault-wide (hidden/ and secret/ give 2); a Type doc outside scope is never named; a typeless answer at limit 2 names columns, types read and what was cut; both rows served read-only after list_notes; neither description names a tool, and each fits 2048 characters (B1 measured 724 and 1873).
  - tools.rs and lib tools.test (digest, fold set); filterCases.test (`replays the shared filter cases`, `reads numbers as the shared cases say`, `the acceptance query is the Work item view`); tools.test (the read toolset); AgentProperties.test (eight read tools, in order).
- **Acceptance:**
  - Roadmap: the filter goldens pass in cargo and vitest. `query_records` over Work item, status any_of the active ids, sorted by due, returns the TS view's paths on demo-vault; 'dew' is refused naming "due".
  - Roadmap: FilterGroup JSON with sort, fields and limit ≤ 100 runs in Rust over the scan through M60.3's reader. Read scope applies first, with withheld counts. Answers name truncated types, types read and each column's field def.
  - Every problem is refused at once, in words, never approximated, with no code and no operational row. Only rollups, formulas and derived relations are refused or marked as computed; created and edited times query as dates.
  - Both rows are read_only after list_notes, with fold phrases; no prompt names them (CV-19). No schema step, IPC command, mock change or refusal code.
- **Live check** (owner, dev): asked "which open work items are due first?", the agent describes Work item, then queries it, and its paths match the table view sorted by due; an unknown field gets the closest-name refusal; time one query on the owner's vault.
- **Wave** 2 · **Depends** M62.1; M61.3b, .3c, .4, .10, .11b; M60.1, .2b, .3; M59.2, .4, .5; M58.6; M57.4; M56.8; M54.1, .2, .4, .7 · **Size** L · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(mcp): agents describe a database and query its records with the views' own filters (M62.2)`.

### M62.4 suggest_view: the agent suggests a view, and Rust checks it before any card can exist

- **What:** DATA-10, AI-7. No tool lets an agent propose a view, and Type docs are refused to agents, so a view can only be described in prose. The server checks the suggestion against the schema and answers with the exact view, so a card renders only from a checked answer. Split by the roadmap's two sentences: this part is the checked tool, .4b the card. It sits outside `propose_` and isn't an M57 interaction: nothing waits, and the turn ends normally.
- **Files:** `shared/schema/{views.v1.json (new), views.v1.sha256 (new), README.md}`, `shared/policy/{tools.v1.json, tools.v1.sha256, README.md}`, `src-tauri/src/vault/{views.rs (new), mod.rs, query.rs}`, `src-tauri/src/{mcp.rs, policy/tools.rs}`, `src-tauri/fixtures/{view-suggestion-cases.json (new), tool-cases.json, tool-grants.json}`, `src/lib/policy/tools{,.test}.ts`, `src/engine/{viewVocabulary,viewSuggestion}{,.test}.ts` (new), `src/engine/{viewCheck,types,tools.test}.ts`, `src/lib/{mockIpc,mockIpc.test}.ts`, `src/agent/{mockAgent,mockAgent.test,agentIpc}.ts`, `src/agent/toolRenderers{,.test}.tsx`, `.claude/skills/policy-artifact-edit/SKILL.md`, `AGENTS.md`, `SECURITY.md`. Only if needed: `src/engine/tools.ts` (it maps renderers exhaustively), `.prettierignore` (M60.3 listed shared/schema files one by one), `src/library/AgentProperties.test.tsx`, `e2e/agents.spec.ts` and `shared/policy/goldens-tool-approval/` (they pin the propose toolset or cerebro names; cells regenerate only through their update path).
- **Approach:**
  - **Cases first** (`view-suggestion-cases.json`, the set-fields-cases precedent; A4): a raw-markdown corpus and cases expecting an answer, a refusal or a malformed error. They pin every rule and word.
  - **`views.v1.json`** (D3, CV-04: a shared vocabulary is data; A4): view types with `suggestable`, needs and reads; chart kinds; enums; slots naming field-kinds.v1 facts; key lists; limits. The digest comes from the ignored `write_views_digest` test. shared/schema/README.md gains the row, readers, regen command and judgment calls: strict input; ids minted on add; option ids, never labels; no dashboards or whiteboards (Q9); formula filters admitted though Rust never evaluates them.
  - **`views.rs`:** `table()` (OnceLock, strict shape, slot facts checked against field-kinds.v1), `parse_args` (malformed input is a plain error), `check(schema, db, args) -> Result<Suggestion, Vec<ViewProblem>>` (a fixed walk order; every problem, capped at 20), `refusal_text` and `answer_json`. Known fields, options and closest names come from .2's resolver and per-rule check. It never calls .2's evaluator, so a formula filter passes: the app evaluates views.
  - **The tool** (`tool_suggest_view`, no AppHandle, arm beside propose_organize's): parse, one scan, .2's resolver, check. A refusal returns isError text starting `schema_invalid:` and records one deduped `schema_invalid` row with the run id through M54.10's recorder; success returns compact JSON; `announced_change` gives None. Manifest row after propose_organize (B3): toolset propose, read_only, door none, renderer `view` (new; both loaders refuse it off door none, in the same words).
  - **TS twins and mock:** `viewVocabulary.ts` reads views.v1 in Rust's words. `viewSuggestion.ts` (`checkSuggestion`, `refusalText`, `answerText`, `parseSuggestionResult`) reuses checkView's predicates (exported unchanged) and adds `closestName`. toolRenderers' `view` arm renders AiActionCard until .4b. mockIpc's `agentSuggestView` answers in Rust's words; mockAgent's `suggest view <json>` script calls `onSuggestView`, wired in agentIpc. Docs: README registry rows `views.v1` and `view-suggestion-cases`; the skill names `write_views_digest`; AGENTS.md's repo map and CV-04 (Appendix D); SECURITY.md (reads one database and readable records; writes nothing; moves nothing on screen; names only what the run may read).
- **Comments to delete:** types.ts VIEW_TYPES' "The array is the source and the union is derived from it (M16.3), so adding a kind is one edit." (views.v1 holds the vocabulary now); call_tool's enumerating-readers note gains suggest_view; tools.rs's and the README's renderer list, and M56.8's "every read row folds", become "step-rendered read rows"; mockAgent's script list.
- **Tests:**
  - views.rs: the digest; `write_views_digest` (#[ignore]); the shipped table validates; `refuses_a_malformed_table` (one control each: format, empty rule_version, a duplicate view type, an unknown need, an unknown chart read key, a slot naming a missing fact, a zero limit); `replays_the_view_suggestion_cases`; one test per rule (a board names its band, a number chart needs no axis, a calendar names its date field, no dashboards or whiteboards, unread keys named, walk order capped at 20, labels name the id, a held ghost option and key pass, formula fields filter and chart, relative dates pass, templates and knowledge pages hold no keys, canonical echo).
  - mcp.rs: `suggest_view_answers_the_view_and_writes_nothing` (bytes, mtimes and vault_writes unchanged); `suggest_view_refuses_an_unknown_field_naming_the_closest_one`; `a_refused_suggestion_records_one_schema_invalid_row_with_the_run_id` (a repeat adds none); `suggest_view_names_the_closest_database`; `a_database_outside_read_scope_is_refused_before_a_field_is_named`; `held_keys_come_only_from_readable_records`; `suggest_view_is_served_read_only_and_titled`; `a_record_without_suggest_view_never_lists_or_calls_it`.
  - tools.rs (a `view` row moved to the ui door is refused; the fold test renamed to step reads; the digest); lib tools.test; viewVocabulary.test (digest, shape, refusals, tripwires: VIEW_TYPES, CHART_KINDS, CHART_AGGS, CHART_SORTS, DATE_BUCKETINGS, MAX_GROUP_DEPTH, MAX_SORT_KEYS, spans and zooms); viewSuggestion.test (every sentence, walk order, closest names, a round trip through parseViewList and serializeViewList); mockIpc.test (replays the cases, never throws); mockAgent.test; tools.test (propose toolset: propose_organize, then suggest_view); toolRenderers.test.
- **Acceptance:**
  - Roadmap: a suggestion naming an unknown field never reaches a card: it is refused as `schema_invalid`, naming the closest field, in Rust and the mock alike.
  - Roadmap: Rust validates the view through M60.3's reader and .2's resolver before it answers; chart and number views are admitted.
  - Outside `propose_`; served read-only and titled; writes nothing and emits no UI event. Every problem at once, same words in both languages.
  - views.v1 is data, with digests pinned in both suites and TS unions held by tripwires. Read scope applies first; one `schema_invalid` row per refusal per run.
  - No new refusal code, schema step or IPC command.
- **Live check** (owner): ask the panel for overdue items as a board. The model finds suggest_view and gets the answer; a misspelt field gets the closest-name refusal, then a corrected retry. Record whether it found the tool without a prompt line.
- **Wave** 3 · **Depends** M62.2; M61.3, .3c, .4, .8; M60.2b, .3; M57.4; M56.8; M54.1, .2, .4, .7, .8, .10 · **Size** L (roadmap M, with .4b) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(mcp): agents suggest a view, checked against its database before any card can exist (M62.4)`.

### M62.4b The suggestion card: a live preview, Add as a tab, and placement on the open page as one undoable batch

- **What:** the roadmap's second sentence: the panel previews the checked view live; Accept appends it to `views:` and can insert a database block. M56.8's renderer registry, M60.6–.7 and .10's batch, and M55.6's in-place merge make that cheap, so DATA-10's descope (Accept adds the view only) is no longer needed.
- **Files:** `src/agent/{ViewSuggestionCard (new), toolRenderers}{,.test}.tsx`, `src/app/viewSuggestionActions{,.test}.ts` (new), `src/app/typeActions.ts`, `src/engine/{viewSuggestion,surface,databaseBlock}{,.test}.ts`, `e2e/agent-suggest-view.spec.ts` (new), `SECURITY.md`. Only if needed: `src/engine/undoPlan{,.test}.ts` (M60.7's revert lacks a `replace_file` arm; it restores `before` only while the file is at `afterHash`, else `stale_content`).
- **Approach:**
  - **Engine helpers:**
    - surface.ts: `resolveTypeView(name, view, entries, schema)`, which the type case calls, so page and preview share one resolver;
    - databaseBlock.ts: `canHoldDatabaseBlock(entry)` (a parsed .md outside knowledge/, not Type, Agent or Skill, the reserved names CV-08 allows) and `appendDatabaseFence(content, ref)` (keeps every byte and the BOM, matches line endings, writes through serializeDatabaseRef; null when the page ends inside an open fence);
    - viewSuggestion.ts: `completeSuggestion`, `sameView` (ignores id, name and icon), `suggestedViewName` (' 2', ' 3' on a caseless clash).
  - **Accept** (`acceptViewSuggestion({database, view, placeOn?})`; the view id or null; never throws, CV-03): findTypeDoc and guardEditable (exported unchanged); the id from nextViewId; next views are `typeViews(database, schema)` plus the new one, so a database with no saved views keeps its default table. Op 1 patches `views:` with the Type doc's hash. With placeOn: flushOpenPages, readNoteSource, appendDatabaseFence (null toasts and sends nothing), then op 2, `replace_file` with the page's hash. One `applyBatch(ops, {undo: label})` flushes, announces (M55.6 merges the block in place) and toasts with Undo. A refusal, `stale_content` included, toasts once, rescans and returns null.
  - **The card** (`view-suggestion-card`; words in Appendix C): a header, the reasoning (at most three lines), and the preview: ViewCanvas over resolveTypeView in a 260 px scrolling frame, inert and `pointer-events-none`, with capture guards on pointer, click, key and drag; no create, column, presentation or save callbacks. States: problems (checkView against today's vault disables Add), gone, added (derived by sameView; nothing stored), unavailable. Buttons: Add as a tab; Add and place on "{page}" (only for a doc page canHoldDatabaseBlock accepts, never in readOnly); Open {database} (navigates only on click).
  - **Rows:** the `view` arm renders the card for a done, unfailed row and passes M56.9's readOnly. Running, failed and interrupted rows keep AiActionCard, so a refused suggestion is a failed step, never a card. Every row keeps `action-card`, `data-tool` and `data-renderer`. D9 (b): an unattended run's card shows only in run detail, with Add as a tab only. SECURITY.md: Add is the person's own batch (`human:me`), and placing appends one fence to the open page in the same batch.
- **Comments to delete:** toolRenderers' interim note from .4; surface.ts's M12.3 comment moves onto resolveTypeView, not kept twice.
- **Tests:**
  - ViewSuggestionCard.test: renders; updates when a record's due changes; a click or key in the preview opens and patches nothing; Add calls once and is disabled while busy; Place shows only for a page that can hold a block (not a Type doc, a knowledge/ page, an Agent or Skill record or a .mmd) and never in readOnly; each state's words; Open only on click. toolRenderers.test: done → card; failed, interrupted and running → AiActionCard; readOnly passes through.
  - viewSuggestionActions.test: one applyBatch with the patch (plus `replace_file` when placing) and the label; ids overdue then overdue-2, names "Overdue 2"; the default table kept; flush before the read; a refused batch returns null with one toast; an open fence sends nothing; a missing or YAML-broken Type doc writes nothing; never throws.
  - surface.test (resolveTypeView); databaseBlock.test (LF, CRLF, no trailing newline, trailing blank lines, a BOM, an open fence, 'Books: 2026' quoted; the canHold table); viewSuggestion.test; undoPlan.test (if needed).
  - e2e `agent-suggest-view.spec.ts` (boot.ts, 1440×900, its own PORT):
    - (a) suggest "Overdue" for Work item (due before today; status none_of done and cancelled; a board by status; sorted by due): the preview shows 7 cards, "Blank-state coaching copy" among them; Add writes `id: overdue`, `name: Overdue` under `views:` in one batch; the card reads Added; Open shows the board tab; Undo restores the file byte for byte, and Add returns;
    - (b) a number chart counting the same rows shows 7;
    - (c) 'assigne' as the band: a failed row naming "assignee", no card, no write;
    - (d) with delivery/how-we-schedule.md open, place: the file ends with the fence (`database: Work item`, `view: overdue`), the editor shows `database-block`, and one Undo restores both files byte for byte.
- **Acceptance:**
  - Roadmap: overdue work items as a board yield a card whose Accept adds a tab (a); an unknown field never reaches a card (c).
  - Roadmap: Accept appends to `views:` and can place a block on the open page, in one batch removed by one Undo (d). The preview is live and inert.
  - Chart and number suggestions preview like any view (b). Added, no longer fits, gone and unavailable are words, never an empty card (CV-05).
  - Round-trips as files: the view in `views:`, the block as a cerebro-database fence.
- **Packaged check** (`./scripts/mac-build.sh`, the owner's macOS): the preview scrolls; nothing in it reacts to a click or a key; Add, then ⌘Z, restores the Type doc byte for byte.
- **Wave** 4 · **Depends** M62.4; M61.3b, .3c; M60.2b, .6, .7, .10; M56.8, .9; M55.6; M53.6 · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(agents): a suggested view previews live, and Add makes it a tab or places it on the open page in one undoable batch (M62.4b)`.

### M62.3 list_agenda: dated records in [start, end), found by capability, soonest first, counting what it could not list

- **What:** CALENDAR-3. No agent tool answers "what falls in this window", and Rust has no dated reader. M61 gave this part the point and midnight-end case file (its risk), the "repeats" mark (Q41) and `deadline_field`'s first listing caller.
- **Files:** `src-tauri/src/vault/{agenda.rs (new), mod.rs, schema.rs}`, `src-tauri/src/mcp.rs`, `src-tauri/fixtures/{agenda-cases.json (new), tool-cases.json}`, `src/engine/agendaCases.test.ts` (new), `shared/policy/{tools.v1.json, tools.v1.sha256, README.md}`, `shared/calendar/README.md`, `src/engine/tools.test.ts`, `src/library/AgentProperties.test.tsx`, `AGENTS.md`. Comments only: `src-tauri/src/runtime/budget.rs`, `src-tauri/Cargo.toml`, `src/engine/{schedule,timeGrid,recurrence}.ts` (code only if a case shows a divergence). Only if needed: `src-tauri/fixtures/tool-grants.json` (a case names the catalog), `src-tauri/src/policy/tools.rs` and `src/lib/policy/tools.test.ts` (they list read rows or the fold set by name), `src/library/LibraryPage.test.tsx`, `shared/policy/goldens-tool-approval/*.json` and `e2e/agents.spec.ts` (they pin read-toolset names), `src-tauri/src/vault/dates.rs` (a doc pointer, or an endpoint accessor M60.3 lacks).
- **Approach:**
  - **Cases first** (`agenda-cases.json`, ASCII only; A3): values per zone (UTC, Sydney, Los Angeles), windows as [start, end) (two Rust-only timed windows), repeat pairs. `agendaCases.test.ts` replays values through placementOfValue, spanOf and dateGrammar; windows without `rust_only` by spanOf's days; pairs through repeatFieldFor.
  - **Read rules** (agenda.rs, pure: no clock, zone lookup or I/O): every endpoint goes through dates.rs, never a regex here.
    - A date with no end is [D, D+1); a time with no end is a point; an open or junk end reads "no end"; a backwards range reads as its start, "end before start".
    - A date start runs through its end date; an end at 00:00 on a later day stops the day before; on its own day, that whole day. A timed start with a same-day date end is a point.
    - Instants become local wall time in the zone and keep "converted from {raw}".
    - In the window: a point when ws ≤ p < we; an interval when a < we and b > ws. `repeat_pair`: the type's first daterange field, else its first date field.
  - **What it lists** (`collect`): dated types are readable types declaring a stored date or daterange field (CV-08, never by name); records outside templates/ and the bundle; each declared date field, in order. It counts undated records, unreadable values (5 named), unparsed frontmatter, repeating records (listed only at their stored date, "repeats") and withheld notes, vault-wide. Labels: deadline (`deadline_field`), ongoing, repeats, no end, end before start, converted. Order: start, end, path, field.
  - **The tool** (`tool_list_agenda`, arm beside list_notes): the dispatch arm reads `system_timezone()` on each call and passes the parsed `Tz` in, as .2's arms do, so tests pass `chrono_tz::UTC`; the window is explicit, so it takes no today. `parse_window` (both required; end after start; at most 370 days), `arg_limit(200, 200)`, `readable_entries`, `type_filtered` for its refusal and canonical name, `VaultSchema::from_entries` over readable entries, `collect`, the exact answer (B2). It never infers free time: no free or busy output, and the empty answer says gaps aren't free time. Read-only, so it runs in parallel (WRITE_SERIAL skips it).
  - **Manifest and docs** (ritual): one row after query_records (B2); fixtures and pins as .2. The README gains the `agenda-cases` registry row and its six judgment calls (A3); shared/calendar/README.md points at the case file; AGENTS.md's repo map names vault/agenda.rs.
- **Comments to delete:** call_tool's enumerating-readers note gains list_agenda; `deadline_field`'s doc gains "list_agenda labels deadlines with it"; any "TS-only" note on placementOfValue, spanOf's midnight rule or repeatFieldFor's pairing becomes a pointer to `agenda-cases.json`, as does shared/calendar/README.md's "Point events and midnight ends stay out (M61.8, M62.3)"; README lines calling time-grid placement TS-only narrow to grid geometry; `system_timezone`'s doc and Cargo.toml's iana-time-zone comment, as .2 left them, gain list_agenda's per-call read.
- **Tests:**
  - agenda.rs: `replays_the_shared_agenda_cases`; `entries_sort_soonest_first_then_by_end_path_and_field`; `only_fields_a_readable_type_doc_declares_as_dates_are_read` (a text `due`, an undeclared `when:`, a created_time and a formula ignored); `templates_and_the_knowledge_bundle_are_never_listed`; `undated_unreadable_and_unparsed_are_counted_never_dropped`; `a_repeating_record_is_listed_at_its_stored_date_and_counted`; `a_deadline_field_is_labelled_and_an_earlier_start_is_ongoing`; `the_window_parser_refuses_in_words` (370 days accepted, 371 refused; an instant window converts); `the_answer_text_is_exact`; `nothing_in_this_module_reads_the_clock_or_the_zone`.
  - mcp.rs on demo-vault, `tool_list_agenda` called with `chrono_tz::UTC`, never the Mac's zone:
    - `list_agenda_over_the_demo_window_lists_39_entries` ([2026-07-20, 2026-08-03): 4 kickoffs, 12 due, 2 decided, phx-421's fetched_at, 20 windows; lnc-11 and ops-10 out, lnc-2 in);
    - `list_agenda_for_the_demo_week_returns_due_dates_and_decisions` ([2026-07-27, 2026-08-03): 20 entries; 5 due labelled deadline; dec-postpone-multi-tenant-billing; phx-421 "converted from 2026-07-28T09:20:00Z" with the zone footer; "2 records have no date in any of those fields" (lnc-10, syn-10); limit 5 gives "5 of 20", the syn-1, ops-3, lnc-2, lnc-8 and ops-9 windows, and "15 more not listed").
  - mcp.rs, rows and scope: `list_agenda_is_served_read_only` (after query_records; description ≤ 2048 chars, holding "not free time", naming no other row and no retired term); the withheld count is vault-wide and an unreadable Type doc gives "No Type doc this run can read declares Task"; an unknown type names only readable types; a dateless type answers in words; limit 200 cut, 0 refused; it writes and announces nothing. M54's catalog, annotation, schema-validity, spelling and grant tests pass unchanged.
  - vitest: agendaCases.test; tools.test and AgentProperties.test (list_agenda after query_records: nine read tools); lib tools.test if it names read rows. Green and unchanged: twins.test (with the new row), toolGrant.test, promptGrant.test, AiActionCard.test (calendar-range resolves), RunList.test.
- **Acceptance:**
  - Roadmap: one week lists due dates and decisions, counts undated records, and says when it truncated.
  - Found by capability only; soonest first; at most 200 lines, with the total, "N more" and a cut limit said. Undated, unreadable, unparsed and withheld are counted, never dropped (CV-05), and no withheld note's type is revealed.
  - Floating values never pass through UTC; instants convert to this Mac's zone and say so. A repeating record is listed once, labelled, and counted.
  - It never infers free time. The rules are one case file replayed by cargo and vitest, listed in the registry.
  - Read-only. No schema step, refusal code, IPC command, mock change or dependency.
- **Live check** (owner, optional): "What was due the week of 27 July 2026?" calls list_agenda and names the due items and the 27 July decision; "Am I free on 30 July 2026?" gets no free-time claim.
- **Wave** 4 · **Depends** M62.2; M61.3b, .8, .10; M60.3; M59.2, .4, .5; M57.4; M56.8; M54.1, .2, .4, .7, .8 · **Size** L (roadmap M) · **Crash risk** no · **Packaged check** no
- **Commit:** `feat(mcp): list_agenda lists dated records in a window, soonest first, and counts what it could not list (M62.3)`.

### M62.5 Personal tokens: `cbr_`, SHA-256 only, shown once, at most 20, each holding one grant

- **What:** MCP-5, D17 (b). Nothing lets another MCP client reach the vault: the run port answers only per-run bearers (M6, M53.11). Re-measured at about 2.5 L, the roadmap row splits by its own bullets: .5 tokens and their grant, .5b the listener and sessions, .5c snippets and reach. Macro's user_api_key gives the shape (prefix, CSPRNG, SHA-256, shown once, cap 20, redacted Debug); its cap counts then inserts with no transaction, so Cerebro's is one atomic insert. Which toolsets a token may hold is a tool fact, so it lives in tools.v1.json (CV-04).
- **Files:** `shared/policy/{tools.v1.json, tools.v1.sha256, README.md}`, `src-tauri/src/policy/tools.rs`, `src/lib/policy/tools{,.test}.ts`, `src-tauri/src/runtime/{schema.rs, mod.rs, cause.rs, client_tokens.rs (new)}`, `src-tauri/src/{client_access.rs (new), lib.rs, diagnostics.rs}`, `src-tauri/fixtures/client-tokens.json` (new), `src/engine/clientAccess{,.test}.ts` (new), `src/lib/{ipc,mockIpc,mockIpc.test}.ts`, `src/stores/clientAccessStore{,.test}.ts` (new), `src/app/ClientAccessSettings{,.test}.tsx` (new), `src/pages/SettingsPage{,.test}.tsx`, `e2e/client-access.spec.ts` (new). Only if needed: `src/engine/jobs.test.ts` (its tripwire pins SCHEMA_V20's kinds by name).
- **Approach:**
  - **Manifest** (ritual): a top-level `clients` block after `toolsets` (B4). Both loaders refuse, naming row and field, in the same words: a default that isn't a declared toolset of read-only rows on non-writing doors; a grantable id undeclared, repeated, equal to the default, or the generated block's toolset; a grantable toolset holding a row on axis none (no folder scope bounds it); an empty why. Accessors: Rust `clients()`, `toolset_writes(id)`, `client_tool_names(toolsets)` (must hold the default; others grantable; row names in served order); TS `clientToolsets()`, `toolsetWrites(id)`. The README notes the block, its two load rules, "D17 (b), default taken", and the `client-tokens` registry row.
  - **Schema step** (the next free `user_version`; one `SCHEMA_VN`):
    - `client_tokens`: token_id 32 lowercase hex PK; vault_id → vault_registry; name 1–100; slug 1–32 of `[a-z0-9-]`; secret_sha256 64 hex, UNIQUE; toolsets and write_scope JSON arrays; read_scope NULL (whole vault) or an array; created_at, last_used_at (nullable); UNIQUE (vault_id, slug); index on (vault_id, created_at);
    - widen `runs.cause`: add `cause_next` with M56.7's CHECK copied verbatim plus `client` last, copy, drop `cause`, rename (skipped, and said in the commit body, if M56.7 already admits client);
    - `validate_vN` checks both, and the stored SQL names every kind in `cause::ALL`; vN's four points join the kill-point table. cause.rs gains `CauseKind::Client` ("another app connected with a personal token"), which the wire can't name; only .5b's opener builds it.
  - **`client_tokens.rs`** (operational, CV-06): `cbr_` plus 64 hex from `OsRng`, stored as its SHA-256 alone, returned once, never stored, logged or kept. `validate` (Appendix A5): name, `slug_of`, toolsets through `client_tool_names`, write folders required for a writing grant and never the root or knowledge/, read scope null or 1–20 folders. `create` runs in one BEGIN IMMEDIATE: a slug this vault holds is refused; `INSERT … SELECT … WHERE (SELECT count(*) FROM client_tokens) < 20` is the cap, across every vault. `CreatedClientToken`'s Debug prints `cbr_…<last 4>`. `list` and `revoke`. `client-tokens.json` holds names and grants, replayed by cargo and the mock.
  - **Commands and UI:** `client_tokens`, `create_client_token` and `revoke_client_token` (async; plain string errors, CV-03) in client_access.rs and generate_handler!; ipc.ts adapters behind inTauri() (CV-18). The mock mirrors validate, cap and revoke in Rust's words, stores only the hash, and seeds through `window.__cerebroSeedClientTokens(n)`. diagnostics.rs redacts `cbr_` (KEY_PREFIXES 12 → 13). clientAccessStore never holds the secret. ClientAccessSettings (`client-access`) is the "Other apps" section before Knowledge: rows, Make a token (disabled at 20), the dialog, and a created view that shows the secret once with Copy and Done (Appendix C).
- **Comments to delete:** USER_VERSION's doc gains vN; SCHEMA_V20's "ten kinds" notes the list widens at vN (it stays history); cause.rs's "ten kinds" counts; KEY_PREFIXES' doc ("Anthropic and OpenAI, GitHub, Slack, GitLab and AWS") gains Cerebro's tokens; any list of the manifest's top-level keys gains `clients`.
- **Tests:**
  - tools.rs: `the_client_default_is_one_toolset_that_only_reads`, `grantable_toolsets_hold_only_rows_a_folder_scope_bounds`, `the_proposal_toolset_is_never_a_clients`, `client_tool_names_needs_the_default_and_only_grantable_sets`, one negative control per refusal, the digest. lib tools.test: the same refusals in the same words, both accessors, the digest.
  - client_tokens.rs: `a_minted_token_is_stored_as_its_hash_alone` (matches `^cbr_[0-9a-f]{64}$`; neither runtime.db nor its -wal holds the secret), `a_created_token_never_prints_its_secret`, `names_and_grants_replay_the_shared_cases`, `the_twenty_first_token_is_refused_even_when_two_creates_race` (two connections, two threads), `a_name_this_vault_holds_is_refused_and_another_vaults_is_not`, `revoke_deletes_the_row`, `tokens_list_with_their_vault_and_whether_it_is_this_one`.
  - runtime/mod.rs: a previous-version database gains `client_tokens` and keeps every run, cause, ambient_dispatch and run_commits row; the CHECKs refuse bad rows; `validate_vN_catches_a_cause_check_without_client`; vN's kill points (CI Linux). cause.rs: client has words; the wire can't name it; the CHECK list equals WORDS and ALL, now eleven. diagnostics.rs: `a_personal_token_is_redacted` (bare, and after Bearer).
  - vitest: clientAccess.test (grantWords per grant shape); mockIpc.test (the shared cases; no secret listed; the 21st refused; revoke); clientAccessStore.test (failures toast and return null or false; the secret never enters the store); ClientAccessSettings.test (loading, unavailable, empty, rows; shown once, cleared by Done, never in localStorage; the cap; folders required when writing; reads default to the whole vault; another vault's row; revoke asks first); SettingsPage.test. ipcContract.test passes unchanged.
  - e2e `client-access.spec.ts`: a token is shown once (no secret in the body after Done); a writing token names its folders; twenty is the cap; revoke removes the token.
- **Acceptance:**
  - Roadmap: a token is `cbr_` plus 64 hex from the OS random source, stored as SHA-256 alone, shown once, revocable, at most 20, each with its own grant and the read toolset by default.
  - The 21st is refused even under a race; revoke deletes the row. Grantable toolsets come from the manifest, and a toolset no folder scope bounds fails the load in both languages.
  - A writing token names 1–20 folders, never the root or knowledge/. `runs.cause` admits `client` and nothing else new, and the step keeps every run and cause.
  - The secret never reaches runtime.db, the log, a Debug print, a store or localStorage. No new refusal code.
- **Packaged check:** make a token in Settings, then `sqlite3 "$HOME/Library/Application Support/com.cerebro.app/runtime.db" "PRAGMA user_version; SELECT name, slug, length(secret_sha256), toolsets FROM client_tokens; SELECT count(*) FROM runs WHERE cause IS NOT NULL;"` shows vN, a 64-character hash, no secret anywhere, and every earlier cause kept.
- **Wave** 5 · **Depends** M62.2, .3, .4; M70.3; M60.4, .6; M59.5; M58.1; M56.7; M54.1, .2, .3; M53.24 · **Size** L · **Crash risk** yes (the step drops and renames a column inside the migration; vN's kill points) · **Packaged check** yes
- **Commit:** `feat(clients): personal tokens for other apps, hash-only, shown once and capped at 20 (M62.5)`.

### M62.5b The client port: a second loopback listener, off by default, with one runs row per client session

- **What:** D17 (b). M54.6 built Host and Origin checks and left GET → 405 for this port. The CLI reads a 401 as an OAuth prompt, so 401 lives only here. Without a runs row, a client's writes, refusals and tool counts land on no run (MCP-5: `UPDATE runs … WHERE run_id` matches nothing). Like Macro's mcp_service, Cerebro stays stateless and POST-only: no `Mcp-Session-Id`, so a restart never strands a connected app, and sessions are keyed server-side.
- **Files:** `src-tauri/src/{client_access.rs, mcp.rs, app_config.rs, lib.rs}`, `src-tauri/src/runtime/{dispatch.rs, client_tokens.rs}`, `src-tauri/Cargo.toml`, `src/lib/{ipc,mockIpc,mockIpc.test}.ts`, `src/stores/clientAccessStore{,.test}.ts`, `src/app/ClientAccessSettings{,.test}.tsx`, `e2e/client-access.spec.ts`, `AGENTS.md`, `SECURITY.md`.
- **Approach:**
  - **Seams, the run port byte-identical:** `AppConfig.client_access {enabled: false, port: 37421}` by default. mcp.rs makes its transport helpers pub(crate) (`loopback_refusal`, `header_value`, `read_body`, `rpc_error`, `tokens_match`, `log_first_refusal`, `is_notification`, `MAX_BODY_BYTES`); extracts `serve_pool(server, name, workers, answer)` and `answer_value(app, grant, request)`; adds `RunGrant::for_client(…)`, the one client-grant constructor (scope = write folders or []; read scope; tools; chain [actor]; no approvals; ask-first off); and extracts `forget_run(run_id)` from `push_run_token`'s eviction (attempts, tool calls, M54.10's dedupe, M70.3's posts).
  - **Sessions in runs** (dispatch.rs): `begin_client_session` inserts mode attended, lane agent, outcome running, usage pending, counters_booked 1, writes_booked 1 (M58.1) and the `client` cause (subject the token's name, detail clientInfo's name and version). `finish_client_session` sets ended_at, outcome and usage `unknown` (not recorded, never zero, CV-05) only on a running `client:` row. client_tokens.rs gains `live` (its Debug leaves the hash out) and `stamp_used`.
  - **The listener** (client_access.rs: `ClientAccessState`, one Mutex, no dispatch while held; 4 workers; a 60 s sweeper; 30-minute idle): it binds `127.0.0.1:<port>` only when enabled, and a failed token read means no listener (fail closed). Each request, in order:
    - the address check (400, 403); /mcp or 404; POST or 405 with `Allow: POST`;
    - a `cbr_` bearer whose hash `tokens_match` compares with every live token, no early exit; else 401 with `WWW-Authenticate: Bearer realm="cerebro"` (plus `error="invalid_token"` when one was sent);
    - only then the body (413, 400); a notification gets 202;
    - the token's vault must be the open one; otherwise tool calls say which vault to open, and no session opens;
    - `touch` opens or reuses the session's run: initialize always opens a new one, and so does a call 30 or more idle minutes on. Opening writes the row and stamps last-used in one BEGIN IMMEDIATE, or answers -32603 (fail closed);
    - `RunGrant::for_client`, `answer_value`, 200.

    Refusals log once per kind per launch, never with the token, and never reach runtime.db (M54.6's rule).
  - **Ends and hooks:** idle and superseded sessions end succeeded at their last call; revoke, a vault switch, access off, a port change and quit end them cancelled. Each end finishes the row, stamps last-used and calls `forget_run`; a crash leaves the row to `recover_orphaned_attended`. Hooks: `vault_opened` (after `runtime::sessions::track`), `token_created` and `token_revoked` (from .5's commands), `shut_down` (RunEvent::Exit, before `close_current`). Commands `client_access_status` and `set_client_access` (ports 1024–65535); Settings gains the toggle, port and status line (Appendix C).
  - **Docs and review:** SECURITY.md's Other apps bullet (Appendix D), plus list_agenda on .2's database-reads bullet; AGENTS.md's repo map (client_access.rs beside mcp.rs) and CV-42; Cargo.toml's tiny_http comment names both endpoints. Before merge, run the `security-review` skill and answer in the commit body: DNS rebinding and Origin; token entropy, storage and comparison; log redaction; grant escalation (toolsets, scopes, governed types, the knowledge guard, preferences, proposals); session attribution; body caps and pool exhaustion; WRITE_SERIAL contention with runs; other local users and processes; a token copied out of a client's config; a Cerebro run reaching the client port through inherited or approved connectors. Fix every finding, or record the owner's written sign-off.
- **Comments to delete:** .5's "nothing listens for a token yet"; serve_loopback's "A worker stops when `unblock` hands it nothing, which only the tests do" (moves to serve_pool, which the client stop also uses); push_run_token's eviction paragraph (now forget_run's doc); Cargo.toml's "a handful of JSON-RPC methods"; app_config.rs's "Persisted app configuration (last opened vault)"; lib.rs's "quitting ends every run" and "a run never outlives its vault" gain client sessions; AGENTS.md's "mcp.rs (loopback MCP server)" becomes the runs' server.
- **Tests:**
  - client_access.rs, transport (real sockets on port 0, an injected dispatch, a temp runtime db): `nothing_listens_until_turned_on`, `only_its_own_address_reaches_the_client_port` (the run port's number among the refused), `anything_but_post_gets_405_with_allow_post`, `a_path_but_mcp_gets_404`, `no_token_gets_401_with_a_bearer_challenge`, `an_unknown_or_revoked_token_gets_401_invalid_token`, `a_run_bearer_gets_401_here`, `an_unauthenticated_body_is_never_read` (16 MiB + 1 with no token gets 401, not 413), `an_oversized_body_with_a_token_gets_413`, `a_notification_gets_202`, `token_comparison_reads_every_slot`.
  - sessions (an explicit clock): `every_answered_call_carries_its_session_run`, `an_initialize_opens_one_runs_row`, `calls_inside_the_idle_window_share_a_session`, `a_call_after_thirty_idle_minutes_opens_a_new_session_and_ends_the_old_at_its_last_call`, `a_second_initialize_ends_the_first_session_succeeded`, `revoking_a_token_ends_its_session_cancelled_and_its_next_call_gets_401`, `a_vault_switch_ends_the_other_vaults_sessions`, `quitting_ends_every_session_cancelled`, `a_token_whose_vault_is_closed_is_told_which_vault_to_open_and_opens_no_session`, `a_session_whose_row_cannot_be_written_answers_nothing`, `a_closed_session_forgets_its_run_maps`, `last_used_is_stamped_at_open_and_close`.
  - grants: `a_read_token_lists_exactly_the_read_toolset`, `a_read_token_is_refused_every_writer` (`tool_outside_grant`), `a_write_token_writes_only_inside_its_folders` (`write_outside_scope`), `a_token_never_writes_agent_pages_type_docs_or_knowledge`, `a_client_never_writes_preferences`, `the_port_refuses_outside_1024_to_65535`.
  - mcp.rs: `a_cbr_token_on_the_run_port_is_an_unknown_bearer` (200 and -32001); `the_eviction_forgets_through_forget_run_alone`; M54.6's pool and address tests unchanged. dispatch.rs: a session opens and finishes; finishing twice changes nothing; orphan recovery closes one (abandoned_usage_unknown). app_config.rs: off on 37421 when absent; a round trip.
  - vitest: mockIpc.test (status; port words); clientAccessStore.test (a failed setAccess toasts and returns false); ClientAccessSettings.test (toggle, a refused port in words, each status line, an unavailable read); conventions.test resolves CV-42's pointers. e2e: turning access on shows "Listening at http://127.0.0.1:37421/mcp."; port 80 is refused in words; 37500 moves the URL.
- **Acceptance:**
  - Roadmap: a missing, malformed or unknown token gets 401 with a Bearer challenge; anything but POST gets 405 with `Allow: POST`; a foreign Host gets 403 and a missing one 400; a foreign Origin gets 403.
  - Roadmap: each client session books exactly one runs row, so its writes, refusals and tool counts carry its run id.
  - Off by default; 127.0.0.1 only, on 37421 unless configured. An unauthenticated request is answered before its body is read.
  - Every call goes through call_tool's guards under `RunGrant::for_client`: a read token lists exactly the read toolset; a write token writes only inside its folders; Agent pages, Type docs, Knowledge and preferences stay refused. A token works only for the open vault. A session whose row can't be written answers nothing. The run port is unchanged.
  - SECURITY.md and AGENTS.md record D17 and the reversal of M6 for this listener only; the security review is in the commit body.
- **Live checks** (owner, a packaged build with access on and a read token):
  - L1: `claude mcp add --transport http cerebro-vault http://127.0.0.1:37421/mcp --header "Authorization: Bearer <token>"`, then `claude -p 'What is in this vault?'` calls get_vault_context, and Fleet shows one running `client:<slug>` row reading "another app connected with a personal token (…)";
  - L2: `curl -i` gets 405 with `Allow: POST` on GET, 401 with a Bearer challenge on a token-less POST, 403 with a foreign Host;
  - L3: revoke while configured, and record what the CLI says on 401; L4: two `claude -p` runs a minute apart make two sessions;
  - L5: a write token's create_note lands inside its folder, and one outside is listed under Refused in run detail; L6: if the owner uses Cursor, its JSON config connects; record whether it sends an Origin.
- **Wave** 6 · **Depends** M62.5; M58.1; M57.4; M56.7, .9; M55.5; M54.4, .6, .10; M53.10, .11 · **Size** L · **Crash risk** no · **Packaged check** yes
- **Commit:** `feat(mcp): other apps reach the open vault through a second loopback listener, one runs row per session (M62.5b)`.

### M62.5c Snippets, and other apps named where they act: Fleet, a page's Info tab, and commits of their own

- **What:** roadmap M62.5's fourth bullet: copyable snippets (Macro's mcpConstants: a Claude Code command and an mcpServers JSON). A token is shown once, so a snippet carrying it appears only in the created view; the standing block shows a placeholder. Two honesty gaps follow .5b: Fleet prints `client:<slug>` raw, and M58.6's "who can change this page" never mentions a write token. M58.3 commits each run's own writes, so a client session should too, or the automatic checkpoint sweeps its writes into the person's commit.
- **Files:** `src/engine/{clientAccess,authors}{,.test}.ts`, `src/app/ClientAccessSettings{,.test}.tsx`, `src/detail/PageAccess{,.test}.tsx`, `src/stores/clientAccessStore.ts`, `src-tauri/src/client_access.rs`, `e2e/client-access.spec.ts`, `SECURITY.md`.
- **Approach:**
  - **Snippets** (`clientSnippets({url, secret})`): Claude Code, `claude mcp add --transport http cerebro-vault <url> --header "Authorization: Bearer <secret>"`, and an mcpServers JSON keyed `cerebro-vault` (type http, the url, headers.Authorization). Never `cerebro`, Cerebro's own server (`CEREBRO_SERVER`, `mcp__cerebro__`): a panel turn in legacy connector mode omits `--strict-mcp-config` and loads the user's MCP config too, where a second `cerebro` could shadow the per-run bearer. A url not matching `^http://127\.0\.0\.1:\d{1,5}/mcp$` or a secret not matching `^cbr_[0-9a-f]{64}$` renders `<address>` and `<your token>`; nothing else is interpolated. No Codex snippet until a live check proves its syntax (Q20).
  - **Settings:** the created view shows both snippets with the real secret (`client-snippet`, `data-client`), each with Copy, under the shown-once line, plus the cloud and Claude Desktop hint. A standing "Connect an app" block uses status.url and `<your token>`, or says to turn access on first.
  - **Reach and labels:** `clientReach(tokens, path, governed)`: read when read_scope is null or admits the path (M58.6's `scopeAdmits`); write when the token holds a writing toolset, its scope admits the path, the page isn't governed and the path isn't under knowledge/. `actorLabel` reads `client:<slug>` as "<slug> (other app)", matched before parseActor, raw kept for `title=`; Fleet, the actor filter and the roster follow. PageAccess loads tokens and renders client rows (`page-access-row`, `data-actor`, `data-write`, `data-read`) beside the agents, plus a `page-access-clients` line; a failed read says so, never "none" (CV-05).
  - **Commits** (client_access.rs): a session whose token holds a writing toolset takes `claim_run(vault, run_id, actor)` at open and keeps the RunClaim. When it ends (idle, superseded, revoke, a vault switch, access off, a port change; never at quit), a one-shot `cerebro-client-settle` thread runs M58.3's `settle_run` for its run id and actor, then drops the claim, so its paths stay owned until the commit lands. At quit the claim drops unsettled (M58.3's rule). A read-only token takes no claim and spawns nothing. The message is settle_run's own fallback. SECURITY.md: a session that wrote commits its own writes when it ends, like a run.
- **Comments to delete:** actorLabel's "anything unrecognised is its raw id" gains the client reading; PageAccess's M58.6 "no IPC, so nothing can fail"; .5b's session-end doc saying a session commits nothing.
- **Tests:**
  - clientAccess.test: each snippet carries the secret exactly once and names the server `cerebro-vault`, never `cerebro`; a missing or malformed secret or url gives the placeholders; nothing else is interpolated; reach inside and outside a write scope, governed pages and knowledge/ refused, read scope respected, another vault's token ignored.
  - ClientAccessSettings.test (both snippets with the secret and Copy; the standing `<your token>`; the hints; the off line); authors.test (`client:codex` reads "codex (other app)", raw kept; `the client prefix is Rust's` reads CLIENT_ACTOR_PREFIX from client_access.rs); PageAccess.test (a write token adds a row and the line; a read-only token adds no writer; a failed read says so, never "No other app can change this page.").
  - client_access.rs (a temp repo, an armed sink): `a_writing_session_commits_its_writes_when_it_ends` (Cerebro-Run and Cerebro-Actor trailers), `a_read_only_session_takes_no_claim_and_commits_nothing`, `quitting_commits_nothing`, `a_sessions_paths_stay_owned_until_its_commit_lands`. No test name holds a skip-list substring.
  - e2e: the created view's Claude Code snippet carries the secret; after Done the section shows `<your token>` and the body holds no secret.
- **Acceptance:**
  - Roadmap: Settings gives copyable snippets for Claude Code and for mcpServers JSON clients, with the secret only in the shown-once view and a placeholder everywhere else.
  - Fleet, the actor filter and the roster read "<slug> (other app)". A page's Info tab names each write token that can change it, with the reason; a failed read is said in words.
  - A write-capable session commits only its own writes when it ends, never at quit; a read-only one spawns nothing. The secret never leaves the created view.
- **Live check** (owner): paste the Claude Code snippet; `claude mcp list` shows cerebro-vault connected. With a write token, a created note lands; turn access off, and `git log -1` names the client's run. With the snippet installed from the vault's folder (so its local scope matches the runs' cwd) and connectors on in a vault without connectors.json, a panel turn's tools/list comes only from the per-run bearer: no `cerebro-vault` tools, and no `client:` session in Fleet. If the owner uses Codex, try its config, and add its snippet only once it works.
- **Wave** 7 · **Depends** M62.5b; M58.3, .6 · **Size** M · **Crash risk** yes (a session's end spawns bounded git through M58.3's `run_bounded`) · **Packaged check** yes
- **Commit:** `feat(clients): Settings gives copyable snippets, and pages and Fleet name other apps (M62.5c)`.

## Done or dropped

- **Done:** none. **Dropped:** none; all five roadmap parts build.
- **Split,** each by its own roadmap sentence: .4 → .4b (preview and Accept); .5 → .5b (401 and 405, Host and Origin, a runs row) and .5c (snippets).
- **Re-sized:** .3 M → L (the twin case file and its three-zone replays).
- **Beyond the roadmap, on purpose:**
  - .1: three readings narrowed: decimal-only numbers, no number-vs-text order, no text in mappings (Q1);
  - .2: `describe_database` names the deadline and the saved views; the acceptance also replays through resolveSurface;
  - .3: deadline, ongoing and repeats labels; Rust-only timed windows;
  - .4b: placing a database block in the same batch (DATA-10's descope reversed);
  - .5: a new `client` cause kind (Q14); tokens of another vault listed so they can be revoked;
  - .5c: a client session commits its own writes (Q18); the Info tab names write tokens (Q19).
- **Not built unless asked or measured:**
  - a `status_group` virtual field (Q2); Rust evaluation of formulas, rollups and derived relations (Q4);
  - recurrence expansion in the agenda (CALENDAR-7b); formula and computed dates on the agenda;
  - dashboard and whiteboard suggestions (Q9); hidden tabs (Q10); placement at the caret (Q11);
  - a Codex snippet (Q20); a Claude Desktop bridge; protocol session ids; OAuth on the client port;
  - free and busy answers: never (Macro's team_availability rule).

## Owner questions

Each default applies if unanswered. Ask a wave's questions before it starts (Before wave 1).

| # | Part | Question | Default taken |
| --- | --- | --- | --- |
| Q1 | .1 | Read text as a number only when it spells a decimal number (' ' stops equalling 0, '0x10' stops equalling 16), and never let text in a number field or a show rollup pass gt or lt? | Yes to both: narrowed in TS now, twinned by .2 from shared cases. |
| Q2 | .2 | "Status group is active": a new `status_group` virtual field, or status any_of the ids describe_database groups as active? | Ids now, with no new virtual field in M62. A status_group field is a later part with its own cases. |
| Q3 | .2 | Rust text order: caseless with lowercase first on ties, or plain code point as M60's Q5 recorded? | Caseless, amending M60 Q5. It matches the app for ASCII letters, digits and spaces, and answers say where it can differ. |
| Q4 | .2 | Refuse rollups, formulas and derived relations by name, or twin their evaluation in Rust? | Refuse now (D3 narrow, D13). This settles M61 Q37. |
| Q5 | .2 | A filter naming an option by its label: refuse naming the id, or map it silently? | Refuse naming the id: views store ids, and a silent map would hide the divergence. |
| Q6 | .2 | Should a query with no type run over every record the run may read, like the Everything view? | Yes. A field two databases declare differently is refused, naming both kinds. |
| Q7 | .3 | A bad window (over 370 days, end not after start, not a date): plain error text with no code and no operational row, as search_notes and list_notes do? | Yes. |
| Q8 | .3 | A declared deadline that is a date range: listed across its whole span, or only where its end falls, as My work bands it? | Across its span, labelled deadline. The line shows the end, and no new twin rule is needed. |
| Q9 | .4 | May the agent suggest a dashboard or a whiteboard? | No: a dashboard's widgets point at other views and own their ids, and a whiteboard makes a file on first open. views.v1's `suggestable` can turn either on later, with cases. |
| Q10 | .4b | Roadmap risk: every accepted suggestion adds a tab. Hide added views from the tab strip? | No hiding. Each Add makes a visible tab the card names, and the tab menu removes it. Hidden views need a stored key, a tab overflow and M60.2's ripple: a part of its own. |
| Q11 | .4b | Place the database block at the caret, or at the end of the page? | The end: one byte-exact `replace_file` in the same batch, undone by one Undo and merged in place by M55.6. The caret needs a new editor channel (DATA-10). |
| Q12 | .5 | Which toolsets may a token hold beyond the read tools? | write and comment. Never knowledge, propose, agents, ui or the proposal tools. |
| Q13 | .5 | May a token write the whole vault, and should its writes ask first? | No and no. A writing token names at least one folder, never the root or knowledge/, and its writes land under every run guard without Review (M57.4c's queue admits only `process:` actors). |
| Q14 | .5 | Record a client session's cause as a new `client` kind (widening runs.cause), or reuse `attended` ("you asked", no column change)? | The new kind; Fleet reads "another app connected with a personal token". |
| Q15 | .5 | Should a token's grant name toolsets (it gains read tools a later Cerebro adds) or freeze tool names at creation? | Toolsets, in the picker's own words. |
| Q16 | .5b | Should a token work only while its vault is the one open in Cerebro? | Yes. initialize and the tool list still answer, and every tool call says which vault to open. |
| Q17 | .5b | Sessions: no protocol session id, so a restart never strands an app; a session starts at each initialize or after 30 idle minutes; two apps sharing a token share one session. OK? | Yes, and Settings says one token per app. |
| Q18 | .5c | Should a write-capable client session commit its own writes when it ends, as runs do since M58.3? | Yes, except at quit. |
| Q19 | .5c | Should a page's Info tab list the tokens that can write it? | Yes, beside the agents; a failed token read is said in words. |
| Q20 | .5c | Ship a Codex snippet? | Not until the owner's live check proves its syntax. Ship Claude Code and the mcpServers JSON (Cursor and similar). |

## Risks

- **Size:** 6 L + 2 M ≈ 7 L, twice the roadmap. Seams if a part outgrows L:
  - .2 → .2b: describe_database (its row, handler and tests) moves out; .2 keeps query_records and the goldens;
  - .3 → .3b: the manifest row, wrapper and answer move out; .3 keeps the case file, reader, replays and registry row.
- **Saved views change rows** (.1): blank or hex text, text in a number field or a show rollup, and mappings in text fields stop matching. The commit body names them.
- **The oracle can drift into a copy of the code** (.1). Hand-stated readings, the import rail and the separate preconditions guard it. The preconditions catch typos, not wrong intent: review the tables against dates.v1's README.
- **Twins and their gaps (D3):**
  - Rust text order differs from the app on accents, other scripts and some punctuation; answers that sort text say so. UTF-16 vs code point and exotic `String(number)` stay unpinned.
  - Agents can't filter rollups, formulas or derived relations, and the description says so.
  - Two known-field readers (.2's in Rust, checkView in TS) are held only by .4's cases. A gap found there is fixed in its owning part, never papered over.
- **Clocks and zones:** Rust reads the OS zone on each call (.2, .3) and the webview reads its own, so a TZ override on the app process (dev shells) would split them; every answer names its zone. Sunday weeks are a Rust constant held to bandContext by one case. vitest has no TZ pin, so every zone case sets and restores `process.env.TZ`.
- **Cost:** each call scans the cached corpus and rebuilds the schema (.2–.4), unmeasured at 5k notes; the live checks time one call. A 200-line agenda is about 25 KB, so the description asks for narrow windows.
- **Discovery:** no prompt line names the new tools (CV-19), so the model finds them by description and search hint. .4's live check decides whether a typed prompt fragment follows.
- **The card** (.4b):
  - every Add makes a visible tab (Q10); boards and calendars are cramped in the panel (the frame scrolls; Open shows the page);
  - WebKit below Safari 15.5 lacks `inert` until M64.5 raises the floor (D12); `pointer-events-none` and the capture guards back it;
  - rewriting `views:` drops YAML comments (demo work-item.md has one), as every tab edit does; Undo restores them;
  - after a reload without the session file, an answer over 2000 characters loses its payload, and the card says it can't be shown;
  - Accept re-checks against today's vault, so a view that no longer fits shows its problems and can't be added.
- **D17 reverses M6 for the client port** (.5–.5c). Defences: off by default, loopback only, hash-only tokens, one grant per token, the run guards, a runs row per session, and the security review before merge.
  - A token is as safe as the file the other app keeps it in (Claude Code's config, in plaintext). Any local process or user can knock; only a token opens.
  - Unmeasured on 2.1.250: what the CLI does on 401 (OAuth discovery gets 404), whether it probes GET (405), and whether a legacy-mode panel turn also loads a client-port server from the user's config. L2, L3 and .5c's live check record them.
  - An Electron client may send an Origin and get 403 (L6); the rule stays strict.
  - Two apps sharing one token book into one session. Client writes share WRITE_SERIAL and M55.1's path locks with runs. A taken port is named in status; turning access off and on at once may fail to rebind until in-flight requests finish.
  - initialize answers 2025-06-18 whatever the client asks, so an older client may refuse. Cargo can't drive call_tool with a real AppHandle, so L1 is the end-to-end proof.
- **The schema step** (.5): the cause widen drops and renames a column inside the migration's transaction. It needs SQLite 3.35 or later (the bundled libsqlite3-sys is newer) and no index, view or trigger on `cause`. It copies M56.7's CHECK as built; validate_vN pins the list to `cause::ALL` either way. If any read or write toolset row sits on axis none, the `clients` rule refuses the load: move that row's toolset, never weaken the rule. Tokens bind by vault_id, so a moved vault strands them; Settings lists them under "For another vault".
- **Crash wedge:** .5's migration and .5c's settle spawn. Mac cargo keeps the skip list; CI Linux runs the crash suite after the pushes for waves 5 and 7.
- **Hot files** (the waves serialize them):

  | File | Parts |
  | --- | --- |
  | mcp.rs | .2, .4, .3, .5b |
  | tools.v1.json, its sha256, shared/policy/README.md | .2, .4, .3, .5 |
  | policy/tools.rs, src/lib/policy/tools.test.ts | .2, .4, .3 (if), .5 |
  | tool-cases.json, tool-grants.json | .2, .4, .3 |
  | src/engine/tools.test.ts, AgentProperties.test.tsx | .2, .4 (if), .3 |
  | vault/mod.rs | .2, .4, .3 |
  | vault/schema.rs, vault/dates.rs | .2, .3 |
  | vault/query.rs | .2, .4 |
  | viewFilters.ts | .1, .2 (if) |
  | viewSuggestion.ts, toolRenderers.tsx | .4, .4b |
  | surface.ts | .2 (if), .4b |
  | src/lib/policy/tools.ts | .4, .5 |
  | shared/schema/README.md | .2 (if), .4 |
  | mockIpc.ts, mockIpc.test.ts | .4, .5, .5b |
  | AGENTS.md | .2, .4, .3, .5b |
  | SECURITY.md | .2, .4, .4b, .5b, .5c |
  | Cargo.toml | .2, .3, .5b |
  | runtime/budget.rs | .2, .3 |
  | lib.rs, ipc.ts, runtime/client_tokens.rs | .5, .5b |
  | client_access.rs, clientAccessStore.ts, ClientAccessSettings.tsx, e2e/client-access.spec.ts | .5, .5b, .5c |

- **Changes the owner will see:**
  - saved views holding blank or hex text, text in a number field, or mappings in a text field show different rows (.1);
  - agents answer database questions with exact rows and say what they left out (.2); "what's due this week" lists the agenda and never claims free time (.3);
  - "Read the vault" lists three more tools, and a saved selection that matched the group shows chips instead, as with M59.5's list_notes (.2, .3);
  - suggested views arrive as cards with a live preview; Add makes a tab, Add and place puts a block on the open page, and one Undo removes either (.4, .4b);
  - Settings → Other apps: tokens, the Let other apps connect switch, the port and copyable snippets (.5–.5c);
  - Fleet lists other apps' sessions as runs ("codex (other app)"); a page's Info tab names write tokens; a session that wrote is committed on its own (.5b, .5c).
- **Left open on purpose:**
  - a status_group virtual field (Q2) and Rust formula evaluation (Q4);
  - the text-order gap on accents, other scripts and punctuation;
  - repeating records listed once until CALENDAR-7b; formula and computed dates off the agenda;
  - no dashboards or whiteboards suggested (Q9), no hidden tabs (Q10), blocks placed at the end (Q11);
  - no Codex snippet (Q20); claude.ai and ChatGPT can't reach the port; no Claude Desktop bridge;
  - no protocol session id; a shared token shares a session; a moved vault strands its tokens.

## Gate

- **Each part,** before its commit:
  - `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test:run`. .1 adds `pnpm test:coverage`.
  - Parts that touch Rust (.2, .4, .3, .5, .5b, .5c) add `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and the skip-listed `cargo test`.
  - `PORT=<free> pnpm e2e <specs>`, once `lsof -iTCP:<port> -sTCP:LISTEN` shows the port free:

    | Part | Specs |
    | --- | --- |
    | .1 | `collections`, `view-tabs`, `relative-filters`, `computed-values` |
    | .2 | `agent`, `agents`, `collections` |
    | .4 | `agent`, `agents`, `agent-rows` |
    | .4b | `agent-suggest-view`, `agent-rows`, `view-tabs`, `undo`, `batch-writes` |
    | .3 | `agent`, `agents`; plus `calendar-hours`, `calendar-repeat` and `collections` if TS app code changed |
    | .5 | `client-access`, `smoke` |
    | .5b | `client-access`, then the full suite |
    | .5c | `client-access`, `fleet`, `page-access` |

- **Each wave tip:** the same gate on the branch, with the full e2e suite.
- **M62 closes when:**
  - the full gate passes on the tip, with `pnpm test:coverage` holding or raising every floor;
  - CI is green on the push, the Linux crash suite included;
  - every roadmap M62 acceptance bullet holds;
  - the owner has run the packaged checks (.4b, .5, .5b, .5c) on a `./scripts/mac-build.sh` build and the live checks (.2, .3, .4, .5b, .5c) on CLI 2.1.250 with an isolated `CLAUDE_CONFIG_DIR`, and has looked at the built app;
  - .5b's security review is in its commit body;
  - the roadmap's M62 status is updated with the splits and the re-size.

On the Mac, cargo always runs as:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -- --skip crash --skip killed_ \
  --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite
```

## Appendix A — case files and tables

### A1. The oracle (.1)

- **Values:** absent is missing, null, '' or a list with no items; a list holding '' is present. Items are a list's items, else the value. `num(item)`: a finite JSON number, or decimal text; never a boolean, mapping or list. `text(item)`: a string, a number's decimal text, 'true' or 'false'; mappings and lists have none.
- **cmp(item, t):** none when either side is absent. Numeric when both read as numbers; none when only one does. A date or token target: none if the item has no day; a token gives -1 below from, +1 above to, else 0; a date compares days; a date with a time compares minutes (an item with no time is its day at 00:00). Otherwise text vs text by UTF-16 units; none when either side has no text.
- **Operators:** equals: some item === t, or cmp 0; not_equals: not equals. contains, starts_with, ends_with: false for a blank t, else some item's lowercased text holds, starts or ends with t lowercased; does_not_contain: not contains. any_of: some item === some target; none_of: not any_of. gt and after > 0, gte and on_or_after ≥ 0, lt and before < 0, lte and on_or_before ≤ 0, all on the first item; none gives false. is_between [a, b]: ≥ a and ≤ b. is_empty: absent; is_not_empty: present.
- **Groups:** an unfinished condition (one or list arity with no present value; two arity missing a bound) drops out of its group. all of nothing keeps every page. any of nothing keeps none, unless every condition in it was unfinished; then it keeps every page.
- **Where values live:** properties; relationships for person and relation (CV-09); entry facts for created and edited time; or computed. Rollup runs three variants over a child page (max over a number, earliest over a date, show over text); formula runs `n * 1` and `d + 0`.
- **Boundary values:** every kind gets missing, null, '' and [].
  - Text family (text, url, email, phone, repeat): 'Alpha', 'alpha', 'ALPHA beta', 'beta', '5', '05', ' 5 ', ' ', '0x5', 0, 5, true, ['Beta', 'gamma'], [''], {a: 1}, '2026-07-28', '2026-07-28 14:30', plus one kind-typical value.
  - Number: 0, -1, 1.5, 5, 10, '5', '05', ' 5 ', ' ', '0x10', '1e1', 'Infinity', 'abc', true, [5, 1], '2026-07-28'.
  - Date and daterange: 2026-07-25, 07-27, 07-28, '2026-07-28 14:30', 07-29, 08-01, 08-02; '2026-07-28T23:30:00Z'; 'prose'; '2026-02-30'; 5; true; {start 07-27, end 07-29}; {start '07-28 09:00', end '10:00'}; {start '', end 07-30}.
  - Created and edited time: instants 07-27T12:00Z, 07-28T00:30Z, 07-28T12:00Z, 07-29T12:00Z and 08-01T07:30Z, each with a stored `f: 1999-01-01` that must be ignored.
  - Select (options high, low and '5'): 'high', 'HIGH', 'low', 'ghost', ['high'], 5, '5'. Status: todo, doing, done, cancelled, ghost `wip`. Multiselect: ['infra'], ['infra', 'sensor'], ['Infra'], scalar 'infra', ['ghost'], [''].
  - Person and relation: ['ana-marte'], ['ana-marte', 'ben-ito'], ['Ana Marte'], and plain-text 'ana-marte' in properties. Files: lists of attachment paths. Checkbox: true, false, 'true', 'yes', 1, 0, [true]. Rollup and formula: computed 3, 12.5, -2 and 0, a date, a show text, and absent.
- **Targets, per family:**
  - text: alpha, ALPHA, beta, a, '5', '0', 2026-07-28, '' (unfinished);
  - number: 5, '5', 0, -1, 1.5, '1e1'; between [0, 5], [5, 0] and [1.5, '10'];
  - date: 2026-07-28, '2026-07-28 14:30', one instant, today, yesterday, tomorrow, today-1, today+4, this_week, last_week, next_month; between [07-27, 07-28], [today-7, today] and reversed [07-29, 07-27];
  - choice: high, HIGH, ghost, '5'; lists ['high', 'low'], ['ghost'], ['5'], [];
  - multi: infra, INFRA, ana, ana-marte; lists ['infra'], ['ana-marte'], ['ben-ito', 'ghost'], [];
  - boolean: true, false, 'true'; any: the number, date and text targets.
- **Zones and clock:** UTC and America/Los_Angeles; each instant states both readings (07-28T00:30Z reads 07-27 17:30 in Los Angeles). Today is 2026-07-28 (VAULT_TODAY, a Tuesday) with Sunday weeks: this_week 07-26..08-01, last_week 07-19..07-25, next_month 08-01..08-31.
- **Group cases:** all; any; an any nested in an all (the At risk shape); an unfinished condition in each; an any whose every condition is unfinished; an authored empty all and empty any. Virtual fields: the page title beats a `title:` key, type matches, and createdAt takes a date target.

### A2. `filter-cases.json` (.2)

- **Keys:** format 1; an about naming both replayers; zone America/Los_Angeles; today 2026-07-28; week_start 0; corpus; cases; numbers; acceptance. The source-slugs.json precedent: prettier-formatted, no digest, non-ASCII as `\u` escapes (CV-13).
- **Shapes:** corpus `{path, title, type, properties, relationships, createdAt, modifiedAt}`; cases `{why, type?, filters?, sort?, expect, zone?, today?}`, `expect` listing every match in order with no limit; numbers `{text, reads}`; acceptance `{type: "Work item", filters: {all: [{field: status, op: any_of, value: [backlog, todo, progress, review]}]}, sort: [{field: due, dir: asc}], expect}`.
- **Corpus:** a Deal Type doc (status stage: lead and talk active, won done, lost closed; select priority with one labelled option; person owner; number value; date close; daterange window; multiselect tags; relation account → Account; checkbox done; created_time made; last_edited_time edited; one rollup, one formula and one derived relation, for refusals; two views); an Account Type doc (select region; a derived deals relation); about 14 deals, 3 accounts, an untyped note, templates/deal.md, and a knowledge/ page typed Deal.
- **Filters:** every op of every family Rust admits, on stored values including missing, null, '', [] and [''] (0 and false are present); '5', ' 5 ' and '05' equal 5, while ' ' and '0x10' don't; equals 'alpha' doesn't keep 'Alpha', while contains does; dates by day and by minute; `made` and `edited` by day, from createdAt and modifiedAt; one instant in Los Angeles and in UTC; a daterange reads its start; every relative token kind; inclusive is_between; a ghost option by equals; strict any_of (5 isn't '5'); a relationship target and a plain-text relation value; an absent checkbox fails equals false.
- **Fields and sources:** title (the page title beats `title:`), type, createdAt and modifiedAt; an undeclared held key reads as text; nested all/any and authored empty groups; a typed source skips the template and keeps the knowledge page of its type; a typeless source skips templates, knowledge/ and Type docs.
- **Sorts:** status order asc and desc, ghosts after declared values, empties last; select order; numbers; number against text (10 before '9'); dates, `made` and `edited` included; ASCII text whose caseless order equals the app's (Abacus, ABC, apple, Banana, cherry; a before A); two keys; ties in path order; a typeless sort across two types ranks from the first declaring row.
- **README judgment calls:** the cases hold only queries Rust admits (the app skips unfinished conditions; Rust refuses them); Rust orders text caseless, the app by locale; numbers from text use the decimal grammar; rollups, formulas and derived relations aren't evaluated in Rust; tokens resolve on the case's today with Sunday weeks; UTF-16 vs code-point order and exotic `String(number)` stay unpinned.

### A3. `agenda-cases.json` (.3)

- **Keys:** format 1; about; `values` `[{why, zone, kind, value, expect}]`, where expect is `"none"`, `"unreadable"` or `{point, days: [first, last], converted, start, end, labels}`; `windows` `[{why, zone, kind, value, window: [start, end], in, rust_only?}]`; `repeat_pairs` `[{why, fields: [[name, kind], …], pair}]`. ASCII only, prettier-formatted, no digest.
- **Values** (UTC unless a zone is named):
  - 2026-07-24; '2026-07-28 09:00' and '2026-07-28T09:00' (points); 2028-02-29;
  - the instant 2026-07-28T09:20:00Z in UTC, Australia/Sydney (19:20) and America/Los_Angeles (02:20); 2026-07-28T22:30:00Z in Sydney (07-29 08:30); an instant with a +02:00 offset; one with seconds; one DST day per zone, from dates.v1's own cases;
  - ranges: {2026-07-20, 2026-07-31}; same-day 10:00→11:00; the midnight end 22:00→07-29 00:00 (days [07-28, 07-28]); 22:00→07-30 10:00; 22:00→07-30 00:00 (days through 07-29); 11:00→10:00 (a point, "end before start"); 10:00→10:00 (a point, no label); backwards dates; an instant range across Sydney midnight;
  - mixed ends: a date start with a timed end; a date start ending 00:00 on a later day (the day before is the last day); a date start ending 00:00 on its own day (that whole day); a timed start with a same-day date end (a point); a timed start with a later date end;
  - "no end": {start, end: null}, {start: '2026-07-28 09:00'} with no end key, {start, end: 'soon'};
  - unreadable: {end} alone, {}, '{{date}}', prose, 20260724, [2026-07-24], 2026-02-30; none: '', '   ', null.
- **Windows:** {07-20, 07-31} is in [07-20, 08-03); {08-03, 08-20} and {07-07, 07-18} are out; a range ending on the window's first day is in; a point at 08-03 00:00 is out of [.., 08-03) and one at 08-02 23:59 is in; 08-02 22:00→08-03 00:00 is out of [08-03, 08-04); 2026-07-27T23:30:00Z is in [07-28, 07-29) in Sydney and out in UTC. Rust-only: [07-28 12:00, 13:00) excludes 10:00→11:00 and a point at 13:00, and includes a point at 12:30 and the whole day 07-28; [07-28 00:00, 20:00) excludes 22:00→07-30 10:00.
- **Repeat pairs:** [due date, window daterange] → window; [date date] → date; [start date, finish date] → start; [a daterange, b daterange] → a; [title text, done checkbox] → none; [stamp created_time, due date] → due.
- **README judgment calls:** timed windows are Rust-only (the calendar asks for days, the agenda for minutes); start, end and labels are Rust's words; none and unreadable are both null to spanOf; open and backwards ranges read as their start; recurrence isn't expanded (CALENDAR-7b, M61 Q41), and only the pairing is shared; read scope applies to Type docs too.

### A4. `views.v1.json` and `view-suggestion-cases.json` (.4)

- **views.v1 keys, in order:** format 1; artifact_version 1; rule_version `views/<commit date>`.
  - `view_types` `[{id, suggestable, needs, reads}]`, in VIEW_TYPES order: table and list read group, sort, columns, limit; board also needs a band; calendar needs dateField and reads sort, columns, dateField, calendarSpan, limit; gantt and timeline need dateField and read group, sort, columns, dateField, zoom, limit; gallery reads sort, columns, gallery, limit; chart needs chart and an axis and reads group and chart; dashboard and whiteboard are not suggestable.
  - `chart_kinds` `[{id, needs_axis, reads}]`: bar and line read agg, value, xField, groupBy, sort; donut the same without groupBy; number reads agg and value and needs no axis.
  - Then chart_aggs, measured_aggs (sum, avg), chart_sorts, directions, date_buckets, calendar_spans, zooms.
  - `slots` → {fact or family, verb}: group groupable "band a view"; sort orderable "sort a view"; chart.xField groupable "be a chart axis"; chart.groupBy groupable "split a chart"; chart.value numeric "be summed or averaged"; dateField family date "place records on dates"; gallery.cover media "cover a card"; dateBucket family date.
  - Key lists: view (name, filters, presentation), presentation, group, sort, column, chart, gallery.
  - `limits`: name 80, reasoning 280, args_bytes 16384, group_levels 3, sort_keys 4, columns 40, filter_rules 40, filter_depth 3, view_limit 500, problems 20, names_listed 8.
- **Walk order:** view keys in input order; name; filters depth-first; presentation.type; presentation keys not taken, or not read by the layout, in input order; then admitted keys in the artifact's order, arrays by index and chart keys in the artifact's order.
- **Names:** a field is known if virtual, declared, or held by a readable record of the database (no template, nothing in knowledge/). Select, multiselect and status rules with equality or membership ops name declared ids (status through `status_set_for`) or held values. Name lists: declared fields in Type-doc order, then virtual fields in the artifact's order, then held keys by code point; at most 8, then "and N more".
- **Answer:** compact JSON `{suggested: {database, view: {name, filters?, presentation}, reasoning?}, note}`; presentation in the artifact's key order, camelCase, admitted keys only; filters as given.
- **Cases:** a raw-markdown corpus by path: a Type doc declaring status (with `statuses:`), select, multiselect, person, date, daterange, number, formula, files and relation fields; a project with a statuses override; eight records, one holding a ghost option and one an undeclared key; a template and a knowledge/ page each holding a key that must not count; a Type doc with broken YAML. Each case is `{name, args, expect: {answer} | {refusal} | {malformed}}`.
  - Answers: the overdue board on today; a number chart; a bar chart with xField and groupBy; a calendar on a daterange with calendarSpan week; a timeline with zoom; a gallery cover; a table banded by a date with dateBucket week; an echoed reasoning.
  - Refusals: each parse error; an unknown database; the broken Type doc; unknown keys; keys a layout doesn't read; the name rules; an unknown field with and without a closest name; an op misfit; a label for an option id; each slot misfit; each missing need; each bad enum; dashboard and whiteboard; each limit; every problem at once with the 20-line cap; template and knowledge/ keys read as unknown; status options through the project override.

### A5. Token names and grants (.5)

- **Name:** trimmed, no C0, DEL or C1 characters, 1–100 chars. `slug_of`: ASCII lowercase; every other run of characters becomes '-'; trimmed of '-'; cut at 32; empty becomes `app`.
- **Grant:** toolsets through `client_tool_names`. A grant with a writing toolset needs 1–20 write folders; one without stores []. read_scope is null or 1–20 folders, never [].
- **Folders:** trimmed; repeated `./` and outer `/` stripped; at most 512 bytes; no `..` segment and no segment starting with `.`; duplicates dropped in order. A write folder is never the root and never knowledge/ or under it.
- **`client-tokens.json`:** format 1, about, limits, `names` (name → slug or the refusal) and `grants` (request → normalized grant or the refusal, against the shipped manifest). The source-slugs.json precedent; escapes per CV-13.

## Appendix B — text the model reads

All descriptions are at most 2048 characters, name no other tool and no retired term, and use Decision in examples.

### B1. describe_database and query_records (.2)

- **Rows,** after list_notes, in its shape: surface base · toolset read · kind read_only · idempotent true · door none · axis read · no target, no exempt · renderer step · always_load false · confirmable false.
  - describe_database: title `Describe a database` · summary `A database's fields, statuses and views` · icon `table-properties` · search_hint `describe a database fields statuses options views` · fold `described a database` / `described {n} databases`. Input: `type` (string), required.
  - query_records: title `Query records` · summary `Records that match filters, as rows` · icon `funnel` · search_hint `query database records filter sort fields` · fold `queried records` / `queried records {n} times`. Input, none required: `type` (string), `filters` (object), `sort` (array of `{field, dir: asc | desc}`, both required), `fields` (array of strings), `limit` (number).
- **describe_database description:** "Describe one database before reading its records. type is its Type doc's title, such as Decision. The answer gives where new records are filed, its deadline field, its fields in order with their kinds, options (id and label), statuses (each with its group) and link targets, keys its records hold that no field declares, the operators each kind takes, the date forms filters accept, and its saved views with their filters and sorts as stored. Rollups, formulas and the other side of a relation are marked: only the app computes them, so they can't be queried. Only Type docs and records this run may read are described; notes outside its read scope are counted, never named. An unknown type is refused with the types in use."
- **query_records description:** "Read the records of one database, or of every database, that match conditions, as rows. type names the database by its Type doc's title, such as Decision; leave it out to read every record this run may read. filters uses the conditions saved views store: {"all": [...]} or {"any": [...]} of {field, op, value} rules and nested groups. Operators by kind: text equals, not_equals, contains, does_not_contain, starts_with, ends_with; number equals, not_equals, gt, gte, lt, lte, is_between; date equals, before, after, on_or_before, on_or_after, is_between; one choice or status equals, not_equals, any_of, none_of; several choices, people or links contains, does_not_contain, any_of, none_of; checkbox equals, not_equals; any field is_empty, is_not_empty. is_between takes [low, high]. Choices and statuses take option ids, never labels. Dates are YYYY-MM-DD, YYYY-MM-DD HH:MM or relative (today, yesterday, tomorrow, today-7, today+3, this_week, last_week, next_week, this_month, last_month, next_month), read in this Mac's time zone. contains, does_not_contain, starts_with and ends_with ignore case; equals and not_equals match exactly. A field is one the database declares, a key its records hold, or title, type, createdAt or modifiedAt. sort is a list of {field, dir}; statuses and choices sort in their declared order, and empty values go last. fields picks the columns returned (default: the declared fields); limit caps the rows (default 50, at most 100). Each row is a path and title, then a JSON object of its fields; the answer names each column's kind, the databases read and how many more matched. Rollups, formulas and the other side of a relation are computed by the app and can't be queried. An unknown name, operator or option is refused with the closest one; nothing is guessed. Notes outside this run's read scope are not read, and the answer counts them."
- **query_records answer** (exact; singular forms when a count is 1):
  - Header: `{n} of {total} {T} records{ matching the filters}{, sorted by due asc, then …}{scope}:`. `{scope}` is ` ({w} notes outside this run's read scope were not read)`, counted vault-wide. A typeless query says `records`.
  - Rows: `- {path} — {title}{ [Type]}`, then `  {JSON object of the chosen fields}`. Fields with no value are left out; a string over 300 chars is cut with `…`.
  - Then `Columns:` with `- {field}: {kind} — {details}` (options as `id "Label"`, statuses with group and source, links to `{Target}`, one value), and `Types read: {T} ({k} records)`; a typeless query lists each type, then `untyped ({k})`.
  - Footers, in order, each only when it applies: `{more} more {T} records not shown; raise limit (at most 100) or narrow the filters.` (typeless: per type) · `The limit is at most 100.` · `Dates were read in {zone}; today is {date}, and weeks start on Sunday.` · `Text sorted A to Z by letter, ignoring case; accents, other scripts and some punctuation can order differently than in the app.` · `Not returned: {field} ({kind}), …; only the app computes rollups, formulas and the other side of a relation.` · `{c} values over 300 characters were cut.` · `{p} records have frontmatter that could not be parsed, so their fields read as empty.`
  - Empty: `No {T} records match the filters.{scope}`, then the footers.
- **Refusals:** `Nothing was queried:`, then one `- {pos}: {problem}` line per problem:
  - `"{f}" is not a field of {T}. Closest: "{c}". Fields: …` · `"{op}" is not an operator. Closest: …` · `{op} doesn't apply to {f} ({kind}); it takes …`
  - `{op} takes one value` (or `no value`, `two values, [low, high]`, `a list of values`) · `is_between takes [low, high]; {a} is after {b}`
  - `{f} compares numbers, and {v} is not a number` · `{f} compares dates, and {v} is not a date: use YYYY-MM-DD, YYYY-MM-DD HH:MM or a relative date such as today-7 or this_week` · `{f} is a checkbox; use true or false`
  - `"{v}" is not an option of {f}. Closest: …` · `"{v}" is the label of {id}; filters take option ids, so use "{id}"`
  - `{f} is a rollup, which only the app computes, so it can't be queried here` (likewise a formula and the other side of a relation) · `{f} holds several values, so it can't be sorted` · `{f} holds date ranges, which can't be sorted yet`
  - `at most 40 conditions` (likewise `3 levels of nested groups`, `4 sort keys`, `30 fields`) · a parse error names its position and the expected shape, such as `filters: expected {"all": [...]} or {"any": [...]}`
  - `type: no note this run can read has type "{T}". Closest: "{c}". Types in use: …`
- **describe_database answer,** in order:
  - `Database {T} ({doc path}): {k} records{scope}.` · `New records are filed in {folder}.` (when declared) · `Deadline: {field}.` (when declared)
  - `Fields, in order:`, then `- {name}: {kind} — {details}`; a rollup, formula or derived relation (by kind and `from`, never the computed flag) ends `computed by the app, so it can't be queried`. Created and edited times don't.
  - `Every record also has title, type, createdAt and modifiedAt (file times on this disk, compared as dates).` · `Also held, not declared (read as text): {key} ({n} records), …`
  - `Statuses (from {T}):` or `Statuses (the app's defaults):`, then `{id} "{Label}" ({group}) · …`; `{k} records take their statuses from their project: …` when any do.
  - `Operators by kind:` for the families present; one line naming the date forms and the 11 relative tokens, then `Dates are read in {zone}; today is {date}, and weeks start on Sunday.`
  - `Views:`, then `- {id} "{name}" ({layout}): filters {stored JSON, or none}; sort {stored JSON, or none}`, up to 20.
  - No readable Type doc: `No Type doc this run can read declares {T}; {k} records carry it.`, plus its held keys. Refusals: `describe_database needs a type: the database's name, such as Decision`, and the type refusal.

### B2. list_agenda (.3)

- **Row,** after query_records: surface base · title `List the agenda` · summary `Dated records in a window, soonest first` · toolset read · kind read_only · idempotent true · open_world false · door none · axis read · no target, no exempt · renderer step · icon `calendar-range` · always_load false · search_hint `agenda schedule due dates deadlines in a date window` · fold `checked the agenda` / `checked the agenda {n} times` · confirmable false.
- **Description:** "List the dated records that fall in a window of time: every record whose database's Type doc declares a date or date range field holding a value inside [start, end). Use it for questions like "what is due this week", "what was decided in July" or "what is coming up". start and end are dates such as 2026-07-27, dates with a time such as 2026-07-27 09:00, or exact times such as 2026-07-27T09:00:00Z; end is excluded, so the week of July 27 is start 2026-07-27, end 2026-08-03, and the window is at most 370 days. Each line is one dated value: when, the record's title, its type and field, its path, and labels: deadline when the field is its database's declared deadline, ongoing when it began before start, repeats when the record repeats (it is listed only at its stored date, never at later occurrences), and converted when an exact time was turned into this computer's local time. Dates are local and floating, as the person wrote them; a date range includes its end day, and a time with no end is a single moment. Lines come soonest first, up to limit (default 200, at most 200), and the answer says how many more fall in the window. type keeps one database, ignoring case; an unknown type is refused with the types in use. The answer names the date fields it read and counts what it could not list: records with no date set, values that are not dates, notes whose frontmatter could not be parsed, and notes outside this run's read scope. Created and edited times, formulas, date-like properties no Type doc declares and dates written in page text are not listed, nor is a record whose Type doc this run cannot read. This lists records, not the person's calendar: a gap between lines is not free time, so never use it to say when someone is free."
- **Input,** start and end required: `start` "Window start, included: a date such as 2026-07-27, a date and time such as 2026-07-27 09:00, or an exact time such as 2026-07-27T09:00:00Z." · `end` "Window end, excluded: after start and at most 370 days later, in the same forms." · `type` "Only records of this database, ignoring case. An unknown type is refused with the types in use." · `limit` (number) "Max lines (default 200, at most 200)."
- **Answer** (exact; singular forms when a count is 1):
  - Header: `{n} of {total} dated entries{ of type T} from {S} to {E} (end excluded), soonest first{scope}:`. S and E print as YYYY-MM-DD at 00:00, else YYYY-MM-DD HH:MM. `{scope}` is ` ({w} notes outside this run's read scope were not listed)`, vault-wide.
  - Line: `- {when} — {title} [{Type} · {field}] — {path}{ · label}…`. `{when}` is the start, or `{start} to {end}`, dropping the end's date for a timed end on the start's day (`2026-07-28 10:00 to 11:00`).
  - Empty: `No dated entries{ of type T} from {S} to {E} (end excluded).{scope} Only records with dates are listed, so this says nothing about free time.`
  - Special answers, each followed by `{scope}`: `No Type doc this run can read declares {T}, so its records' dates are unknown.` · `{T} declares no date or date range field, so its records have nothing to list.` · `No database this run can read declares a date or date range field, so there is nothing to list.`
  - Footers, in order: `{more} more not listed; narrow the window or name a type{, or raise limit (at most 200)}.` (the last clause only when limit < 200) · `The limit is at most 200.` · `Date fields read: {Type} ({field}, {field}); …` · `{u} records have no date in any of those fields.` · `{p} values in those fields could not be read as dates: {path} ({field}), …{, and {k} more}.` · `{r} records repeat; each is listed only at its stored date, not at its later occurrences.` · `{f} notes have frontmatter that could not be parsed, so whether they hold dates is unknown.` · `Exact times were converted to local time in {zone}.`
- **Refusals,** plain text: `list_agenda needs start and end, such as start 2026-07-27 and end 2026-08-03` · `start must be a date such as 2026-07-27, a date and time such as 2026-07-27 09:00, or an exact time such as 2026-07-27T09:00:00Z` (end alike) · `end must be after start` · `the window is at most 370 days; narrow start and end`; plus M59's type and limit refusals.

### B3. suggest_view (.4)

- **Row,** after propose_organize: surface base · title `Suggest a view` · summary `Suggest a database view for the user to add` · toolset propose · kind read_only · idempotent true · door none · axis read · no target · renderer view · icon `layout-grid` · always_load false · confirmable false · no fold · search_hint `suggest a table, board, calendar or chart view of a database`.
- **Description:** "Suggest a saved view of one database for the user to add: a table, list, board, calendar, gantt, timeline, gallery or chart; a chart of kind number shows one figure. Nothing is written. The user sees it as a card with a live preview and decides whether to add it as a tab on the database's page. database is the title of its Type doc. view.name names the tab. view.filters uses the filter groups saved views store: {"all": [...]} or {"any": [...]} of {field, op, value} rules and nested groups. Select and status values are option ids, and dates may be relative words such as today or today-7. view.presentation sets type and only the keys that layout reads: group levels {field, dir, hideEmpty, dateBucket} (a board needs one), sort {field, dir}, columns {field}, dateField (a calendar, gantt or timeline needs one), calendarSpan, zoom, chart {kind, agg, value, xField, groupBy, sort} (every kind but number needs an axis), gallery.cover and limit. Leave out ids: one is chosen when the view is added. Every field must be one the database declares or its records hold. Anything the view can't show is refused, every problem at once with the closest name, and no card is made. The card is the answer, so keep your reply to a line about why."
- **Input:** `database` (string); `view` {`name` (string), `filters` (object), `presentation` (object); name and presentation required}; `reasoning` (string). Required: database and view.
- **Malformed** (a plain error, words fixed by the cases): not an object; no database string; view not an object; reasoning not a string of at most 280 characters; args over 16 KB.
- **Refusal:** head `schema_invalid: this view of {database} can't be shown, so no card was made.`, then `- {path}: {sentence}` per problem, the path measured from the view root (`name`, `filters.all[1]`, `presentation.group[0]`, `presentation.chart.kind`); after 20, `- and {n} more.` Sentences:
  - `a suggested view takes name, filters and presentation; leave "{key}" out.` · `"{key}" is set on the database's page, not suggested.` · `a {type} doesn't read {key}.` · `a view needs a name of 1 to 80 characters on one line.` · `"{value}" is not one of {a, b or c}.` · `a {type} is built on its page by hand, not suggested.`
  - `a board needs a group level naming the field its columns band by.` · `a {type} needs a dateField.` · `a chart view needs chart.kind.` · `a {kind} chart needs chart.xField or a group level.` · `{agg} needs a value field to measure.` · `count measures no value; leave value out.`
  - `{database} has no field "{name}". Did you mean "{closest}"?` (else `Its fields: …`) · `"{op}" doesn't apply to {field}, a {kind} field. It takes {ops}.` · `{field} has no option "{value}". Did you mean "{id}"?` (else `Its options: …`)
  - `{field}, a {kind} field, can't {verb}. Fields that can: …` (else `None of {database}'s fields can.`) · `dateBucket needs a date field; {field} is a {kind} field.` · `at most {n} group levels` (likewise sort keys, columns, filter rules, levels of nested filters) · `limit is a whole number from 1 to 500.`
- **Other words:** a Type doc with YAML errors: `schema_invalid: {database}'s Type doc has YAML errors, so its fields can't be checked.` · success note: `The user sees this view as a card with a live preview. Nothing is written unless they add it.` · mock agent: `I suggested a view; it is on the card above.` · `I could not suggest that view: {first problem}` · `suggest_view is not available here`.

### B4. The `clients` block (.5)

```json
"clients": {
  "default": "read",
  "grantable": ["write", "comment"],
  "why": "A personal token always reads. It may also hold toolsets whose every row a folder scope bounds; never one that writes Knowledge, proposes, starts agents or moves the app."
}
```

## Appendix C — words the owner reads

- **.4b, the card:** "Suggested view" · "{Layout} · {database}" · "Live preview · {n} of {m} records" · problems "This view no longer fits {database}." · gone "{database} is gone, so this view has nowhere to go." · added "Added as “{name}”" · unavailable "This suggestion can't be shown any more. Ask again if you still want it." · buttons "Add as a tab" · "Add and place on “{page}”" · "Open {database}" · toasts "Added “{name}” to {database}" · "Added “{name}” to {database} and placed it on “{page}”" · "“{page}” ends inside a code block, so the view wasn't placed. Nothing was written."
- **.5, Settings → Other apps:**
  - intro: "Let MCP clients on this Mac — Claude Code in a terminal, Cursor and others — use this vault through Cerebro's own tools, under the guards a run has. Each app gets its own token. A token reads by default; it writes only in folders you name, and never Agent pages, Type docs or Knowledge."
  - rows: `client:<slug>` in mono · "Reads the whole vault" / "Reads {a, b}" · "Writes {a, b}" · the comment toolset's label · "Last used {when}" / "Never used" · "For another vault: {folder}" · "Revoke {name}? Any app using it stops working at once."
  - states: "Reading tokens…" · "No app has a token yet." · `section-unavailable` on a failed read · "Make a token" · at the cap "You have 20 tokens. Revoke one to make another."
  - dialog: name; one checkbox per grantable toolset with the manifest's label and hint; "Writes in" (a folder Picker, required when a writing toolset is checked); "Reads": the whole vault (default) or chosen folders.
  - created: the secret, then "Copy this token now. Cerebro keeps only its fingerprint and can't show it again." · "Copy" · "Done"; a refused clipboard toasts.
  - errors: "Cerebro's runtime database isn't open, so tokens can't be read or made." · cause words "another app connected with a personal token".
- **.5b, the switch and the port:**
  - "Let other apps connect" · hint "Listens on 127.0.0.1 only, while Cerebro is open with this vault. Off by default." · status "Listening at {url}." · "Off. Other apps can't connect." · "Couldn't listen on port {port}: {error}" · "Choose a port from 1024 to 65535."
  - HTTP bodies: 404 "not found: this endpoint serves /mcp only" · 405 "method not allowed: this endpoint takes POST only" · 401 "unauthorized: send a Cerebro personal token as Authorization: Bearer cbr_…" · 401 with a token "unauthorized: Cerebro doesn't know this token. It was revoked, mistyped or made by another install."
  - tool calls on a closed vault: "This token is for the vault {folder}, which isn't open in Cerebro. Open it there, then try again." · an unwritable session row (-32603): "Cerebro couldn't record this session, so it answers nothing."
- **.5c, snippets and reach:**
  - "Connect an app" · labels "Claude Code" and "Cursor and other apps" · placeholders `<address>` and `<your token>` · off "Turn on Let other apps connect first." · hint "claude.ai and ChatGPT run in the cloud and can't reach an address on this Mac. Claude Desktop needs a local bridge, which Cerebro doesn't ship."
  - actor "{slug} (other app)" · reasons "Inside its token's write scope: {folders}." · "Outside its token's write scope: {folders}." · "Its token only reads."
  - Info tab: "Other apps that can change this page: {names}." · "No other app can change this page." · "Couldn't read which other apps have tokens."

## Appendix D — conventions and SECURITY.md

- **CV-42 (.5b; the next free id at build time):** "**Other apps reach a vault only through a personal token** (M62.5b). The run port keeps M6's private per-run bearer and never answers 401. The client port is off by default, binds loopback only, stores a token as its SHA-256 alone, and dispatches through call_tool's guards under one runs row per client session." enforced: `src-tauri/src/runtime/client_tokens.rs::a_minted_token_is_stored_as_its_hash_alone`, `src-tauri/src/client_access.rs::every_answered_call_carries_its_session_run`, `src-tauri/src/client_access.rs::nothing_listens_until_turned_on`, `src-tauri/src/mcp.rs::a_cbr_token_on_the_run_port_is_an_unknown_bearer`
- **CV-04 (.4)** `enforced:` gains `src-tauri/src/vault/views.rs::the_loaded_bytes_match_the_committed_digest` and `src/engine/viewVocabulary.test.ts::hashes to the digest the Rust reader also asserts`.
- **SECURITY.md, Other apps (.5b),** after "Loopback MCP only.": off by default; loopback only, on a fixed port; `cbr_` tokens shown once and stored as SHA-256; at most 20, revoked at once; one grant per token, under the same guards as a run; one runs row per client session; Host, Origin, 401 and 405; only the open vault; a token is as safe as the file the other app keeps it in; any local process can knock, but only a token opens; claude.ai and ChatGPT can't reach it; this reverses M6 for this listener only (D17, default taken). .5c adds: a session that wrote commits its own writes when it ends, like a run.
