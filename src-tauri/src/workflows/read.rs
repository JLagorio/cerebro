//! Existing scoped query mechanics; native host supplies an admitted retained RunGrant.
use crate::{mcp::RunGrant, vault::corpus::CorpusCache};
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Error {
    Denied,
    Unavailable,
    InvalidQuery,
    OutputLimit,
}
pub(super) fn execute(
    cache: &CorpusCache,
    grant: &RunGrant,
    query: &str,
    zone: chrono_tz::Tz,
    today: chrono::NaiveDate,
) -> Result<String, Error> {
    if crate::mcp::ungranted_tool_refusal(grant, "query_records").is_some() {
        return Err(Error::Denied);
    }
    let vault = grant.vault.as_deref().ok_or(Error::Denied)?;
    let limits = super::definition::limits();
    // Parsing preserves the existing query_records contract. This adapter does
    // not add another query language or obtain a vault from caller query data.
    crate::actions::schema::workflow_parse_value(
        query,
        limits.step_output_bytes,
        limits.json_depth,
    )
    .map_err(|_| Error::InvalidQuery)?;
    let serde_json::Value::Object(args) =
        serde_json::from_str(query).map_err(|_| Error::InvalidQuery)?
    else {
        return Err(Error::InvalidQuery);
    };
    let answer = crate::mcp::scoped_query_records(cache, vault, &args, grant, zone, today)
        .map_err(|_| Error::Unavailable)?;
    if answer.len() > limits.step_output_bytes {
        return Err(Error::OutputLimit);
    }
    let encoded = serde_json::to_string(&answer).map_err(|_| Error::Unavailable)?;
    if encoded.len() > limits.step_output_bytes {
        return Err(Error::OutputLimit);
    }
    Ok(encoded)
}
