//! Fixed no-secret adapters for the opt-in native acquisition bridge profile.
//! No process, provider, Keychain or SecretValue constructor is reachable here.
use crate::connections::{
    gh_credentials::{GhProcess, GhTokenCommand, IdentityReader, ProviderIdentity},
    secrets::{SecretRef, SecretStore, SecretValue},
    ConnectionError,
};
use std::sync::{Arc, Mutex};

/// Counts only fixed adapter boundaries; no account owner or secret crosses it.
#[derive(Clone, Default)]
pub(crate) struct CredentialImportFixture(Arc<Mutex<[u32; 3]>>);
impl CredentialImportFixture {
    pub(crate) fn snapshot(&self) -> Result<[u32; 3], ConnectionError> {
        self.0
            .lock()
            .map(|value| *value)
            .map_err(|_| ConnectionError::Unavailable)
    }
    fn observed(&self, index: usize) -> Result<(), ConnectionError> {
        let mut calls = self.0.lock().map_err(|_| ConnectionError::Unavailable)?;
        calls[index] = calls[index]
            .checked_add(1)
            .ok_or(ConnectionError::Unavailable)?;
        Ok(())
    }
}
impl GhProcess for CredentialImportFixture {
    fn capture_token(&self, command: &GhTokenCommand) -> Result<SecretValue, ConnectionError> {
        self.observed(0)?;
        if command.program != "gh"
            || command.args
                != [
                    "auth",
                    "token",
                    "--hostname",
                    "github.com",
                    "--user",
                    "cerebro-import-fixture",
                    "--no-refresh",
                ]
            || !command.clear_environment
            || command.environment
                != [
                    ("GH_PROMPT_DISABLED", "1"),
                    ("GIT_TERMINAL_PROMPT", "0"),
                    ("NO_COLOR", "1"),
                ]
            || command.timeout_ms != 15_000
            || command.output_limit != 16_384
        {
            return Err(ConnectionError::InvalidSelection);
        }
        // Observe only the existing acquire command recipe. Never execute it
        // or construct bytes: the controlled failure precedes any credential.
        Err(ConnectionError::Unavailable)
    }
}
impl IdentityReader for CredentialImportFixture {
    fn authenticated_identity(&self, _: &SecretValue) -> Result<ProviderIdentity, ConnectionError> {
        self.observed(1)?;
        Err(ConnectionError::Unavailable)
    }
}
impl SecretStore for CredentialImportFixture {
    fn put(&self, _: &SecretRef, _: &SecretValue) -> Result<(), ConnectionError> {
        self.observed(2)?;
        Err(ConnectionError::Unavailable)
    }
    #[cfg(any(test, feature = "native-keychain-smoke", target_os = "macos"))]
    fn resolve(&self, _: &SecretRef) -> Result<SecretValue, ConnectionError> {
        self.observed(2)?;
        Err(ConnectionError::Unavailable)
    }
    fn delete(&self, _: &SecretRef) -> Result<(), ConnectionError> {
        self.observed(2)?;
        Err(ConnectionError::Unavailable)
    }
}

#[cfg(test)]
mod capture_contract_tests {
    use super::*;

    fn selected_no_refresh_command() -> GhTokenCommand {
        GhTokenCommand {
            program: "gh",
            args: [
                "auth",
                "token",
                "--hostname",
                "github.com",
                "--user",
                "cerebro-import-fixture",
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
        }
    }

    #[test]
    fn credential_fixture_capture_contract_has_three_counters() {
        let fixture = CredentialImportFixture::default();
        let calls = fixture.snapshot().unwrap();
        assert_eq!(
            calls.len(),
            3,
            "the receipt must contain only token capture, identity and store counters"
        );
        assert!(calls.iter().all(|calls| *calls == 0));
    }

    #[test]
    fn credential_fixture_capture_contract_accepts_exact_no_refresh_recipe() {
        let fixture = CredentialImportFixture::default();
        assert_eq!(
            fixture.capture_token(&selected_no_refresh_command()).err(),
            Some(ConnectionError::Unavailable),
            "the fixed capture should accept the safe recipe then stop before secret bytes"
        );
        assert_eq!(
            fixture.snapshot().unwrap().as_slice(),
            [1, 0, 0],
            "one selected capture; no provider identity or secret-store work"
        );
    }
}
