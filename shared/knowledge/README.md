# Source locations (M97.1)

`source-location.v1.json` bounds the local Markdown locator/resolver. Rust
`source_location.rs` and TypeScript `engine/sourceLocation.ts` consume the same
bytes; `source-location.v1.sha256` anchors those bytes. The shared cases cover
raw UTF-8 ranges, source revisions, property rows, ambiguous occurrences and
scope denial. Body offsets exclude frontmatter and are end-exclusive. They
never address normalized display text.

The resolver reads at most 8 MiB of raw local source and examines at most the
existing first 100 KiB of body. A source over the read cap is unavailable, not
empty. Search can retain a snapshot of a longer local file; resolution still
reports the bounded read limit honestly. Quotes hold at most 240 Unicode scalars
and each adjacent context at most 80. Property matches use production searchable
field flattening and identify a row, never an array member.

After an intentional artifact edit regenerate its anchor with
`cargo test --offline --manifest-path src-tauri/Cargo.toml --lib
source_location::tests::write_source_location_digest -- --ignored` and replay
`source_location`, `search::tests::`, `vault::corpus::tests::`,
`src/engine/sourceLocation.test.ts`, and the mock/IPC contract tests. Keep the
artifact and anchor together. No runtime ledger or policy authority is added.

On an unchanged full-file hash, a property locator validates one matching key
and at least one occurrence of its recorded quote/context in that row. Repeated
values remain valid because the locator identifies the row, not an array member.
After a hash change, relocation requires one unique recorded-context match.
Malformed or oversized frontmatter makes property resolution unavailable; an
unreadable mapping is never treated as an absent or changed property.

## Contextual occurrences (M97.5 bounded read slice)

`source-occurrences.v1.json` holds the query work limits and mention matching
rules. `source-occurrences-cases.json` replays the same raw-body/link resolution
cases through `source_occurrences.rs` and `engine/sourceOccurrences.test.ts`.
Fragment padding uses the table's explicit Unicode scalar list, including NEXT
LINE and BOM, after canonical whole-name-first resolution. Rust and JavaScript
have different built-in trim sets, so neither defines occurrence fragments.
The shared cases check fragment values and literal occurrence IDs for body and
property occurrences. This does not change the general link resolver's naming
or property-text extraction rules.
These query limits follow corpus loading: 50 returned occurrences, 500 examined
sources and 8 MiB of examined searchable text per page; the existing 100 KiB body
cap remains. The corpus loader is independently measured.

Cursors contain only version/target/mode/scope/snapshot identity and source/row
positions. Changed scope or corpus returns no rows and needs an explicit refresh.
A work-cap stop has continuation even with zero rows. A single source larger than
the work budget is counted capped and advances, so a cursor cannot get stuck.
An occurrence too long for the existing locator quote limit is also disclosed as
capped; no shortened fabricated location is emitted.

Mention candidates are the requested target's canonical filename stem, project
folder, valid item key and title, each retained only when the shared resolver
chooses that path. Scalar lowercase matching preserves original boundaries even
across Unicode expansions, rejects adjacent Unicode letters/numbers/underscore,
and excludes existing wikilinks including aliases. Original byte ranges and
same-read source hashes identify body occurrences; relation properties identify
one row, never an array member. Mention discovery writes nothing. Creating a link
from a chosen mention remains a separate existing-human-writer integration.
