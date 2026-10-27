//! Closed M95.6 transient validation/policy for the private reservation kernel.
//! Transient types/limits also serve the fixed native harness; no authority mint.
#[cfg(test)]
pub(super) mod admission;
pub(crate) mod limits;
#[cfg(test)]
pub(super) mod result;
#[cfg(test)]
mod result_tests;
#[cfg(test)]
mod tests;
#[cfg(any(test, feature = "native-read-smoke"))]
pub(crate) mod types;

#[cfg(any(test, feature = "native-read-smoke"))]
pub(crate) mod freeze;
