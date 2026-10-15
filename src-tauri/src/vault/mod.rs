//! Files-first vault engine: parsing, scanning, writing, watching.

pub mod comments;
pub mod corpus;
pub mod entry;
pub mod link;
pub mod parse;
pub mod quote;
pub mod receipt;
pub mod scan;
pub mod trash;
pub mod watcher;
pub mod write;

#[cfg(test)]
pub mod testutil;
