//! Fixed authenticated HTTPS transport. No URL/proxy/trust override inputs.
use super::*;
use reqwest::{header::{HeaderValue, AUTHORIZATION}, Client};
use std::time::Duration;

pub(super) struct NativeTransport;
struct AuthorizationBytes(Vec<u8>);
impl Drop for AuthorizationBytes { fn drop(&mut self) { self.0.fill(0); } }
fn client() -> Result<Client, ConnectionError> {
    Client::builder()
        .https_only(true).tls_backend_rustls().tls_version_min(reqwest::tls::Version::TLS_1_2)
        .http1_only().redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never())
        .no_proxy().referer(false).connection_verbose(false)
        .no_gzip().no_brotli().no_deflate().no_zstd()
        .pool_max_idle_per_host(0).pool_idle_timeout(Duration::ZERO)
        .connect_timeout(Duration::from_secs(5)).read_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(15)).build().map_err(|_| ConnectionError::Unavailable)
}
fn request(client: &Client, token: &SecretValue) -> Result<reqwest::Request, ConnectionError> {
    if token.expose().is_empty() || token.expose().len() > super::super::secrets::MAX_SECRET_BYTES {
        return Err(ConnectionError::Unavailable);
    }
    let mut bytes = AuthorizationBytes(Vec::with_capacity(7 + token.expose().len()));
    bytes.0.extend_from_slice(b"Bearer ");
    bytes.0.extend_from_slice(token.expose());
    let mut authorization = HeaderValue::from_bytes(&bytes.0).map_err(|_| ConnectionError::Unavailable)?;
    authorization.set_sensitive(true);
    client.get(ENDPOINT).header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28").header("User-Agent", "Cerebro")
        .header(AUTHORIZATION, authorization).build().map_err(|_| ConnectionError::Unavailable)
}
async fn fetch(token: &SecretValue) -> Result<IdentityResponse, ConnectionError> {
    let client = client()?;
    let mut response = client.execute(request(&client, token)?).await.map_err(|_| ConnectionError::Unavailable)?;
    if response.url().as_str() != ENDPOINT { return Err(ConnectionError::Unsupported); }
    let mut output = IdentityResponse { status: response.status().as_u16(), headers: Vec::new(), body: Vec::new() };
    // HTTP/1 parser allocation has a separate upstream 417792-byte default
    // cap; these are application retention limits, not preallocation claims.
    let mut header_bytes = 0usize;
    for (key, value) in response.headers() {
        header_bytes = header_bytes.checked_add(key.as_str().len())
            .and_then(|size| size.checked_add(value.len())).ok_or(ConnectionError::Unavailable)?;
        if output.headers.len() >= HEADER_COUNT || header_bytes > HEADER_LIMIT {
            return Err(ConnectionError::Unavailable);
        }
        output.headers.push((key.as_str().to_owned(), value.as_bytes().to_vec()));
    }
    // Refuse status/representation/unknown scope evidence before reading any
    // error body. Missing Content-Length is permitted under incremental caps.
    identity_headers(output.status, &output.headers)?;
    while let Some(chunk) = response.chunk().await.map_err(|_| ConnectionError::Unavailable)? {
        if chunk.len() > BODY_LIMIT - output.body.len() { return Err(ConnectionError::Unavailable); }
        output.body.extend_from_slice(&chunk);
    }
    Ok(output)
}

/// The native caller alone supplies the fixed deadline. Tests substitute only
/// a no-I/O future; no endpoint, token, timeout or backend selector crosses IPC.
/// Both futures stay owned by this stack until a terminal branch returns.
async fn await_owned<T>(
    operation: impl std::future::Future<Output = Result<T, ConnectionError>>,
    deadline: impl std::future::Future<Output = ()>,
    cancelled: &dyn Fn() -> bool,
) -> Result<T, ConnectionError> {
    if cancelled() { return Err(ConnectionError::Cancelled); }
    tokio::pin!(operation);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            biased;
            _ = &mut deadline => return Err(ConnectionError::Unavailable),
            _ = tokio::time::sleep(Duration::from_millis(25)) => {
                if cancelled() { return Err(ConnectionError::Cancelled); }
            }
            result = &mut operation => {
                // A cancellation arriving in the operation's last poll cannot
                // be converted into accepted identity evidence by this seam.
                if cancelled() { return Err(ConnectionError::Cancelled); }
                return result;
            }
        }
    }
}

impl IdentityTransport for NativeTransport {
    fn current_user(&self, token: &SecretValue, cancelled: &dyn Fn() -> bool) -> Result<IdentityResponse, ConnectionError> {
        if cancelled() { return Err(ConnectionError::Cancelled); }
        // Already on the retained owner's blocking worker. Reuse Tauri's
        // runtime; no application-spawned/detached request task or retry.
        tauri::async_runtime::block_on(async {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            await_owned(fetch(token), tokio::time::sleep_until(deadline), cancelled).await
        })
    }
}
#[cfg(test)]
#[path = "github_identity_native_tests.rs"]
mod tests;
