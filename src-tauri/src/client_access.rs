//! Other apps reach this vault through personal tokens (M62.5).
//!
//! The commands return safe metadata, except for the once-only create
//! response. Token secrets never enter app state, a log or the database.

use std::path::Path;

pub(crate) mod listener;
pub use listener::{connector_config, shut_down, vault_opened, vault_opening};

use crate::runtime::{
    self,
    client_tokens::{self, ClientToken, ClientTokenRequest, CreatedClientToken},
};

/// Actor spelling shared with the surfaces; the raw id remains attribution.
pub const CLIENT_ACTOR_PREFIX: &str = "client:";

#[tauri::command(async)]
pub fn client_tokens(vault: String) -> Result<Vec<ClientToken>, String> {
    let current = runtime::scope::derive_vault_id(Path::new(&vault));
    runtime::sink::with_sink(|conn| client_tokens::list(conn, Some(&current)))
        .unwrap_or_else(|| Err(client_tokens::UNAVAILABLE.into()))
}

#[tauri::command(async)]
pub fn create_client_token(
    vault: String,
    request: ClientTokenRequest,
) -> Result<CreatedClientToken, String> {
    let created = runtime::sink::with_sink(|conn| {
        let vault_id = runtime::scope::register(conn, Path::new(&vault))?;
        client_tokens::create(conn, &vault_id, &request, &runtime::now_utc())
    })
    .unwrap_or_else(|| Err(client_tokens::UNAVAILABLE.into()))?;
    listener::token_created();
    Ok(created)
}

#[tauri::command(async)]
pub fn revoke_client_token(token_id: String) -> Result<bool, String> {
    let result = runtime::sink::with_sink(|conn| client_tokens::revoke(conn, &token_id))
        .unwrap_or_else(|| Err(client_tokens::UNAVAILABLE.into()));
    listener::token_revoked(&token_id, result.is_ok());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_commands_fail_in_words_without_a_runtime_database() {
        let _guard = runtime::sink::test_lock();
        runtime::sink::disarm();
        assert_eq!(
            client_tokens("/no/vault".into()).unwrap_err(),
            client_tokens::UNAVAILABLE
        );
        assert_eq!(
            revoke_client_token("none".into()).unwrap_err(),
            client_tokens::UNAVAILABLE
        );
        assert_eq!(
            create_client_token(
                "/no/vault".into(),
                ClientTokenRequest {
                    name: "Test".into(),
                    toolsets: vec!["read".into()],
                    write_scope: vec![],
                    read_scope: None,
                }
            )
            .unwrap_err(),
            client_tokens::UNAVAILABLE
        );
    }
}
