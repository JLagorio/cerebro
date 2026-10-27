# Run configuration contracts and safe V1 labels

Rust owns the contracts.v1.json schema bundle; root explicitly runs the ignored
exporter and the existing TypeScript contract generator. Metadata is descriptive,
never a permission grant, proof factory, credentials carrier or replay promise.

metadata-labels.v1.json is an immutable public display vocabulary for format1,
derived from the exact original compiled artifacts whose initial hashes it names.
It is not executable tool policy. Do not remove old labels when tools/presets or
permission policy change, and never compare historical recorded artifact digests
with current source hashes. Format1 reads use this preserved vocabulary, bounded
hash shapes and exact supported paths; capture additionally binds current compiled
facts. New unknown tool names can be captured hash-only. A future display format
may add another vocabulary while preserving this one for old captures. No body,
selector arguments, arbitrary model/actor/connector names or secret values belong
in this artifact. Its origin hashes describe its original derivation, not current
policy or an authorization decision.
