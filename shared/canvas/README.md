# JSON Canvas files

`format.v1.json` is the format, vocabulary, limits and writer layout both
readers consume. `format.v1.sha256` pins its exact bytes. The engine's
`scene/format.ts` and Rust's `canvas/format.rs` reject malformed artifacts in
the same words, replaying `format-cases.json`.

`cases.json` drives `scene/jsonCanvas.test.ts` and `canvas/read.rs`. An input
ending in `.canvas` names a text file in `goldens/`; every other input is the
literal file content. Readable cases give node/edge/ink counts, problems,
search text and file references. `canonical` is a golden name, literal text,
or `same`. The TS and Rust writers replay the same bytes (M68.7).

The six goldens cover the four standard card types, unknown values, Cerebro
shapes and ink, dangling connections, noncanonical whitespace and an empty
board. `obsidian-layout` follows the layout specified in the milestone plan;
an actual Obsidian open/save check is still pending and is not represented
as completed provenance.

Known string fields must be valid Unicode. Unknown values retain minified
raw JSON, including number spelling, nested duplicate keys and escaped lone
surrogates. At a parsed object boundary, duplicate members retain their first
position and their last value. Unknown object contents are not interpreted.
File coordinates are integer literals within the shared bounds. Readers
accept a BOM and JSON whitespace; the writer drops the BOM. Broken input is
unavailable, never an empty board. Orphan card extras are reported and dropped;
dangling connections and unknown colour strings are retained and reported.

The format follows [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/). Cerebro
adds `cerebro.version`, per-card shapes and ink; JSON Canvas readers may ignore
those keys. The shared layout uses tabs, one compact item per line and no
trailing newline. New boards gain `cerebro` only when extras are needed.

After deliberately editing the format, regenerate its digest with the
ignored Rust writer, then replay both readers. On macOS use the exact skip
list (never the broad `--skip kill`):

```sh
cd src-tauri
cargo test --lib canvas::format::tests::write_canvas_digest -- --ignored --skip crash --skip killed_ --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite
cargo test --lib canvas:: -- --skip crash --skip killed_ --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite
```

Then run `pnpm test:run src/engine/scene` from the repository root. Never run
Prettier over these files: their layout and bytes are part of the contract.

`agent-limits.v1.json` bounds an agent read's nodes, serialized UTF-8 bytes,
and selected ids. It does not duplicate file geometry or file-size limits.
Rust `canvas/agent_limits.rs` and TS `scene/canvasLimits.ts` read these bytes;
`agent-limit-cases.json` pins their closed shape and refusal wording. A read
returns metadata even for an empty board, and a cut answer names its cut and
the next node number. Unknown board values are retained by the file codec
and are not added to the agent answer. Card targets outside read scope are
not looked up; the tool never reads a card's contents or fetches a URL.

After editing agent limits, regenerate with the same macOS skip list:

```sh
cd src-tauri
cargo test --lib canvas::agent_limits::tests::write_canvas_agent_limits_digest -- --ignored --skip crash --skip killed_ --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite
```

Replay `canvas::` and `pnpm test:run src/engine/scene` afterward.
