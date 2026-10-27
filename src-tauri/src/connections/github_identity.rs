//! Authenticated native GitHub identity and classic-scope evidence only.
//! Raw headers/body never implement Debug/Clone/Serialize or cross IPC.
use super::{
    gh_credentials::{IdentityReader, ProviderIdentity},
    secrets::SecretValue,
    ConnectionError,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const ENDPOINT: &str = "https://api.github.com/user";
const BODY_LIMIT: usize = 65_536;
const HEADER_LIMIT: usize = 16_384;
const HEADER_COUNT: usize = 64;
const SCOPE_BYTES: usize = 4096;
const SCOPE_COUNT: usize = 64;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScopePolicy {
    version: u32,
    provider: String,
    evidence_header: String,
    evidence_model: String,
    supported_scopes: Vec<String>,
    unsupported: String,
    scope_digest_domain: String,
    issuer: String,
    beta_limitation: String,
}
const SCOPE_POLICY: &str = include_str!("../../../shared/policy/github-import.v1.json");
fn scope_policy() -> Result<ScopePolicy, ConnectionError> {
    let policy: ScopePolicy =
        serde_json::from_str(SCOPE_POLICY).map_err(|_| ConnectionError::Unavailable)?;
    if policy.version != 1
        || policy.provider != "github"
        || policy.evidence_model != "classic_oauth_scope_header"
        || policy.evidence_header != "x-oauth-scopes"
        || policy.unsupported != "unsupported"
        || policy.scope_digest_domain.is_empty()
        || policy.issuer != "https://github.com"
        || policy.beta_limitation.is_empty()
        || policy.supported_scopes.is_empty()
        || policy
            .supported_scopes
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        || policy.supported_scopes.iter().any(|name| {
            name.is_empty()
                || name.len() > 64
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || matches!(byte, b':' | b'_'))
        })
    {
        return Err(ConnectionError::Unavailable);
    }
    Ok(policy)
}

struct IdentityResponse {
    status: u16,
    headers: Vec<(String, Vec<u8>)>,
    body: Vec<u8>,
}
impl Drop for IdentityResponse {
    fn drop(&mut self) {
        for (_, value) in &mut self.headers {
            value.fill(0);
        }
        self.body.fill(0);
    }
}
fn one_header<'a>(
    headers: &'a [(String, Vec<u8>)],
    name: &str,
) -> Result<Option<&'a [u8]>, ConnectionError> {
    let mut found = None;
    for (key, value) in headers {
        if key.eq_ignore_ascii_case(name) {
            if found.is_some() {
                return Err(ConnectionError::Unsupported);
            }
            found = Some(value.as_slice());
        }
    }
    Ok(found)
}
fn scope_digest(raw: &[u8]) -> Result<String, ConnectionError> {
    if raw.is_empty() || raw.len() > SCOPE_BYTES {
        return Err(ConnectionError::Unsupported);
    }
    let policy = scope_policy()?;
    let text = std::str::from_utf8(raw).map_err(|_| ConnectionError::Unsupported)?;
    let mut scopes = BTreeSet::new();
    for (count, value) in text.split(',').enumerate() {
        let value = value.trim_matches([' ', '\t']);
        if count >= SCOPE_COUNT
            || value.len() > 64
            || !policy.supported_scopes.iter().any(|name| name == value)
        {
            return Err(ConnectionError::Unsupported);
        }
        scopes.insert(value);
    }
    let canonical = serde_json::to_vec(&(&policy.scope_digest_domain, &policy.issuer, scopes))
        .map_err(|_| ConnectionError::Unavailable)?;
    Ok(format!("{:x}", Sha256::digest(canonical)))
}
#[derive(serde::Deserialize)]
struct UserIdentity {
    login: String,
    id: u64,
}
fn identity_headers(status: u16, headers: &[(String, Vec<u8>)]) -> Result<String, ConnectionError> {
    if headers.len() > HEADER_COUNT {
        return Err(ConnectionError::Unavailable);
    }
    let mut total = 0usize;
    for (key, value) in headers {
        total = total
            .checked_add(key.len())
            .and_then(|n| n.checked_add(value.len()))
            .ok_or(ConnectionError::Unavailable)?;
        if total > HEADER_LIMIT {
            return Err(ConnectionError::Unavailable);
        }
    }
    match status {
        200 => {}
        401 => return Err(ConnectionError::SignInRequired),
        300..=399 => return Err(ConnectionError::Unsupported),
        _ => return Err(ConnectionError::Unavailable),
    }
    let content_type = one_header(headers, "content-type")?
        .and_then(|value| std::str::from_utf8(value).ok())
        .ok_or(ConnectionError::Unsupported)?;
    if !content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(ConnectionError::Unsupported);
    }
    if one_header(headers, "content-encoding")?.is_some_and(|value| value != b"identity") {
        return Err(ConnectionError::Unsupported);
    }
    if let Some(length) = one_header(headers, "content-length")? {
        let length = std::str::from_utf8(length)
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|length| *length <= BODY_LIMIT)
            .ok_or(ConnectionError::Unavailable)?;
        let _ = length;
    }
    let scopes = one_header(headers, "x-oauth-scopes")?.ok_or(ConnectionError::Unsupported)?;
    scope_digest(scopes)
}
fn read_identity(response: IdentityResponse) -> Result<ProviderIdentity, ConnectionError> {
    if response.body.len() > BODY_LIMIT {
        return Err(ConnectionError::Unavailable);
    }
    let digest = identity_headers(response.status, &response.headers)?;
    if let Some(length) = one_header(&response.headers, "content-length")? {
        let length = std::str::from_utf8(length)
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .ok_or(ConnectionError::Unavailable)?;
        if length != response.body.len() {
            return Err(ConnectionError::Unavailable);
        }
    }
    // Serde's struct visitor rejects duplicate login/id, nonintegral or
    // out-of-range ids and trailing data. Other bounded user fields are ignored.
    let user: UserIdentity =
        serde_json::from_slice(&response.body).map_err(|_| ConnectionError::IdentityMismatch)?;
    super::account_metadata::validate_account_login("github.com", &user.login)
        .map_err(|_| ConnectionError::IdentityMismatch)?;
    if user.id == 0 {
        return Err(ConnectionError::IdentityMismatch);
    }
    Ok(ProviderIdentity {
        login: user.login,
        subject: user.id.to_string(),
        issuer: "https://github.com".into(),
        scope_digest: digest,
    })
}
trait IdentityTransport {
    fn current_user(
        &self,
        token: &SecretValue,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<IdentityResponse, ConnectionError>;
}
struct GithubIdentityReader<T> {
    transport: T,
    cancelled: Box<dyn Fn() -> bool + Send>,
}
impl<T: IdentityTransport> IdentityReader for GithubIdentityReader<T> {
    fn authenticated_identity(
        &self,
        token: &SecretValue,
    ) -> Result<ProviderIdentity, ConnectionError> {
        if (self.cancelled)() {
            return Err(ConnectionError::Cancelled);
        }
        let response = self
            .transport
            .current_user(token, self.cancelled.as_ref())?;
        if (self.cancelled)() {
            return Err(ConnectionError::Cancelled);
        }
        let identity = read_identity(response)?;
        if (self.cancelled)() {
            return Err(ConnectionError::Cancelled);
        }
        Ok(identity)
    }
}
#[cfg(target_os = "macos")]
#[path = "github_identity_native.rs"]
mod native;
#[cfg(target_os = "macos")]
#[cfg_attr(
    test,
    expect(
        dead_code,
        reason = "its one caller, native_credential_bundle::run, takes the injected fixture instead under test"
    )
)]
pub(crate) fn native_reader(
    cancelled: impl Fn() -> bool + Send + 'static,
) -> Box<dyn IdentityReader + Send> {
    Box::new(GithubIdentityReader {
        transport: native::NativeTransport,
        cancelled: Box::new(cancelled),
    })
}
#[cfg(test)]
#[path = "github_identity_tests.rs"]
mod tests;
