//! The unpacked-byte cap alone cannot bound repeated references to one value.
//! Readers charge retained strings and container overhead against this budget.
use super::{Block, Failure, Inline};

pub struct Budget {
    remaining: u64,
}
impl Budget {
    pub fn new(limit: u64) -> Self {
        Self { remaining: limit }
    }
    pub fn ensure(&self, bytes: u64) -> Result<(), Failure> {
        if bytes > self.remaining {
            Err(Failure::too_large(
                "the materialized document exceeds its memory limit",
            ))
        } else {
            Ok(())
        }
    }
    pub fn charge(&mut self, bytes: u64) -> Result<(), Failure> {
        self.ensure(bytes)?;
        self.remaining -= bytes;
        Ok(())
    }
    pub fn block(&mut self, block: &Block) -> Result<(), Failure> {
        self.charge(block_bytes(block))
    }
}
fn runs_bytes(runs: &[Inline]) -> u64 {
    runs.iter().fold(0_u64, |n, run| {
        n.saturating_add(64).saturating_add(match run {
            Inline::Text { text } => text.len() as u64,
            Inline::Link { text, url } => (text.len() as u64).saturating_add(url.len() as u64),
        })
    })
}
pub fn block_bytes(block: &Block) -> u64 {
    128_u64.saturating_add(match block {
        Block::Paragraph { runs } | Block::Heading { runs, .. } => runs_bytes(runs),
        Block::List { label, runs, .. } => (label.len() as u64).saturating_add(runs_bytes(runs)),
        Block::Picture { part, alt } => (part.len() as u64).saturating_add(alt.len() as u64),
        Block::Chart { name } => name.len() as u64,
        Block::Table { rows } => rows.iter().fold(0_u64, |n, row| {
            row.iter().fold(n.saturating_add(32), |n, cell| {
                n.saturating_add(64).saturating_add(cell.text.len() as u64)
            })
        }),
    })
}
