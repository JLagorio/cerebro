//! Fixed HTTPS transport for an already admitted, checked GitHub issue plan.
//! It owns its request future; it neither creates authority nor permits retry.
use super::{policy, IssueOutcome, IssuePlan};
use crate::connections::secrets::SecretValue;
use reqwest::{
    header::{
        HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE,
        TRANSFER_ENCODING,
    },
    Client,
};
use std::{future::Future, task::Poll, time::Duration};
#[derive(Debug, PartialEq, Eq)]
pub(in crate::actions) enum TransportOutcome {
    NotSubmitted,
    Observed(IssueOutcome),
}
struct AuthorizationBytes(Vec<u8>);
impl Drop for AuthorizationBytes {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}
fn client() -> Result<Client, ()> {
    let limits = &policy().transport;
    Client::builder()
        .https_only(true)
        .tls_backend_rustls()
        .tls_version_min(reqwest::tls::Version::TLS_1_2)
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .referer(false)
        .connection_verbose(false)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .pool_max_idle_per_host(0)
        .pool_idle_timeout(Duration::ZERO)
        .connect_timeout(Duration::from_secs(limits.connect_seconds))
        .read_timeout(Duration::from_secs(limits.read_seconds))
        .timeout(Duration::from_secs(limits.total_seconds))
        .build()
        .map_err(|_| ())
}
fn request(client: &Client, plan: &IssuePlan, token: &SecretValue) -> Result<reqwest::Request, ()> {
    let mut bytes = AuthorizationBytes(Vec::with_capacity(7 + token.expose().len()));
    bytes.0.extend_from_slice(b"Bearer ");
    bytes.0.extend_from_slice(token.expose());
    let mut authorization = HeaderValue::from_bytes(&bytes.0).map_err(|_| ())?;
    authorization.set_sensitive(true);
    let method = reqwest::Method::from_bytes(plan.method.as_bytes()).map_err(|_| ())?;
    let mut request = client
        .request(method, &plan.endpoint)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", &policy().api_version)
        .header("User-Agent", "Cerebro")
        .header(AUTHORIZATION, authorization);
    if let Some(body) = &plan.body {
        request = request
            .header(CONTENT_TYPE, "application/json")
            .body(body.clone());
    }
    request.build().map_err(|_| ())
}
struct Representation {
    content_type: String,
    length: Option<usize>,
}
enum Headers {
    NotApplied,
    Body(Representation),
}
fn single<'a>(headers: &'a HeaderMap, key: &str) -> Result<Option<&'a str>, ()> {
    let mut values = headers.get_all(key).iter();
    let first = values.next();
    if values.next().is_some() {
        return Err(());
    }
    first
        .map(|value| value.to_str().map_err(|_| ()))
        .transpose()
}
fn checked_headers(plan: &IssuePlan, status: u16, headers: &HeaderMap) -> Result<Headers, ()> {
    let mut count = 0usize;
    let mut bytes = 0usize;
    for (key, value) in headers {
        count = count.checked_add(1).ok_or(())?;
        bytes = bytes
            .checked_add(key.as_str().len())
            .and_then(|v| v.checked_add(value.len()))
            .ok_or(())?;
        if count > policy().transport.header_count || bytes > policy().transport.header_bytes {
            return Err(());
        }
    }
    // Critical ambiguity is refused even for a status-only rejection. Header
    // framing is separate from an error body's representation and contents.
    let content_type = single(headers, CONTENT_TYPE.as_str())?;
    let encoding = single(headers, CONTENT_ENCODING.as_str())?;
    let transfer = single(headers, TRANSFER_ENCODING.as_str())?;
    let length = single(headers, CONTENT_LENGTH.as_str())?
        .map(|value| {
            if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(());
            }
            value.parse::<usize>().map_err(|_| ())
        })
        .transpose()?;
    if transfer.is_some_and(|v| !v.eq_ignore_ascii_case("chunked"))
        || transfer.is_some() && length.is_some()
    {
        return Err(());
    }
    let operation = super::operation(&plan.definition).map_err(|_| ())?;
    if operation.not_applied_statuses.contains(&status) {
        return Ok(Headers::NotApplied);
    }
    if status != operation.success_status
        || encoding.is_some_and(|v| !v.eq_ignore_ascii_case("identity"))
        || length.is_some_and(|length| length > policy().response_bytes)
    {
        return Err(());
    }
    let content_type = content_type.ok_or(())?;
    if !content_type
        .split(';')
        .next()
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(());
    }
    Ok(Headers::Body(Representation {
        content_type: content_type.into(),
        length,
    }))
}
fn finish(
    plan: &IssuePlan,
    status: u16,
    representation: &Representation,
    body: &[u8],
) -> IssueOutcome {
    if body.len() > policy().response_bytes
        || representation
            .length
            .is_some_and(|expected| expected != body.len())
    {
        return IssueOutcome::Unknown;
    }
    super::response(plan, status, &representation.content_type, body)
}
#[cfg(test)]
fn checked_response(
    plan: &IssuePlan,
    status: u16,
    headers: &HeaderMap,
    body: &[u8],
) -> IssueOutcome {
    match checked_headers(plan, status, headers) {
        Ok(Headers::NotApplied) => IssueOutcome::NotApplied,
        Ok(Headers::Body(representation)) => finish(plan, status, &representation, body),
        Err(()) => IssueOutcome::Unknown,
    }
}
async fn fetch(client: Client, request: reqwest::Request, plan: &IssuePlan) -> IssueOutcome {
    let Ok(mut response) = client.execute(request).await else {
        return IssueOutcome::Unknown;
    };
    if response.url().as_str() != plan.endpoint {
        return IssueOutcome::Unknown;
    }
    let status = response.status().as_u16();
    let representation = match checked_headers(plan, status, response.headers()) {
        Ok(Headers::NotApplied) => return IssueOutcome::NotApplied,
        Ok(Headers::Body(representation)) => representation,
        Err(()) => return IssueOutcome::Unknown,
    };
    // Retention is incremental. Upstream HTTP/1 parser allocation has its own
    // separate cap; this application limit does not claim preallocation control.
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if chunk.len() > policy().response_bytes - body.len() {
                    return IssueOutcome::Unknown;
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return IssueOutcome::Unknown,
        }
    }
    finish(plan, status, &representation, &body)
}
async fn await_owned(
    operation: impl Future<Output = IssueOutcome>,
    deadline: impl Future<Output = ()>,
    cancelled: &dyn Fn() -> bool,
) -> TransportOutcome {
    if cancelled() {
        return TransportOutcome::NotSubmitted;
    }
    tokio::pin!(operation);
    tokio::pin!(deadline);
    // Do not poll a new network operation merely to discover an already elapsed
    // deadline. This also registers its wake before the first request poll.
    let elapsed =
        std::future::poll_fn(|cx| Poll::Ready(deadline.as_mut().poll(cx).is_ready())).await;
    if elapsed || cancelled() {
        return TransportOutcome::NotSubmitted;
    }
    loop {
        tokio::select! {
            biased;
            // A complete validated observation is a durable external fact.
            // Unlike identity admission, later cancellation cannot erase it.
            outcome=&mut operation=>return TransportOutcome::Observed(outcome),
            _=&mut deadline=>return TransportOutcome::Observed(IssueOutcome::Unknown),
            _=tokio::time::sleep(Duration::from_millis(policy().transport.cancellation_poll_millis))=>{
                if cancelled(){return TransportOutcome::Observed(IssueOutcome::Unknown);}
            }
        }
    }
}
/// Called only by the retained native dispatcher after its known committed
/// claim. Construction/invalid token refusal is proven not submitted. No caller
/// can choose an endpoint, headers, proxy, retry policy, deadline or runtime.
pub(in crate::actions) fn execute(
    plan: &IssuePlan,
    token: &SecretValue,
    cancelled: &dyn Fn() -> bool,
) -> TransportOutcome {
    if cancelled() {
        return TransportOutcome::NotSubmitted;
    }
    with_owned_runtime(|| async {
        if cancelled() {
            return TransportOutcome::NotSubmitted;
        }
        let Ok(client) = client() else {
            return TransportOutcome::NotSubmitted;
        };
        let Ok(request) = request(&client, plan, token) else {
            return TransportOutcome::NotSubmitted;
        };
        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(policy().transport.total_seconds);
        await_owned(
            fetch(client, request, plan),
            tokio::time::sleep_until(deadline),
            cancelled,
        )
        .await
    })
    .unwrap_or(TransportOutcome::NotSubmitted)
}
#[cfg(test)]
#[path = "github_issue_transport_tests.rs"]
mod tests;

// The retained blocking worker owns all request descendants through runtime
// shutdown. A request deadline is not a deadline for pretending cleanup ended:
// started blocking DNS must actually return before this function releases it.
fn with_owned_runtime<T, F: Future<Output = T>>(work: impl FnOnce() -> F) -> Result<T, ()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(policy().transport.blocking_threads)
        .build()
        .map_err(|_| ())?;
    let result = runtime.block_on(async { work().await });
    // No shutdown_timeout/background: Drop cancels owned async tasks and joins
    // the real blocking pool. Client construction happened inside this runtime.
    drop(runtime);
    Ok(result)
}

#[cfg(test)]
#[path = "github_issue_runtime_tests.rs"]
mod runtime_tests;
