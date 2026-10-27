# Workflow format v1

Rust owns definition validation in `src-tauri/src/workflows/definition.rs`.
`format.v1.json` is its bounded definition/expression/output vocabulary.
No TypeScript validator or runtime is a second authority. Transport types will
be generated from the Rust contract when its native service is registered.

Definitions have an explicit entry, stable ordered step IDs and a DAG. Required
output references must precede the consumer in the list and dominate it on every
control-flow path. `exists` can inspect missing earlier output. There is no script
or shell expression. JSON parsing and supported schemas reuse the bounded
exact-decimal action schema implementation, including its JSON allocation caps.

Definition hashes are SHA-256 of the exact-decimal canonical definition without
`definitionHash`. Sealed JSON retains typed integer fields as integers; whitespace
and object-key order do not change semantic identity. Input schema digests use
the same canonicalization. A digest is identity, never a permission or grant.

New workflows remain disabled. These bounds are implementation defaults under
the owner's instruction to finish M93–M99; completed-body retention has not been
selected or enabled. Publication and runtime admission are separate operations.
