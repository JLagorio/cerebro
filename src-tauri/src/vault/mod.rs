//! Files-first vault engine: parsing, scanning, writing, watching.

pub mod batch;
pub mod comments;
pub mod corpus;
pub mod dates;
pub mod entry;
pub mod link;
pub mod parse;
pub mod quote;
pub mod receipt;
pub mod scan;
pub mod schema;
pub mod set_fields;
pub mod trash;
pub mod watcher;
pub mod write;

#[cfg(test)]
pub mod testutil;
