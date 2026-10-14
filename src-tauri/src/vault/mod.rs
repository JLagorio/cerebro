//! Files-first vault engine: parsing, scanning, writing, watching.

pub mod comments;
pub mod entry;
pub mod link;
pub mod parse;
pub mod quote;
pub mod scan;
pub mod watcher;
pub mod write;

#[cfg(test)]
pub mod testutil;
