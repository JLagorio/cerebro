# `shared/files/` — what a file is, as data (M66.1)

One table answers "what is this file" for every surface that shows, reads or
opens one. Rust compiles it in with `include_str!`; TypeScript imports the
same bytes through vite. Neither language holds an extension list, and both
replay `src-tauri/fixtures/file-kind-cases.json` (the D3 ruling in
`shared/policy/README.md`, where the twin is registered).

## The files

| File | What it is | Readers |
| --- | --- | --- |
| `kinds.v1.json` | The table: `format` 1, `artifact_version`, `limits`, the `unknown` row, `kinds` (one row per extension) and `names` (exact filenames that override how a file is drawn). | `src-tauri/src/files/kinds.rs` (`parse`, `table`, `ext_of`, `lookup`, `open_policy`, `limits`), `src/engine/fileKinds.ts` (`parseKinds`, `KINDS`, `extOf`, `kindFor`, `fileLook`, `shikiFor`, `captureExtensions`, `isCapturable`, `CAPTURE_MAX_BYTES`). |
| `kinds.v1.sha256` | The committed SHA-256 of `kinds.v1.json`. Rust checks it in `the_loaded_bytes_match_the_committed_digest`, vitest in `fileKinds.test.ts`. | both |

## The columns

Each `kinds` row has these keys, in this order, on one line:

| Key | What it says | Who reads it |
| --- | --- | --- |
| `ext` | The extension, lowercase letters and digits, no dot. | both |
| `kind` | archive, audio, binary, code, data, design, diagram, document, executable, font, image, markdown, pdf, presentation, spreadsheet, text, unknown or video. | both: `isMarkdownPath` reads markdown |
| `mime` | The IANA type, lowercase. Code is `text/plain`, and so is a text format nobody registered (`srt`, `jsonc`, `ini`); a binary nobody registered is `application/octet-stream`. Media rows carry the type browsers play them by (`audio/aiff`, `video/x-matroska`). | Rust, from M66.2's doors |
| `viewer` | code, doc, image, media, none, pdf or table. | TS: `viewerKindFor` answers doc for a doc row and code otherwise, until M66.4's viewers read the rest |
| `extractor` | docx, pdf, pptx, xlsx or null: the reader that turns the file into text. | Rust, from M66.7 |
| `ingest` | capture (the Inbox takes it as text), extract (through its extractor, from M66.7c) or none. | TS: `captureExtensions`, `isCapturable`, and `src/lib/ingest.ts` from them |
| `shiki` | The Shiki language id, or null for plain text. | TS: `shikiFor`, and `languageFor` in `src/workspace/highlighter.tsx` |
| `icon` | A lucide icon name. | TS: `fileLook`, and `lookFor` in `src/workspace/fileIcons.ts` |
| `color` | blue, green, n-400, n-500, orange, pink, purple, red, yellow or null. `blue` draws as `var(--opt-blue)`, `n-500` as `var(--n-500)`. | TS: `lookFor` |
| `bytes` | scheme (the file scheme, images, audio and video only), ipc (raw IPC, PDFs only) or none. | Rust alone, from M66.2 |
| `open` | allow, confirm or deny: whether the file may open in its default app. | Rust alone: `open_policy` |

`names` rows hold `name` (the exact filename, lowercase) and at least one of
`icon`, `color` and `shiki`. They are presentation: TS draws a file by its
name's override first, then its extension's row, then the unknown row, and
Rust validates them and never reads them.

`limits.capture_max_bytes` (4 MiB) is the largest file the Inbox captures.

## The rules the rows follow

- **Ordering.** `kinds` sorted by `ext`, `names` by `name`, no repeat; one row
  per line, keys in the order above. Byte order and UTF-16 order agree for
  every key here because both are ASCII; a non-ASCII name would sort
  differently in the two readers, so none is listed.
- **The extension** is the last path segment, ASCII-lowercased, after its last
  dot; none when the dot is the first or last character (`.env`, `notes.`).
  Only ASCII letters are lowercased, so a non-ASCII extension reads as unknown
  in both languages (a case pins `clip.mKv`, whose Kelvin sign a full
  Unicode lowercase would turn into a video).
- **Doors.** `bytes: scheme` only on image, audio and video rows; `bytes: ipc`
  only on pdf. Every other row stays off both.
- **Capture.** `ingest: capture` only on markdown and text rows (md, markdown,
  txt, text, vtt, srt); `ingest: extract` only on a row with an extractor;
  an extractor only on pdf, document, presentation and spreadsheet rows.
- **Open.** allow only where macOS's default handler views the file:
  markdown, text, images but svg, audio, video, pdf, documents,
  presentations, spreadsheets but xlsm, csv, tsv and design files. deny on
  every executable row and on the scripts a default handler may run (sh,
  bash, zsh, fish, csh, ksh, py, pyw, pl, rb). confirm on everything else.
- **The verdict** (`open_policy`, Rust only): a regular file whose first bytes
  are `#!`, ELF, Mach-O (`FEEDFACE`, `FEEDFACF`, `CEFAEDFE`, `CFFAEDFE`), fat
  Mach-O or Java class (`CAFEBABE`) or PE (`MZ`) is deny, whatever its row; a
  deny row is deny; a file with an execute bit and no row is deny (an execute
  bit on a known row is not, since exFAT and SMB volumes mark every file
  executable); otherwise the row. A path it cannot read is deny, and a folder
  (an `.app` or `.pages` bundle) is its row alone.

## The unknown row

Every extension the table does not name, and every file with none, reads as
the unknown row: kind unknown, `application/octet-stream`, viewer code, no
extractor, ingest none, no shiki, icon `file`, no colour, bytes none, open
confirm. Because it is data, "an unknown kind confirms" comes from the table in
both languages, and the loaders refuse any other unknown row.

## The loaders refuse

In the same words, each replayed from the case file's `refusals`: a format
other than 1; an unknown or missing field, or a field of the wrong type; an
ext outside `^[a-z0-9]+$`, out of order or repeated; a name not lowercase,
holding `/`, out of order, repeated or overriding nothing; a value outside its
vocabulary; a mime that is not lowercase `type/subtype`; a door, capture or
extractor off its kinds; any other unknown row; a limit or `artifact_version`
that is not a positive integer; an empty icon or shiki.

## Kept outside this table

- `vault/scan.rs` keeps its own `md | mmd` match: which files are vault
  entries is the vault format (M47). `the_scan_set_is_markdown_and_diagram`
  pins that both rows exist.
- `src/engine/pageMedia.ts` keeps BlockNote's own media lists (M55.4), held to
  this table by a parity test until M66.6. Its known differences are named
  there: BlockNote calls ogg a video, and lists flv, wmv, weba and epub, which
  have no row here.
- Folder glyphs stay in `fileIcons.ts`: a folder is not a file kind.

## Regenerating

After a deliberate edit, bump `artifact_version`, then, with the Mac crash
skip list from `.husky/pre-push`:

```sh
cd src-tauri
cargo test --lib files::kinds::tests::write_kinds_digest -- --ignored \
  --skip crash --skip killed_ --skip kill_and_restart --skip a_kill_ \
  --skip kill_point --skip interrupted_overwrite
```

Then replay both readers: `pnpm vitest run src/engine/fileKinds.test.ts` and
`cargo test --lib files::` with the same skip list. A changed icon, colour or
language of a key the old maps held also edits the RETIRED snapshot in
`fileKinds.test.ts`.

Never run a formatter over this folder: `.prettierignore` skips it because
the bytes are hashed and the rows are one per line.
