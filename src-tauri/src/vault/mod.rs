//! Files-first vault engine: parsing, scanning, writing, watching.

pub mod entry;
pub mod parse;
pub mod scan;
pub mod write;

#[cfg(test)]
pub mod testutil;
