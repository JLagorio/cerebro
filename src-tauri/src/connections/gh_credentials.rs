//! Explicit native-only import seams. No production subprocess/provider is enabled yet.
use super::{secrets::SecretValue, ConnectionError, GhSelection};

/// A provider adapter supplies this only after its authenticated identity read.
pub(crate) struct ValidatedCredential {
    pub login: String,
    pub subject: String,
    pub issuer: String,
    pub scope_digest: String,
    pub secret: SecretValue,
}

pub(crate) struct GhTokenCommand {
    pub program: &'static str,
    pub args: Vec<String>,
    pub clear_environment: bool,
    pub environment: Vec<(&'static str, &'static str)>,
    pub timeout_ms: u64,
    pub output_limit: usize,
}
pub(crate) trait GhProcess {
    /// Native implementation must drain bounded output and kill/reap on timeout.
    fn capture_token(&self, command: &GhTokenCommand) -> Result<SecretValue, ConnectionError>;
}
pub(crate) struct ProviderIdentity {
    pub login: String,
    pub subject: String,
    pub issuer: String,
    pub scope_digest: String,
}
pub(crate) trait IdentityReader {
    /// Authenticated HTTPS identity read; no token in URL, logs, errors or DTOs.
    fn authenticated_identity(
        &self,
        token: &SecretValue,
    ) -> Result<ProviderIdentity, ConnectionError>;
}
pub(crate) fn acquire(
    selection: &GhSelection,
    process: &dyn GhProcess,
    identity: &dyn IdentityReader,
) -> Result<ValidatedCredential, ConnectionError> {
    super::account_metadata::validate_selection(selection)?;
    // env_clear is mandatory: no inherited token, host, config or debug overrides.
    let command = GhTokenCommand {
        program: "gh",
        args: [
            "auth",
            "token",
            "--hostname",
            "github.com",
            "--user",
            selection.login.as_str(),
            "--no-refresh",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
        clear_environment: true,
        environment: vec![
            ("GH_PROMPT_DISABLED", "1"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("NO_COLOR", "1"),
        ],
        timeout_ms: 15_000,
        output_limit: 16_384,
    };
    let secret = process.capture_token(&command)?;
    let observed = identity.authenticated_identity(&secret)?;
    if observed.login != selection.login
        || observed.issuer != "https://github.com"
        || observed.subject.is_empty()
        || !observed.subject.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(ConnectionError::IdentityMismatch);
    }
    Ok(ValidatedCredential {
        login: observed.login,
        subject: observed.subject,
        issuer: observed.issuer,
        scope_digest: observed.scope_digest,
        secret,
    })
}
