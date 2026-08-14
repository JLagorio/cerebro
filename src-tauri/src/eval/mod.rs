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
//!
//! ## The M27 slice (M27.9)
//!
//! Same rule, one milestone on: what is here is what NO module can assert
//! about itself, because it spans several. M27 is a pipeline — detect,
//! classify, edge, lane, gate, surface — and a chain with one silent link
//! passes every unit test in it. So these fixtures run whole journeys and
//! assert the ends.
//!
//! The M27 acceptance rows already asserted where the behaviour lives, named
//! so a reader can find them rather than assume they are missing:
//!
//! | Claim | Asserted in |
//! | --- | --- |
//! | stage lag / valid-time / revision separate a pair | `conflict::resolve`, `conflict::detect` |
//! | only the three unresolved outcomes open an edge | `ledger::schema::contradiction` |
//! | a semantic verdict is agent-supplied and evidence-linked | `ledger::schema::contradiction`, `policy::expand` |
//! | migrated declarations classify once; the pass is idempotent | `conflict::backfill` |
//! | four copies are one family; no lineage is `independence_unknown` | `dynamics::support` |
//! | authority is scoped to predicate and stage | `dynamics::support` |
//! | the Coverage fold and its boundary table | `dynamics::coverage` |
//! | the freshness boundary, and no clock inside the derivation | `dynamics::freshness`, `dynamics::schedule` |
//! | every lifecycle value; stale and contested together | `dynamics::validity` |
//! | ReviewStatus is separate from Support | `dynamics::review`, `dynamics::bundle` |
//! | multi-facet and unknown-facet derivation | `dynamics::facet` |
//! | circular / duplicated / descendant-only detection | `dynamics::hygiene` |
//! | every critical trigger and boundary case | `shared/policy/goldens-critical/`, both suites |
//! | preference knobs cannot suppress a protected lane | `attention::preferences` |
//! | self-ancestry refused at proposal apply | `policy::ancestry` |
//!
//! What M27.9 found by asking the cross-module questions: `dynamics::hygiene`
//! had NO caller. §78 and §80 say those findings are "detected and surfaced",
//! its own module doc said they feed the debt lane, and nothing called
//! `scan()` — so a base holding itself up by its own output was computed
//! about and never shown to anybody. Wiring it is part of this phase.

#![cfg(test)]

mod attention;
mod contradiction;
mod corroboration;
mod cost;
mod dynamics;
mod injection;
mod resolver;
