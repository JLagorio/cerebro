//! Requested message text: keep the reply, leave forwards intact, and make
//! every retained line inert before it can become a vault page.
use super::digest::escape_vault_text;

fn header(line: &str) -> &str {
    let mut value = line.trim();
    while let Some(rest) = value.strip_prefix('>') {
        value = rest.trim_start();
    }
    value
}
fn starts(line: &str, prefix: &str) -> bool {
    line.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}
fn forward(subject: &str) -> bool {
    let mut value = subject.trim();
    while starts(value, "re:") {
        value = value[3..].trim_start();
    }
    starts(value, "fwd:") || starts(value, "fw:")
}
fn reply(subject: &str, text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    if forward(subject) {
        return normalized.trim_end().into();
    }
    let lines: Vec<_> = normalized.lines().collect();
    let mut cut = lines.len();
    for (i, line) in lines.iter().enumerate() {
        let value = header(line);
        let next = lines.get(i + 1).map(|line| header(line)).unwrap_or("");
        let lower = value.to_ascii_lowercase();
        let quoted_on = starts(value, "on ")
            && (lower.ends_with("wrote:")
                || (!next.is_empty() && next.to_ascii_lowercase().ends_with("wrote:")));
        let original = value.starts_with('-')
            && value.ends_with('-')
            && value
                .trim_matches('-')
                .trim()
                .eq_ignore_ascii_case("original message");
        let outlook = starts(value, "from:")
            && lines
                .iter()
                .skip(i + 1)
                .take(3)
                .any(|line| starts(header(line), "sent:") || starts(header(line), "date:"));
        let underscores =
            value.len() >= 10 && value.bytes().all(|c| c == b'_') && starts(next, "from:");
        if quoted_on || original || outlook || underscores {
            cut = i;
            break;
        }
    }
    lines[..cut].join("\n").trim_end().into()
}
/// Limits count Unicode characters before escaping, so a cut never splits a
/// code point and encoding does not consume the person's text allowance.
pub fn reply_text(subject: &str, text: &str, max_chars: usize) -> String {
    let kept = reply(subject, text);
    let cut = kept.chars().count() > max_chars;
    let kept: String = kept.chars().take(max_chars).collect();
    let mut escaped = kept
        .lines()
        .map(escape_vault_text)
        .collect::<Vec<_>>()
        .join("\n");
    if cut {
        escaped.push_str(&format!("\n\n(cut at {max_chars} characters)"));
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_the_reply_and_cuts_common_quoted_headers() {
        for quote in [
            "On Monday, Dana wrote:\nold",
            "On Monday,\nDana wrote:\nold",
            "-----Original Message-----\nold",
            "From: Dana\nSent: Monday\nold",
            "From: Dana\nTo: Owner\nDate: Monday\nold",
            "__________\nFrom: Dana\nold",
            "> On Monday, Dana wrote:\nold",
        ] {
            assert_eq!(
                reply_text("Re: Launch", &format!("New reply.\n\n{quote}"), 1000),
                "New reply.",
                "{quote}"
            );
        }
    }
    #[test]
    fn a_from_sentence_stays_and_forwards_are_kept_whole() {
        assert_eq!(
            reply_text(
                "Launch",
                "From: the hill, we can see the coast.\nKeep this.",
                1000
            ),
            "From&#58; the hill, we can see the coast.\nKeep this."
        );
        for subject in ["Fwd: Launch", "Fw: Launch", "Re: RE: Fw: Launch"] {
            assert!(reply_text(
                subject,
                "Forwarded note\nOn Monday, Dana wrote:\nKeep this",
                1000
            )
            .contains("Keep this"));
        }
    }
    #[test]
    fn cached_text_holds_nothing_a_scanner_reads() {
        let escaped = reply_text(
            "Launch",
            "[[Launch]]\n- [ ] task\n:::toggle\n```\n@2026-07-28\n<img src=x>",
            1000,
        );
        assert!(crate::vault::parse::wikilink_targets(&escaped).is_empty());
        for live in ["[[", "- [ ]", ":::toggle", "```", "@2026", "<img"] {
            assert!(!escaped.contains(live), "{live}");
        }
    }
    #[test]
    fn the_cut_counts_unicode_characters_and_says_so() {
        assert_eq!(
            reply_text("Launch", "é😀abc", 3),
            "é😀a\n\n(cut at 3 characters)"
        );
    }
}
