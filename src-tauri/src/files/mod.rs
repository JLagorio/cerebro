//! Files that are not notes (M66): what a file is, and what the app may do
//! with it.
//!
//! `kinds` reads `shared/files/kinds.v1.json`, the one table that names each
//! extension's kind, MIME, viewer, extractor, ingest rule, Shiki language,
//! icon, bytes door and open policy. TypeScript reads the same bytes through
//! `src/engine/fileKinds.ts`; only Rust enforces the doors and the open
//! verdict (`kinds::open_policy`).

pub mod kinds;
