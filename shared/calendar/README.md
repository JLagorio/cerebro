# `shared/calendar/` — the date grammar as data (M60.3)

One file decides what a stored date property is. Rust compiles it in with
`include_str!`; TypeScript imports the same bytes through vite. Neither
language holds the rule, and both replay its `cases` (the D3 ruling in
`shared/policy/README.md`).

## The files

| File | What it is | Readers |
| --- | --- | --- |
| `dates.v1.json` | The grammar: three forms (`date`, `date_time`, `instant`), the time separators (`' '` and `'T'`; writes use `' '`), an instant's optional seconds, 1 to 9 fraction digits and `Z` or `±HH:MM` zone, the proleptic Gregorian calendar, `read: lenient`, `write: strict`, `backwards: same_form`, and the `cases`. Each case is `{name, input, zone, valid, read}`: `valid` is the strict write check (date text for a string, no range fault for a mapping), and `read` is the lenient reading, an instant shown as its wall time in `zone`. | `src-tauri/src/vault/dates.rs` (`grammar`, `parse_date_text`, `is_date_text`, `read_date_value`, `range_fault`), `src/engine/dateGrammar.ts` (`parseDateGrammar`, `parseDateText`, `isDateText`, `readDateValue`, `dateRangeFault`); `src/engine/dates.ts` `parseEndpoint` and `parseDateProperty` read through it. |
| `dates.v1.sha256` | The committed SHA-256 of `dates.v1.json`. Rust checks it when the grammar loads and in `the_loaded_bytes_match_the_committed_digest`; vitest in `dateGrammar.test.ts`. | both |

Both readers refuse a malformed grammar in the same words: a format other
than 1, an empty `rule_version`, an unknown form, no time separators, an
unknown word in a closed key, or no cases.

`relative` (M61.3c) declares filter tokens, day offsets, calendar periods,
week starts and their words. `relative_cases` replays through Rust's
`resolve_relative` and TS's `relativeDates.resolveRelative`; both take today
and the week start as arguments and return inclusive day ranges. Tokens are
case sensitive and trimmed. `today+N` and `today-N` take 1–999 without leading
zeros. Weeks start on Sunday (0) or Monday (1); months are full calendar
months, including leap days. Resolution outside the four-digit date grammar
returns no date. These strings are filter values, never stored date values.

## Regenerating

After a deliberate edit, bump `artifact_version`, set `rule_version` to
`dates/<date>`, then, with the Mac crash skip list from `.husky/pre-push`:

```sh
cd src-tauri
cargo test --lib vault::dates::tests::write_dates_digest -- --ignored \
  --skip crash --skip killed_ --skip kill_and_restart --skip a_kill_ \
  --skip kill_point --skip interrupted_overwrite
```

Never run a formatter over this folder: `.prettierignore` skips it because
the bytes are hashed.

## Judgment calls recorded here

- **Instants are admitted.** M16.14 degraded `2026-07-30T10:00:00Z` to its
  UTC date, because lifting `10:00` out of it as a local time would shift it.
  That is reversed: an instant is a moment, kept verbatim on write and read
  as the wall time of the reader's zone (Rust takes the zone as an argument;
  TS reads the machine's). It is what `mcp.rs` `now_iso` and the scanner
  write (phx-421's `fetched_at`), and validation used to refuse it.
- **Writes are strict, reads lenient.** A write stores exact text and never
  a backwards range or an end without a start (`{name} ends before it
  starts`; an end with no start is a bad endpoint). A read trims, reads a
  junk end as an open range and a backwards range as written, so nothing on
  disk stops showing; `spanOf` keeps its one-day milestone.
- **Days are real calendar days.** `2026-02-29` and `2026-02-30` are not
  dates; `2024-02-29` is. Prose after a day (`2026-07-28 kickoff`) is not a
  date either: the grammar is narrow and grows only with a case.
- **Seconds appear only on instants.** A zone-less `2026-07-28T09:20:00` is
  refused: without a zone it is neither a wall time this app writes nor a
  moment.
- **`same_form` comparison.** Two instants compare as moments, to the
  nanosecond. Two floating values compare by day, and by time only when both
  carry one. An instant and a floating value are not compared.
- **Body chips are not in this file.** The `📅` token grammar
  (`parseDateToken` in `src/engine/dates.ts`) lives in note bodies and only
  TS reads it.
- **Point events and midnight ends** replay
  `src-tauri/fixtures/agenda-cases.json` in `vault/agenda.rs` and
  `src/engine/agendaCases.test.ts` (M62.3). The grammar here still reads
  endpoints; that case file holds their placement and window overlap.
  Grid geometry remains TypeScript-only. Agenda bounds and display labels
  are Rust's words; the shared point, span, conversion and repeat-pair facts
  are checked in both languages.

## Known divergences the cases leave unpinned

- JS `trim` strips U+FEFF; Rust's `str::trim` does not, and the two disagree
  on U+0085 and a few other separators. A lenient read of text padded with
  them can differ.
- An offset that carries `9999-12-31` past the year 9999 prints a five-digit
  year in both, but no case holds it.
- The zone source differs by design: Rust is handed a `Tz`, TS uses the
  machine's zone. The cases inject a zone per case (`process.env.TZ` in
  vitest, `chrono_tz` in cargo).
