# `shared/schema/` — field and view vocabularies as data

What each property kind is, what a value of it may hold, and the words a
refusal says, in one file that Rust compiles in with `include_str!` and
TypeScript imports through vite. Both readers replay its `cases` (the D3
ruling in `shared/policy/README.md`).

## The files

| File | What it is | Readers |
| --- | --- | --- |
| `field-kinds.v1.json` | `atoms` (the value shapes a kind may accept); `url_prefixes` and `url_match`; the `kinds` in `FIELD_KINDS` order, each `{kind, accepts, multi, computed, links, groupable, orderable, numeric, media, filters, status_set, legacy, messages}`; the 19 `filter_ops` in menu order and the `filter_families`; `status_groups`, `status_group_default`, `status_chain` and the five `default_statuses`; `rollup_calcs` with each result (`number`, `value`, `text`); `virtual_fields`; `collation`; and `cases` (`values`, `field_defs`, `statuses`, `options`, `labels`, `precedence`). Dates are referenced (`dates`), never restated: see `shared/calendar/`. | `src-tauri/src/vault/schema.rs` (`table`, `FieldKind`, `VaultSchema`, `parse_field_def`, `parse_statuses`, `option_id`, `humanize`, `validate_value`, `stored_value`), `src/engine/fieldKindTable.ts` (`FIELD_KIND_TABLE`, `kindFacts`, `FAMILY_OPS`, `DEFAULT_STATUS_SET`, `ROLLUP_RESULTS`, `URL_PREFIXES`, `VIRTUAL_FIELDS`), which `properties.ts`, `schema.ts` and `viewFilters.ts` read. |
| `field-kinds.v1.sha256` | The committed SHA-256 of `field-kinds.v1.json`. Rust checks it when the table loads and in `the_loaded_bytes_match_the_committed_digest`; vitest in `fieldKindTable.test.ts`. | both |
| `views.v1.json` + `views.v1.sha256` | Checked view vocabulary (M62.4): layout needs and read keys, chart kinds, enums, field capability slots, strict key lists and limits. The digest pins the exact bytes in both readers. | `src-tauri/src/vault/views.rs`, `src/engine/viewVocabulary.ts`; validators in `views.rs` and `src/engine/viewSuggestion.ts` replay `src-tauri/fixtures/view-suggestion-cases.json`. |

`FIELD_KINDS`, `FILTER_OPS`, `FILTER_FAMILIES` and the `RollupCalc` list stay
TS literals because they define unions; `fieldKindTable.test.ts` holds each
to this file, in order. Rust holds `FieldKind::ALL` the same way.

`deadline_cases` pins a Type doc's `deadline:` capability (M61.3b), replayed
by `schema.rs::replays_the_deadline_cases` and `fieldKindTable.test.ts` through
`buildSchema`. A string, trimmed, must exactly name a declared stored `date`
or `daterange` field on that doc. Other kinds, computed timestamps, missing
fields and non-string values declare no deadline. Rust's
`VaultSchema::deadline_field` exposes the same field for the query and agenda
readers; the renderer uses `TypeDef.deadline`.

Messages say `{name}` where the field's name goes, in today's words, and
non-ASCII is written as `\u` escapes. Every kind has `shape`; a kind with
`links` (person, relation) also has `limit_one` and `derived`; a kind that
accepts `date_range` also has `endpoint` and `backwards`.

Both readers refuse a malformed table in the same words: a format other
than 1, an empty `rule_version`, kinds other than the code's list in order,
an unknown atom, a family operator `filter_ops` lacks, families other than
the code's list, a missing required message, a default status with an
unknown group or a repeated id, rollup calcs other than the code's list, or
an unknown collation word.

## The check order

`validate_value` and `validateValue` check one value against its declared
field in this order, and stop at the first refusal:

1. `null` (a delete) passes.
2. A computed kind refuses every write (`shape`).
3. A `links` kind with a reverse `from` refuses (`derived`): it stores
   nothing, and the owning side would contradict a mirror.
4. The value must hold one of the kind's `accepts` atoms (`shape`).
5. A `date_range` must have a real start and real endpoints and must not run
   backwards (`shape`, `endpoint`, `backwards`), by `shared/calendar/`.
6. A `links` kind with `limit: 1` holds one link (`limit_one`).

Option membership stays advisory: an unknown select value is a ghost, never
a refusal.

## What stays TS-only

Labels, icons and seeds (`KIND_UI` in `src/engine/properties.ts`), the
catalog order, display settings (`format`, `dateFormat`, `visibility`) and
the rollup and formula labels are UI, and Rust draws nothing.

Both field-definition readers preserve exactly `source: correspondence` (M69.9),
with positive, unknown-source and non-string cases. Cached-mail rollups are
renderer-only: they aggregate recorded header instants or thread counts.
Without cached mail every result is absent, including count. A Type doc's
`email_domain:` is also renderer-only and must name one of its declared text
or URL fields. It never gives Rust another writer or source of authority.

Rollup evaluation also stays in TypeScript. `percent_done` (M61.11b)
counts a status in its record's own status set: done enters the numerator;
closed leaves the denominator; active, unknown and empty stay in the
denominator. A checkbox counts only `true` as done, with every target in
the denominator. A property declared as neither status nor checkbox is
left out, including an undeclared property. With nothing measured the
result is blank, never zero; otherwise it is a percentage rounded to two
decimal places. The artifact pins the calc and its numeric result, and
both readers replay its field-definition case.

Formula evaluation also stays in TypeScript. The `formula` kind (M61.4) is
computed and accepts no stored value. Both readers preserve a field
definition's `formula` string exactly, including whitespace; Rust never
evaluates it; query_records refuses formulas by name (M62.2). The renderer
owns parsing and evaluation in `src/engine/formula.ts`.

Spreadsheet Excel A1 formulas are a separate dialect (M67.1), computed on
upstream IronCalc by `src-tauri/src/sheet/engine.rs`. They live as source
cells in page `cerebro-sheet` fences; neither dialect imports the other's
parser. The dev browser mock uses the same pinned release, and both engines
replay `src-tauri/fixtures/sheet-calc-cases.json`.

The `repeat` kind (M61.10) accepts only stored text. Rust checks the value
shape, never parses or expands the RRULE. The renderer interprets the
supported recurrence subset in `src/engine/recurrence.ts`; unknown rule
parts are preserved and described as not understood.

## Pinned as data

- **Virtual-field precedence:** an entry fact (`virtual_fields`), then a
  declared computed kind, then the relationship, then the property. The
  `precedence` cases replay it through `schema.fieldValue` and Rust's
  `VaultSchema::field_value`.
- **Collation:** text tests compare lowercase (`lowercase`); equality is
  exact (`exact`); ordered operators compare by number, then by the date
  grammar's day, then by UTF-16 code unit (`number_date_code_unit`); view
  sort uses declared options, then number, then the reader's locale
  (`options_number_locale`, TS-only). M62.2's Rust evaluator orders text by
  code point and says so, with no ICU dependency.

Date-family fields are groupable through relative or calendar buckets (M61.3),
never their raw stored text. Day bands accept creates and moves; multi-day and
invalid-value bands do not. Computed timestamps remain read-only. The renderer
owns these view intervals in `src/engine/dateBuckets.ts`; both schema readers
still derive grouping capability from this artifact.

## Regenerating

After a deliberate edit, bump `artifact_version`, set `rule_version` to
`field-kinds/<date>`, then, with the Mac crash skip list from
`.husky/pre-push`:

```sh
cd src-tauri
cargo test --lib vault::schema::tests::write_field_kinds_digest -- --ignored \
  --skip crash --skip killed_ --skip kill_and_restart --skip a_kill_ \
  --skip kill_point --skip interrupted_overwrite
```

Further field kinds and capabilities extend this file the same way:
a new key or kind, a new case, a bumped `artifact_version` and a regenerated
digest. A new kind joins `FIELD_KINDS`, `FieldKind::ALL` and `KIND_UI` in the
same commit, or both loaders refuse the table.

Never run a formatter over this folder: `.prettierignore` skips it because
the bytes are hashed.

## Known divergences the cases leave unpinned

- JS `trim` and `\s` versus Rust's `trim` and `char::is_whitespace` on
  U+FEFF, U+0085 and a few other separators (`optionId`, `humanize`).
- Capitalising an astral first character: `humanize`'s `charAt(0)` splits a
  surrogate pair and leaves it as it was, while Rust uppercases the
  character.
- `String(number)` versus serde's number text for an exotic numeric option
  id (`3.0`, `1e21`).
- `toLowerCase` versus `to_lowercase` outside the cases' Latin letters.
- UTF-16 versus code-point order (the collation above).
- Rust's `field_value` reads no rollup, formula or derived relation: it holds no
  relation index or formula evaluator, so it answers none, and the
  precedence cases hold only the stored and stamped reads.

## Checked view suggestions (M62.4)

A suggestion is strict input: unknown keys, unread layout settings, invalid
field capabilities and filter values are refused together. No id is accepted;
the app mints it only when the user adds the view. Options use ids, never
labels; a held ghost id remains valid. Only readable Type docs and their
ordinary records supply fields or options; templates and knowledge pages
supply no held keys. Dashboards and whiteboards are built on their pages,
not suggested. Formula filters and chart values are admitted because the
app evaluates them; Rust checks their shape and never evaluates a formula.
Relative dates stay authored tokens. Suggestion checking has no clock, so
relative bounds are not ordered until evaluation. Presentation echo is
sparse, in artifact key order, without invented defaults.

After a deliberate vocabulary edit, bump its `artifact_version` and
`rule_version`, then regenerate the digest and replay both readers:

```sh
cd src-tauri
cargo test --lib vault::views::tests::write_views_digest -- --ignored \
  --skip crash --skip killed_ --skip kill_and_restart --skip a_kill_ \
  --skip kill_point --skip interrupted_overwrite
cargo test --lib vault::views::tests -- \
  --skip crash --skip killed_ --skip kill_and_restart --skip a_kill_ \
  --skip kill_point --skip interrupted_overwrite
```

The TS replay is `pnpm test:run src/engine/viewVocabulary.test.ts
src/engine/viewSuggestion.test.ts`. The case file pins exact answer and
refusal words, canonical echo, capability checks and resource caps. TS
union literals remain necessary for types; the vocabulary tests hold them
to the artifact in order.
