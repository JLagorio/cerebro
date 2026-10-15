# Import sources

`sources.v1.json` is the shared rule artifact for import identity, stamps and
outcomes and agent stamp protection (M69.3–.3b). Rust's `import/mod.rs` and the pure TypeScript
`engine/importSources.ts` read the same bytes and replay its cases. Rules
change here, with an artifact-version bump and both readers verified.

The vault is the import index. An id that cannot be canonicalized is refused.
Linear uses the issue UUID; Notion's page id survives a title or path change;
calendar ids hash the event UID and recurrence identity. Copies are found by
their stamps wherever they moved, in path order; additional copies are named.

The input frontmatter and body stay byte-exact. The writer inserts ordered
JSON-string stamps before the closing fence. Its hash covers those bytes with
volatile stamp values blank. Any other byte change counts as a person's edit;
re-import keeps that page. A reformat of a volatile stamp is unreadable rather
than an invitation to overwrite it. Timestamps and actors do not change an
otherwise identical import. Callers cannot provide a stamp from either family,
and imports cannot write reserved types, knowledge/ or sources/.

No runtime import table or staging queue is introduced. The existing batch
journal and undo mechanism own writes, replacement and recovery.

After an intentional edit, regenerate the digest through the ignored writer:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib import::tests::write_sources_digest -- --ignored --skip crash --skip killed_ --skip kill_and_restart --skip a_kill_ --skip kill_point --skip interrupted_overwrite
```

Then replay `import::`, the batch cases and both TypeScript readers. Never
reformat an existing artifact as a side effect of formatting source files.

The URL grammar is also data (`url_pattern`): HTTP(S), a DNS/IPv4-shaped
ASCII host (international hostnames use punycode), an optional port through
65535, and a path/query/fragment with no control or Unicode whitespace.
Credential-bearing URLs and bracketed IPv6 literals are refused. This narrow
source-link carrier covers the shipped import systems; supporting another
address shape requires shared cases before widening the grammar. Both readers
require the match to consume the entire string, including its final byte.

Composed frontmatter is parsed again before the writer returns bytes. A scalar
`null`, `~`, or an explicit YAML document-end marker cannot receive appended
stamps and refuses the entire batch.

Artifact version 2 adds `agent_guard` and the shared `stamp_guard` cases.
Each agent note write compares guarded key presence and YAML value before
and after its proposed change, under the file lock. Requoting and mapping
reordering preserve a value; custom tags, scalar types and explicit null
remain distinct. Recursive or malformed YAML carries no keys. The TS mock
compares YAML nodes so tags, large integers, mapping key types and NaN agree
with `serde_yaml::Value`. The cases exercise both interpreters.

Human edits remain free, and `stale_after` remains writable by agents.
`cache_source` and `write_concept` own their stamps and bypass the ordinary
note guard. Imported text registers as content-only, under `vault-import-v1`;
filing someone else's words never gives them the owner's authority.
