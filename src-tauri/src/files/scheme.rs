//! Image and media requests only. The custom scheme is never a navigation door.
use super::{
    bytes::{self, Refusal},
    kinds,
};
use std::io::{Read, Seek, SeekFrom};
use tauri::http::{Request, Response, StatusCode};

/// Decode segments individually so an encoded slash cannot change the address.
pub fn address(uri: &tauri::http::Uri) -> Result<(String, String), Refusal> {
    let rules = bytes::rules();
    if uri.scheme_str() != Some(rules.scheme.as_str())
        || uri.authority().map(|a| a.as_str()) != Some(rules.host.as_str())
    {
        return Err(bytes::refusal("bad_address"));
    }
    // WebKit reuses a decoded image at an identical root-0 URL across vault
    // switches, even with no-store. A bounded opaque revision changes only its
    // cache key; it never selects a root or grants access to another file.
    if let Some(query) = uri.query() {
        let Some((key, value)) = query.split_once('=') else {
            return Err(bytes::refusal("bad_address"));
        };
        if key != rules.revision_key
            || value.is_empty()
            || value.len() > rules.limits.revision_bytes
            || !value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err(bytes::refusal("bad_address"));
        }
    }
    let mut parts = Vec::new();
    for segment in uri
        .path()
        .strip_prefix('/')
        .ok_or_else(|| bytes::refusal("bad_address"))?
        .split('/')
    {
        // percent_decode accepts malformed escapes literally; addresses don't.
        let raw = segment.as_bytes();
        for (index, byte) in raw.iter().enumerate() {
            if *byte == b'%'
                && !(raw.get(index + 1).is_some_and(u8::is_ascii_hexdigit)
                    && raw.get(index + 2).is_some_and(u8::is_ascii_hexdigit))
            {
                return Err(bytes::refusal("bad_address"));
            }
        }
        let part = percent_encoding::percent_decode_str(segment)
            .decode_utf8()
            .map_err(|_| bytes::refusal("bad_address"))?
            .into_owned();
        if part.contains('/') {
            return Err(bytes::refusal("bad_address"));
        }
        parts.push(part);
    }
    if parts.len() < 2 {
        return Err(bytes::refusal("bad_address"));
    }
    let root = parts.remove(0);
    let rel = parts.join("/");
    if let Some(error) = bytes::rel_refusal(&root, &rel) {
        return Err(error);
    }
    Ok((root, rel))
}

fn response(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(body)
        .expect("static response headers")
}

#[derive(Debug, PartialEq, Eq)]
enum Range {
    Full,
    Part(u64, u64),
    Unsatisfiable,
}
fn range(value: Option<&str>, size: u64) -> Range {
    let Some(value) = value.and_then(|value| value.strip_prefix("bytes=")) else {
        return Range::Full;
    };
    if value.contains(',') {
        return Range::Unsatisfiable;
    }
    let Some((left, right)) = value.split_once('-') else {
        return Range::Full;
    };
    let start;
    let end;
    if left.is_empty() {
        let Ok(suffix) = right.parse::<u64>() else {
            return Range::Full;
        };
        if suffix == 0 || size == 0 {
            return Range::Unsatisfiable;
        }
        start = size.saturating_sub(suffix);
        end = size - 1;
    } else {
        let Ok(from) = left.parse::<u64>() else {
            return Range::Full;
        };
        start = from;
        end = if right.is_empty() {
            size.saturating_sub(1)
        } else {
            let Ok(to) = right.parse::<u64>() else {
                return Range::Full;
            };
            to.min(size.saturating_sub(1))
        };
        if size == 0 || start >= size || end < start {
            return Range::Unsatisfiable;
        }
    }
    Range::Part(
        start,
        end.min(start.saturating_add(bytes::rules().limits.range_bytes - 1)),
    )
}

/// Pure protocol behavior; the only I/O authority comes from the resolver.
pub fn serve(
    request: Request<Vec<u8>>,
    resolve: impl FnOnce(&str, &str) -> Result<bytes::OpenedFile, Refusal>,
) -> Response<Vec<u8>> {
    let empty = |status| response(status, "application/octet-stream", Vec::new());
    if request.method() != "GET" && request.method() != "HEAD" {
        let mut out = empty(StatusCode::METHOD_NOT_ALLOWED);
        out.headers_mut()
            .insert("Allow", "GET, HEAD".parse().expect("static header"));
        return out;
    }
    let Ok((root, rel)) = address(request.uri()) else {
        return empty(StatusCode::FORBIDDEN);
    };
    let bytes::OpenedFile { path, mut file, .. } = match resolve(&root, &rel) {
        Ok(path) => path,
        Err(error) => {
            return empty(
                if ["not_found", "folder", "no_such_root"].contains(&error.code.as_str()) {
                    StatusCode::NOT_FOUND
                } else {
                    StatusCode::FORBIDDEN
                },
            )
        }
    };
    let row = kinds::lookup(&path.to_string_lossy());
    if row.bytes != kinds::Door::Scheme {
        return response(StatusCode::FORBIDDEN, &row.mime, Vec::new());
    }
    let Ok(meta) = file.metadata() else {
        return empty(StatusCode::NOT_FOUND);
    };
    if !meta.is_file() {
        return empty(StatusCode::NOT_FOUND);
    }
    let size = meta.len();
    let selection = range(
        request.headers().get("Range").and_then(|v| v.to_str().ok()),
        size,
    );
    let (status, start, length) = match selection {
        Range::Unsatisfiable => {
            let mut out = response(StatusCode::RANGE_NOT_SATISFIABLE, &row.mime, Vec::new());
            out.headers_mut().insert(
                "Content-Range",
                format!("bytes */{size}").parse().expect("range header"),
            );
            return out;
        }
        Range::Full if size > bytes::rules().limits.body_bytes => {
            return response(StatusCode::PAYLOAD_TOO_LARGE, &row.mime, Vec::new())
        }
        Range::Full => (StatusCode::OK, 0, size),
        Range::Part(start, end) => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
    };
    let mut body = Vec::new();
    if request.method() != "HEAD"
        && (file.seek(SeekFrom::Start(start)).is_err()
            || file.take(length).read_to_end(&mut body).is_err()
            || body.len() as u64 != length)
    {
        return empty(StatusCode::NOT_FOUND);
    }
    let mut out = response(status, &row.mime, body);
    out.headers_mut().insert(
        "Content-Length",
        length.to_string().parse().expect("length header"),
    );
    if status == StatusCode::PARTIAL_CONTENT {
        out.headers_mut().insert(
            "Content-Range",
            format!("bytes {start}-{}/{size}", start + length - 1)
                .parse()
                .expect("range header"),
        );
    }
    out
}

pub fn handle(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    if context.webview_label() != "main" {
        responder.respond(response(
            StatusCode::FORBIDDEN,
            "application/octet-stream",
            Vec::new(),
        ));
        return;
    }
    let config = crate::app_config::app_dir(context.app_handle());
    tauri::async_runtime::spawn_blocking(move || {
        responder.respond(serve(request, |root, rel| {
            let config = config.map_err(|_| bytes::refusal("no_such_root"))?;
            bytes::locate(&config, root, rel)
        }));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;
    use std::fs::File;

    #[test]
    fn a_revision_changes_the_cache_key_never_the_file_authority() {
        for query in ["v=a-2_b", "v=99"] {
            assert_eq!(
                address(
                    &format!("cerebro-file://localhost/0/a.png?{query}")
                        .parse()
                        .unwrap()
                )
                .unwrap(),
                ("0".into(), "a.png".into())
            );
        }
        for query in [
            "v=",
            "v=..",
            "v=/etc/hosts",
            "v=a&root=elsewhere",
            "root=/vault",
            "v=a&v=b",
            "v=%61",
        ] {
            assert!(address(
                &format!("cerebro-file://localhost/0/a.png?{query}")
                    .parse()
                    .unwrap()
            )
            .is_err());
        }
        assert!(address(
            &format!(
                "cerebro-file://localhost/0/a.png?v={}",
                "a".repeat(bytes::rules().limits.revision_bytes + 1)
            )
            .parse()
            .unwrap()
        )
        .is_err());
    }

    #[test]
    fn serves_a_png_with_its_mime_nosniff_and_no_store() {
        let dir = testutil::temp_vault("scheme-png");
        std::fs::write(dir.join("a.png"), [137, 80, 78, 71, 0]).unwrap();
        let request = Request::builder()
            .uri("cerebro-file://localhost/0/a.png")
            .body(vec![])
            .unwrap();
        let out = serve(request, |id, rel| bytes::open_in(&dir, id, rel));
        assert_eq!(out.status(), StatusCode::OK);
        assert_eq!(out.body(), &[137, 80, 78, 71, 0]);
        assert_eq!(out.headers()["Content-Type"], "image/png");
        assert_eq!(out.headers()["X-Content-Type-Options"], "nosniff");
        assert_eq!(out.headers()["Cache-Control"], "no-store");
        assert_eq!(out.headers()["Accept-Ranges"], "bytes");
        assert!(!out.headers().contains_key("Access-Control-Allow-Origin"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn serves_ranges_heads_caps_and_refusals() {
        let dir = testutil::temp_vault("scheme-range");
        std::fs::write(
            dir.join("a.m4a"),
            (0..1000).map(|n| (n % 256) as u8).collect::<Vec<_>>(),
        )
        .unwrap();
        for (header, status, content_range, length) in [
            ("bytes=0-", 206, Some("bytes 0-999/1000"), 1000),
            ("bytes=0-99", 206, Some("bytes 0-99/1000"), 100),
            ("bytes=900-", 206, Some("bytes 900-999/1000"), 100),
            ("bytes=-100", 206, Some("bytes 900-999/1000"), 100),
            ("bytes=-5000", 206, Some("bytes 0-999/1000"), 1000),
            ("bytes=0-5000", 206, Some("bytes 0-999/1000"), 1000),
            ("bytes=1000-", 416, Some("bytes */1000"), 0),
            ("bytes=5-1", 416, Some("bytes */1000"), 0),
            ("bytes=0-1,5-6", 416, Some("bytes */1000"), 0),
            ("bytes=-0", 416, Some("bytes */1000"), 0),
            ("items=0-1", 200, None, 1000),
            ("bytes=abc", 200, None, 1000),
        ] {
            for method in ["GET", "HEAD"] {
                let request = Request::builder()
                    .method(method)
                    .uri("cerebro-file://localhost/0/a.m4a")
                    .header("Range", header)
                    .body(vec![])
                    .unwrap();
                let out = serve(request, |id, rel| bytes::open_in(&dir, id, rel));
                assert_eq!(out.status().as_u16(), status, "{header}");
                assert_eq!(
                    out.headers()
                        .get("Content-Range")
                        .map(|v| v.to_str().unwrap()),
                    content_range,
                    "{header}"
                );
                assert_eq!(
                    out.body().len(),
                    if method == "HEAD" { 0 } else { length },
                    "{header}"
                );
            }
        }
        File::create(dir.join("huge.mp4"))
            .unwrap()
            .set_len(bytes::rules().limits.body_bytes + 1)
            .unwrap();
        let request = Request::builder()
            .uri("cerebro-file://localhost/0/huge.mp4")
            .body(vec![])
            .unwrap();
        assert_eq!(
            serve(request, |id, rel| bytes::open_in(&dir, id, rel)).status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let request = Request::builder()
            .uri("cerebro-file://localhost/0/huge.mp4")
            .header("Range", "bytes=0-")
            .body(vec![])
            .unwrap();
        let out = serve(request, |id, rel| bytes::open_in(&dir, id, rel));
        assert_eq!(out.body().len() as u64, bytes::rules().limits.range_bytes);
        assert_eq!(out.status(), StatusCode::PARTIAL_CONTENT);
        for (method, path, status) in [
            ("POST", "a.m4a", 405),
            ("GET", "missing.png", 404),
            ("GET", "folder.png", 404),
            ("GET", "a.pdf", 403),
        ] {
            std::fs::create_dir_all(dir.join("folder.png")).unwrap();
            std::fs::write(dir.join("a.pdf"), b"%PDF-").unwrap();
            let request = Request::builder()
                .method(method)
                .uri(format!("cerebro-file://localhost/0/{path}"))
                .body(vec![])
                .unwrap();
            assert_eq!(
                serve(request, |id, rel| bytes::open_in(&dir, id, rel))
                    .status()
                    .as_u16(),
                status
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_url_cannot_name_a_vault_path() {
        for url in [
            "file:///etc/hosts",
            "cerebro-file://evil/0/a.png",
            "cerebro-file://localhost:80/0/a.png",
            "cerebro-file://user@localhost/0/a.png",
            "cerebro-file://localhost/0/../etc/hosts",
            "cerebro-file://localhost/0/%2e%2e/etc/hosts",
            "cerebro-file://localhost/0/a%2fb.png",
            "cerebro-file://localhost/0/a%5cb.png",
            "cerebro-file://localhost/0/a%00.png",
            "cerebro-file://localhost/0/a%zz.png",
            "cerebro-file://localhost/0/a%ff.png",
            "cerebro-file://localhost/0/a.png?x=1",
        ] {
            let Ok(request) = Request::builder().uri(url).body(vec![]) else {
                // http::Uri itself refuses a file URL without an authority.
                assert_eq!(url, "file:///etc/hosts");
                continue;
            };
            let out = serve(request, |_, _| {
                panic!("invalid address reached resolver: {url}")
            });
            assert_eq!(out.status(), StatusCode::FORBIDDEN, "{url}");
        }
    }

    #[test]
    fn the_csp_admits_the_scheme_to_img_and_media_only() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"].as_str().unwrap();
        let directives = csp.split(';').map(str::trim).collect::<Vec<_>>();
        assert!(directives.contains(&"img-src 'self' data: cerebro-file:"));
        assert!(directives.contains(&"media-src 'self' cerebro-file:"));
        assert_eq!(
            directives
                .iter()
                .filter(|line| line.contains("cerebro-file:"))
                .count(),
            2
        );
        for forbidden in ["asset:", "blob:", "*", "frame-src"] {
            assert!(!csp.contains(forbidden));
        }
    }

    #[test]
    fn only_the_main_webview_is_served() {
        let source = include_str!("scheme.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(source.contains("context.webview_label() != \"main\""));
        assert!(
            source.find("context.webview_label()").unwrap()
                < source.find("app_dir(context.app_handle())").unwrap()
        );
    }

    #[test]
    fn the_scheme_is_registered_once_in_lib_rs() {
        assert_eq!(
            include_str!("../lib.rs")
                .matches("register_asynchronous_uri_scheme_protocol(\"cerebro-file\"")
                .count(),
            1
        );
    }

    #[test]
    fn the_scheme_logs_nothing() {
        let source = include_str!("scheme.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for forbidden in ["log::", "println!", "eprintln!", "diagnostics::"] {
            assert!(!source.contains(forbidden));
        }
    }
}
