//! Opaque wire identities, not grants or authority constructors.
use serde::{Deserialize, Serialize};

macro_rules! id {
    ($($name:ident),+ $(,)?) => {$(
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
        #[cfg_attr(test, derive(schemars::JsonSchema))]
        #[serde(transparent)]
        pub(crate) struct $name(pub(crate) String);
    )+};
}
id!(AccountId, ConnectionId, AttemptId);
