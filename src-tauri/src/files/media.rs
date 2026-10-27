//! The page-media grammar and contained destinations replay media-lines.json
//! with pageMedia.ts/docLinks.ts (D3). Only scoped note reads use these pictures.
use super::{extract, images, kinds};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::Path,
};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Media {
    name: String,
    url: String,
    caption: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<f64>,
}
fn scheme(text: &str) -> bool {
    let Some((prefix, _)) = text.split_once(':') else {
        return false;
    };
    let mut chars = prefix.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}
fn bare_path(url: &str) -> &str {
    url.split('#')
        .next()
        .unwrap_or(url)
        .split('?')
        .next()
        .unwrap_or(url)
}
fn media_kind(url: &str) -> &'static str {
    let path = bare_path(url);
    match kinds::lookup(path).kind {
        kinds::Kind::Image => "image",
        kinds::Kind::Video => "video",
        kinds::Kind::Audio => "audio",
        kinds::Kind::Unknown if scheme(url) || kinds::ext_of(path).is_none() => "image",
        _ => "file",
    }
}
fn unescape(raw: &str) -> String {
    let mut chars = raw.chars().peekable();
    let mut out = String::new();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek().is_some_and(char::is_ascii_punctuation) {
            out.push(chars.next().expect("peeked"));
        } else {
            out.push(c);
        }
    }
    out
}
fn escaped(chars: &[char], i: &mut usize, out: &mut String) -> bool {
    if chars.get(*i) == Some(&'\\') && *i + 1 < chars.len() {
        out.push(chars[*i]);
        out.push(chars[*i + 1]);
        *i += 2;
        true
    } else {
        false
    }
}
/// Strict whole-line embeds, including balanced bare destinations and three
/// CommonMark title delimiters. The shared cases pin escapes and Unicode.
pub fn parse_media_line(line: &str) -> Option<Media> {
    let chars: Vec<char> = line.chars().collect();
    if !line.starts_with("![") {
        return None;
    }
    let mut i = 2;
    let mut text = String::new();
    loop {
        let c = *chars.get(i)?;
        if c == '\n' || c == '[' {
            return None;
        }
        if escaped(&chars, &mut i, &mut text) {
            continue;
        }
        if c == ']' {
            break;
        }
        text.push(c);
        i += 1;
    }
    i += 1;
    if chars.get(i) != Some(&'(') {
        return None;
    }
    i += 1;
    let mut raw = String::new();
    if chars.get(i) == Some(&'<') {
        i += 1;
        loop {
            let c = *chars.get(i)?;
            if c == '\n' || c == '<' {
                return None;
            }
            if escaped(&chars, &mut i, &mut raw) {
                continue;
            }
            if c == '>' {
                break;
            }
            raw.push(c);
            i += 1;
        }
        i += 1;
    } else {
        let mut depth = 0;
        loop {
            let c = *chars.get(i)?;
            if matches!(c, ' ' | '\t') {
                break;
            }
            if (c as u32) < 0x20 || c == '\u{7f}' {
                return None;
            }
            if escaped(&chars, &mut i, &mut raw) {
                continue;
            }
            if c == '(' {
                depth += 1;
            }
            if c == ')' {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            }
            raw.push(c);
            i += 1;
        }
        if depth != 0 {
            return None;
        }
    }
    let url = unescape(&raw);
    if url.is_empty() {
        return None;
    }
    let space_at = i;
    while matches!(chars.get(i), Some(' ' | '\t')) {
        i += 1;
    }
    let mut caption = String::new();
    if i > space_at && matches!(chars.get(i), Some('"' | '\'' | '(')) {
        let open = chars[i];
        let close = if open == '(' { ')' } else { open };
        i += 1;
        loop {
            let c = *chars.get(i)?;
            if c == '\n' || (open == '(' && c == '(') {
                return None;
            }
            if escaped(&chars, &mut i, &mut caption) {
                continue;
            }
            if c == close {
                break;
            }
            caption.push(c);
            i += 1;
        }
        i += 1;
        while matches!(chars.get(i), Some(' ' | '\t')) {
            i += 1;
        }
    }
    if chars.get(i) != Some(&')') || i + 1 != chars.len() {
        return None;
    }
    let mut width = None;
    if matches!(media_kind(&url), "image" | "video") {
        if let Some((name, digits)) = text.rsplit_once('|') {
            if !digits.is_empty()
                && digits.bytes().all(|c| c.is_ascii_digit())
                && name.chars().rev().take_while(|c| *c == '\\').count() % 2 == 0
            {
                width = digits.parse().ok();
                text = name.to_owned();
            }
        }
    }
    Some(Media {
        name: unescape(&text),
        url,
        caption: unescape(&caption),
        width,
    })
}
#[derive(Debug, PartialEq, Eq)]
enum DestinationError {
    Remote,
    Outside,
}
fn destination(note: &str, href: &str) -> Result<String, DestinationError> {
    let href = href
        .strip_prefix('<')
        .and_then(|s| s.strip_suffix('>'))
        .unwrap_or(href);
    if scheme(href) || href.starts_with("//") {
        return Err(DestinationError::Remote);
    }
    if href.starts_with('#') {
        return Err(DestinationError::Outside);
    }
    let raw = bare_path(href);
    for (i, byte) in raw.bytes().enumerate() {
        if byte == b'%'
            && !raw
                .as_bytes()
                .get(i + 1..i + 3)
                .is_some_and(|s| s.iter().all(u8::is_ascii_hexdigit))
        {
            return Err(DestinationError::Outside);
        }
    }
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .map_err(|_| DestinationError::Outside)?;
    if scheme(&decoded) || decoded.starts_with("//") {
        return Err(DestinationError::Remote);
    }
    if decoded.contains('\\') || decoded.chars().any(char::is_control) {
        return Err(DestinationError::Outside);
    }
    let mut parts: Vec<&str> = if decoded.starts_with('/') {
        vec![]
    } else {
        note.rsplit_once('/')
            .map_or_else(Vec::new, |(parent, _)| parent.split('/').collect())
    };
    for part in decoded.split('/') {
        match part {
            "" | "." => (),
            ".." => {
                if parts.pop().is_none() {
                    return Err(DestinationError::Outside);
                }
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        Err(DestinationError::Outside)
    } else {
        Ok(parts.join("/"))
    }
}
/// Fenced code uses CommonMark's marker/length rule; an unclosed fence keeps
/// the rest inert. A marker inside a longer fenced block cannot end it early.
fn unfenced_lines(body: &str) -> impl Iterator<Item = &str> {
    let mut fence: Option<(char, usize)> = None;
    body.lines().filter(move |line| {
        let spaces = line.bytes().take_while(|c| *c == b' ').count();
        let trimmed = &line[spaces..];
        if spaces <= 3 {
            if let Some(marker @ ('`' | '~')) = trimmed.chars().next() {
                let count = trimmed.chars().take_while(|c| *c == marker).count();
                let rest = &trimmed[count..];
                if let Some((open, length)) = fence {
                    if marker == open && count >= length && rest.trim().is_empty() {
                        fence = None;
                    }
                } else if count >= 3 && (marker != '`' || !rest.contains('`')) {
                    fence = Some((marker, count));
                }
                if fence.is_some() || (count >= 3 && rest.trim().is_empty()) {
                    return false;
                }
            }
        }
        fence.is_none()
    })
}
fn picture_lines(body: &str) -> Vec<Media> {
    unfenced_lines(body)
        .filter_map(parse_media_line)
        .filter(|media| media_kind(&media.url) == "image")
        .collect()
}

/// Portable backup uses the existing destination and whole-line media grammar.
/// Inline/reference-style forms are explicitly unsupported here, never silently
/// treated as a complete dependency inventory. No URI is fetched.
pub(crate) fn backup_dependencies(note: &str, body: &str) -> Result<BTreeSet<String>, String> {
    let mut out = BTreeSet::new();
    for line in unfenced_lines(body) {
        let link = if line.starts_with('[') && !line.starts_with("[[") {
            parse_media_line(&format!("!{line}"))
        } else if line.starts_with("![") {
            parse_media_line(line)
        } else {
            None
        };
        if let Some(media) = link {
            match destination(note, &media.url) {
                Ok(path) => {
                    out.insert(path);
                }
                Err(DestinationError::Remote) => {}
                Err(DestinationError::Outside) if media.url.starts_with('#') => {}
                Err(DestinationError::Outside) => {
                    return Err(
                        "A local dependency is outside the supported contained-path grammar."
                            .into(),
                    )
                }
            }
        } else if line.contains("](") || line.contains("][") || line.contains("![")
            // A reference label can begin on an earlier line. Refuse its closing
            // definition delimiter even when this line does not start with '['.
            || line.contains("]:")
            || line.match_indices('<').any(|(offset, _)| {
                let tail = &line[offset + 1..];
                if !tail.as_bytes().first().is_some_and(u8::is_ascii_alphabetic) { return false; }
                let end = tail.bytes().take_while(|byte| byte.is_ascii_alphanumeric() || *byte == b'-').count();
                // Recognize an unsupported opening tag, not its attributes or
                // semantics. URI/email autolinks have ':'/'@' at this boundary.
                tail[end..].chars().next().is_none_or(|next| next.is_ascii_whitespace() || matches!(next, '/' | '>'))
            })
        {
            return Err("Inline, reference-style or HTML dependencies need a supported reader before this backup can be complete.".into());
        }
    }
    Ok(out)
}

pub struct Pictures {
    pub header: String,
    pub content: Vec<Value>,
}
/// Scope is checked on both the requested and pinned canonical path before
/// any bytes are read. Nothing fetches a URL. Eight decoder attempts bound
/// work even if every allowed file is corrupt; all other omissions are counted.
pub fn pictures_of(
    vault: &Path,
    note: &str,
    body: &str,
    fits: bool,
    may_read: impl Fn(&str) -> bool,
) -> Pictures {
    let lines = picture_lines(body);
    if lines.is_empty() {
        return Pictures {
            header: String::new(),
            content: vec![],
        };
    }
    let mut seen = BTreeSet::new();
    let mut candidates = vec![];
    for media in lines {
        let dest = destination(note, &media.url);
        let key = dest.as_ref().unwrap_or(&media.url).clone();
        if seen.insert(key) {
            candidates.push((media, dest));
        }
    }
    let total = candidates.len();
    if !fits {
        return Pictures { header: format!("Images: {total} in this note, none attached: the note is over 40,000 characters, and pictures would push the answer past the size one answer may have.\n"), content: vec![] };
    }
    let mut reasons: BTreeMap<String, usize> = BTreeMap::new();
    let mut content = vec![];
    let mut captions = vec![];
    let mut canonical_seen = BTreeSet::new();
    let mut duplicates = 0;
    let mut attempts = 0;
    for (media, dest) in candidates {
        let attach = || -> Result<(), String> {
            let rel = dest.map_err(|e| {
                match e {
                    DestinationError::Remote => "remote (never fetched)",
                    DestinationError::Outside => "outside the vault",
                }
                .to_owned()
            })?;
            if !may_read(&rel) {
                return Err("outside this run's read scope".into());
            }
            let opened = extract::vault_file(vault, &rel).map_err(|e| {
                if e.starts_with("path escapes") {
                    "outside the vault"
                } else if e.starts_with("dot-folders") {
                    "in a dot-folder"
                } else {
                    "missing"
                }
                .to_owned()
            })?;
            let canonical = opened
                .path
                .strip_prefix(&opened.root)
                .map_err(|_| "outside the vault")?
                .to_string_lossy()
                .replace('\\', "/");
            if !may_read(&canonical) {
                return Err("outside this run's read scope".into());
            }
            if !canonical_seen.insert(canonical) {
                duplicates += 1;
                return Ok(());
            }
            // The table says whether it is an image; the decoder still verifies
            // its bytes. SVG/HEIC never reach image's format auto-detection.
            let ext = kinds::ext_of(&rel).unwrap_or_default();
            if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp") {
                return Err(format!(
                    "not a picture Cerebro reads ({})",
                    if ext.is_empty() {
                        "unknown format"
                    } else {
                        &ext
                    }
                ));
            }
            if attempts >= 8 {
                return Err("over the limit of 8".into());
            }
            attempts += 1;
            if opened
                .file
                .metadata()
                .map_err(|_| "could not be read")?
                .len()
                > images::INPUT_BYTES
            {
                return Err("too large to read".into());
            }
            let mut bytes = vec![];
            opened
                .file
                .take(images::INPUT_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "could not be read")?;
            let image = images::prepare(&bytes).map_err(|e| e.words())?;
            let alt: String = media.name.chars().take(500).collect();
            let alt = if alt.is_empty() {
                String::new()
            } else {
                format!(", {}", json!(alt))
            };
            captions.push(format!(
                "- Image {}: {rel}{alt}, {}×{}",
                content.len() + 1,
                image.width,
                image.height
            ));
            content.push(
                json!({"type":"image","data":STANDARD.encode(image.bytes),"mimeType":image.mime}),
            );
            Ok(())
        };
        if let Err(reason) = attach() {
            *reasons.entry(reason).or_default() += 1;
        }
    }
    let mut header = format!(
        "Images: {} of {} attached, at most 1080 pixels on the longest side.",
        content.len(),
        total - duplicates
    );
    if !reasons.is_empty() {
        header.push_str(&format!(
            " Not attached: {}.",
            reasons
                .iter()
                .map(|(reason, n)| format!("{n} {reason}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    header.push('\n');
    for caption in captions {
        header.push_str(&caption);
        header.push('\n');
    }
    Pictures { header, content }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cases() -> Value {
        serde_json::from_str(include_str!("../../fixtures/media-lines.json")).unwrap()
    }
    #[test]
    fn media_lines_replay_the_shared_cases() {
        for case in cases()["lines"].as_array().unwrap() {
            let line = case["line"].as_str().unwrap();
            let expect: Option<Media> = serde_json::from_value(case["media"].clone()).unwrap();
            let actual = parse_media_line(line);
            assert_eq!(actual, expect, "{line}");
            if let Some(media) = actual {
                assert_eq!(
                    media_kind(&media.url),
                    case["kind"].as_str().unwrap(),
                    "{line}"
                );
            }
        }
    }
    #[test]
    fn destinations_resolve_as_the_page_does() {
        for case in cases()["destinations"].as_array().unwrap() {
            assert_eq!(
                destination(
                    case["note"].as_str().unwrap(),
                    case["dest"].as_str().unwrap()
                )
                .ok()
                .as_deref(),
                case["path"].as_str(),
                "{case}"
            );
        }
    }
    #[test]
    fn fenced_code_holds_no_pictures() {
        let body = "![](a.png)\n```md\n![](b.png)\n```\n~~~~\n![](c.png)\n~~~\n![](d.png)\n~~~~\n![](e.png)\n  ```\n![](f.png)\n";
        assert_eq!(
            picture_lines(body)
                .iter()
                .map(|m| m.url.as_str())
                .collect::<Vec<_>>(),
            ["a.png", "e.png"]
        );
    }
    #[test]
    fn only_image_lines_count_as_pictures() {
        let body = "![Original](/attachments/report.docx)\n![PDF](report.pdf)\n![](clip.mp4)\n![](sound.mp3)\n![](a.png)\n";
        assert_eq!(picture_lines(body).len(), 1);
    }
    #[test]
    fn failed_decoders_cannot_make_one_note_do_unbounded_work() {
        let dir = extract::testdocs::TempDir::new();
        for i in 0..9 {
            std::fs::write(dir.path().join(format!("{i}.png")), b"not a PNG").unwrap();
        }
        let body = (0..9)
            .map(|i| format!("![]({i}.png)\n"))
            .collect::<String>();
        let result = pictures_of(dir.path(), "page.md", &body, true, |_| true);
        assert!(result.content.is_empty());
        assert!(result.header.contains("1 over the limit of 8"));
    }
}

#[cfg(test)]
mod portable_dependency_tests {
    use super::*;
    #[test]
    fn portable_dependencies_use_existing_relative_destination_and_fence_grammar() {
        let text = "[One](../attachments/a(b).pdf#part)\n![Two](../attachments/a%20b.png?x=1#image)\n~~~\n![ignored](../missing.png)\n~~~\n";
        assert_eq!(
            backup_dependencies("folder/page.md", text).unwrap(),
            BTreeSet::from(["attachments/a(b).pdf".into(), "attachments/a b.png".into()])
        );
        assert!(backup_dependencies("page.md", "Ordinary unlinked prose.\n\n# A heading\n<https://example.test/remote>\n<mail@example.test>\n").unwrap().is_empty());
    }
    #[test]
    fn portable_unsupported_forms_refuse_without_interpreting_partial_dependencies() {
        for text in [
            "```info` ![x](attachments/missing.png)",
            "inline [a](file.bin)",
            "![image][asset]",
            "[asset]: file.bin",
            "[asset\nlabel]: file.bin\n\n[asset label]",
            "<IMG SRC='file.png'>",
            "<video\n src='file.mp4'>",
            "<a\nhref='file.bin'>x</a>",
            "<input\ntype='image'\nsrc='file.png'>",
            "<image\nhref='file.png'>",
            "![[file.png]]",
        ] {
            assert!(backup_dependencies("page.md", text).is_err(), "{text}");
        }
    }
}
