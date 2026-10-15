# `shared/schema/` — the field-kind vocabulary as data (M60.3)

What each property kind is, what a value of it may hold, and the words a
refusal says, in one file that Rust compiles in with `include_str!` and
TypeScript imports through vite. Both readers replay its `cases` (the D3
ruling in `shared/policy/README.md`).

## The files

| File | What it is | Readers |
| --- | --- | --- |
| `field-kinds.v1.json` | `atoms` (the value shapes a kind may accept); `url_prefixes` and `url_match`; the 17 `kinds` in `FIELD_KINDS` order, each `{kind, accepts, multi, computed, links, groupable, orderable, numeric, media, filters, status_set, legacy, messages}`; the 19 `filter_ops` in menu order and the `filter_families`; `status_groups`, `status_group_default`, `status_chain` and the five `default_statuses`; `rollup_calcs` with each result (`number`, `value`, `text`); `virtual_fields`; `collation`; and `cases` (`values`, `field_defs`, `statuses`, `options`, `labels`, `precedence`). Dates are referenced (`dates`), never restated: see `shared/calendar/`. | `src-tauri/src/vault/schema.rs` (`table`, `FieldKind`, `VaultSchema`, `parse_field_def`, `parse_statuses`, `option_id`, `humanize`, `validate_value`, `stored_value`), `src/engine/fieldKindTable.ts` (`FIELD_KIND_TABLE`, `kindFacts`, `FAMILY_OPS`, `DEFAULT_STATUS_SET`, `ROLLUP_RESULTS`, `URL_PREFIXES`, `VIRTUAL_FIELDS`), which `properties.ts`, `schema.ts` and `viewFilters.ts` read. |
| `field-kinds.v1.sha256` | The committed SHA-256 of `field-kinds.v1.json`. Rust checks it when the table loads and in `the_loaded_bytes_match_the_committed_digest`; vitest in `fieldKindTable.test.ts`. | both |

`FIELD_KINDS`, `FILTER_OPS`, `FILTER_FAMILIES` and the `RollupCalc` list stay
TS literals because they define unions; `fieldKindTable.test.ts` holds each
to this file, in order. Rust holds `FieldKind::ALL` the same way.

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
the rollup labels are UI, and Rust draws nothing.

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

M60.5's cast table and M61.4's formula kind extend this file the same way:
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
- Rust's `field_value` reads no rollup and no derived relation: it holds no
  relation index to compute them from, so it answers none, and the
  precedence cases hold only the stored and stamped reads.
