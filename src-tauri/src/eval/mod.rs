//! The M26 eval fixtures (M26.9b) — synthetic, and adversarial on purpose.
//!
//! **These are not unit tests of a module; they are the milestone's claims.**
//! Every fixture here is written to FAIL a plausible wrong implementation
//! rather than to pass the current one, and each says which wrong
//! implementation it is aimed at. A fixture that only passes is a fixture
//! that would keep passing after the rule was deleted.
//!
//! **Synthetic by construction.** Nothing here reads the demo vault or a real
//! ledger on disk: these are hand-built states and hand-built inputs, so a
//! corpus edit can never quietly change what the milestone claims.
//!
//! **Scope note, said plainly.** This covers the M26 acceptance claims that
//! were not already asserted where the behaviour lives. The ones that were
//! stay there, and are named here so a reader can find them rather than
//! assume they are missing:
//!
//! | Claim | Asserted in |
//! | --- | --- |
//! | manifest `included`/`exhausted`/`blocked` | `assembly::manifest`, `assembly::assemble` |
//! | omitted accessible counterevidence refuses | `assembly::assemble` |
//! | attended caps apply, daily budget never refuses | `assembly::manifest::Limits::ATTENDED` |
//! | direct / transitive / explicit-source self-ancestry | `policy::ancestry` |
//! | deterministic-zero vs combined-one-run routing | `ingest::driver`, `ingest::pass` |
//! | ambient output and failure gates | `runtime::budget`, `runtime::dispatch` |
//! | monotonic discovery lifecycle | `assembly::store` |
//! | `comparison_id` persists, no edge before M27 | `conformance/conflict.json` |
//!
//! Copying any of those here would mean two places to update and one of them
//! going stale — which is how an acceptance suite starts lying.

#![cfg(test)]

mod corroboration;
mod cost;
mod injection;
mod resolver;
