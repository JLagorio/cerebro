//! JSON Canvas format, lossless codecs and bounded agent reads (M68.2, M68.7).
pub mod agent_limits;
pub mod answer;
pub mod format;
pub mod read;
pub mod write;
#[cfg(test)]
mod answer_tests;
