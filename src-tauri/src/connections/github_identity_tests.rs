use super::*;
fn response(scopes: Option<&[u8]>, body: &[u8]) -> IdentityResponse {
    let mut headers = vec![(
        "content-type".into(),
        b"application/json; charset=utf-8".to_vec(),
    )];
    if let Some(scopes) = scopes {
        headers.push(("x-oauth-scopes".into(), scopes.to_vec()));
    }
    IdentityResponse {
        status: 200,
        headers,
        body: body.to_vec(),
    }
}
const USER: &[u8] = br#"{"login":"alice","id":12345678901234567,"other":{"ignored":true}}"#;
#[test]
fn authenticated_classic_evidence_preserves_exact_integer_subject_and_fixed_issuer() {
    let identity = read_identity(response(Some(b"repo, read:org"), USER)).unwrap();
    assert_eq!(identity.login, "alice");
    assert_eq!(identity.subject, "12345678901234567");
    assert_eq!(identity.issuer, "https://github.com");
    assert_eq!(identity.scope_digest.len(), 64);
}
#[test]
fn classic_scope_order_and_duplicates_do_not_change_binding_digest() {
    let first = read_identity(response(Some(b"repo, read:org, repo"), USER)).unwrap();
    let second = read_identity(response(Some(b"read:org,repo"), USER)).unwrap();
    let changed = read_identity(response(Some(b"repo"), USER)).unwrap();
    assert_eq!(first.scope_digest, second.scope_digest);
    assert_ne!(first.scope_digest, changed.scope_digest);
}
#[test]
fn missing_empty_duplicate_or_unknown_scope_evidence_never_implies_access() {
    for scopes in [
        None,
        Some(b"".as_slice()),
        Some(b"invented:full_access".as_slice()),
        Some(b"repo,,read:org".as_slice()),
        Some(b"REPO".as_slice()),
    ] {
        assert_eq!(
            read_identity(response(scopes, USER)).err(),
            Some(ConnectionError::Unsupported)
        );
    }
    let mut duplicate = response(Some(b"repo"), USER);
    duplicate
        .headers
        .push(("X-OAuth-Scopes".into(), b"repo".to_vec()));
    assert_eq!(
        read_identity(duplicate).err(),
        Some(ConnectionError::Unsupported)
    );
}
#[test]
fn authoritative_identity_fields_reject_duplicates_float_zero_and_invalid_login() {
    for body in [
        br#"{"login":"alice","login":"bob","id":1}"#.as_slice(),
        br#"{"login":"alice","id":1,"id":2}"#.as_slice(),
        br#"{"login":"alice","id":1.5}"#.as_slice(),
        br#"{"login":"alice","id":0}"#.as_slice(),
        br#"{"login":"--bad","id":1}"#.as_slice(),
    ] {
        assert_eq!(
            read_identity(response(Some(b"repo"), body)).err(),
            Some(ConnectionError::IdentityMismatch)
        );
    }
}
#[test]
fn redirect_and_unauthenticated_status_never_parse_identity() {
    for (status, expected) in [
        (301, ConnectionError::Unsupported),
        (401, ConnectionError::SignInRequired),
        (403, ConnectionError::Unavailable),
        (429, ConnectionError::Unavailable),
        (503, ConnectionError::Unavailable),
    ] {
        let mut input = response(Some(b"repo"), USER);
        input.status = status;
        assert_eq!(read_identity(input).err(), Some(expected));
    }
}
#[test]
fn compressed_or_non_json_identity_is_unsupported() {
    let mut compressed = response(Some(b"repo"), USER);
    compressed
        .headers
        .push(("content-encoding".into(), b"gzip".to_vec()));
    assert_eq!(
        read_identity(compressed).err(),
        Some(ConnectionError::Unsupported)
    );
    let mut html = response(Some(b"repo"), USER);
    html.headers[0].1 = b"text/html".to_vec();
    assert_eq!(
        read_identity(html).err(),
        Some(ConnectionError::Unsupported)
    );
}
#[test]
fn oversized_body_and_headers_refuse_without_success_or_echo() {
    let input = response(Some(b"repo"), &vec![b' '; 65537]);
    assert_eq!(
        read_identity(input).err(),
        Some(ConnectionError::Unavailable)
    );
    let mut input = response(Some(b"repo"), USER);
    input
        .headers
        .push(("x-reflected".into(), vec![b'x'; 16385]));
    let error = read_identity(input).err().unwrap();
    assert_eq!(error, ConnectionError::Unavailable);
    assert_eq!(serde_json::to_string(&error).unwrap(), "\"unavailable\"");
}

#[test]
fn declared_length_and_header_count_are_checked_independently_of_body() {
    let mut input = response(Some(b"repo"), USER);
    input
        .headers
        .push(("content-length".into(), b"65537".to_vec()));
    assert_eq!(
        read_identity(input).err(),
        Some(ConnectionError::Unavailable)
    );
    let mut input = response(Some(b"repo"), USER);
    input.headers.push(("content-length".into(), b"1".to_vec()));
    assert_eq!(
        read_identity(input).err(),
        Some(ConnectionError::Unavailable)
    );
    let mut input = response(Some(b"repo"), USER);
    for n in 0..64 {
        input.headers.push((format!("x-{n}"), Vec::new()));
    }
    assert_eq!(
        read_identity(input).err(),
        Some(ConnectionError::Unavailable)
    );
}
#[test]
fn cancelled_reader_never_sends_or_accepts_a_completed_transport_response() {
    // These closures are native test state; no transport/request is started.
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    struct Never(std::sync::Arc<std::sync::atomic::AtomicUsize>);
    impl IdentityTransport for Never {
        fn current_user(
            &self,
            _: &SecretValue,
            _: &dyn Fn() -> bool,
        ) -> Result<IdentityResponse, ConnectionError> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(response(Some(b"repo"), USER))
        }
    }
    let reader = GithubIdentityReader {
        transport: Never(calls.clone()),
        cancelled: Box::new(|| true),
    };
    let token = SecretValue::from_bytes(b"sentinel-secret".to_vec()).unwrap();
    assert_eq!(
        reader.authenticated_identity(&token).err(),
        Some(ConnectionError::Cancelled)
    );
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    struct Late(std::sync::Arc<std::sync::atomic::AtomicBool>);
    impl IdentityTransport for Late {
        fn current_user(
            &self,
            _: &SecretValue,
            _: &dyn Fn() -> bool,
        ) -> Result<IdentityResponse, ConnectionError> {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(response(Some(b"repo"), USER))
        }
    }
    let flag = cancelled.clone();
    let reader = GithubIdentityReader {
        transport: Late(cancelled),
        cancelled: Box::new(move || flag.load(std::sync::atomic::Ordering::SeqCst)),
    };
    assert_eq!(
        reader.authenticated_identity(&token).err(),
        Some(ConnectionError::Cancelled)
    );
}

#[test]
fn compiled_import_policy_matches_disk_and_digest_anchor() {
    let expected = include_str!("../../../shared/policy/github-import.v1.sha256").trim();
    assert_eq!(
        format!("{:x}", Sha256::digest(SCOPE_POLICY.as_bytes())),
        expected
    );
    assert_eq!(
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../shared/policy/github-import.v1.json")
        )
        .unwrap(),
        SCOPE_POLICY
    );
    assert!(scope_policy().is_ok());
}
#[test]
#[ignore = "explicit digest regeneration after reviewed GitHub import policy changes"]
fn write_github_import_digest() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../shared/policy");
    let bytes = std::fs::read(root.join("github-import.v1.json")).unwrap();
    assert_eq!(
        bytes,
        SCOPE_POLICY.as_bytes(),
        "rebuild before regenerating the compiled artifact anchor"
    );
    std::fs::write(
        root.join("github-import.v1.sha256"),
        format!("{:x}\n", Sha256::digest(bytes)),
    )
    .unwrap();
}
