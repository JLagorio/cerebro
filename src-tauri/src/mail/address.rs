//! Bounded mailbox parsing. Shared address/mailbox cases also run in TypeScript.
/// This is address matching, not a deliverability claim. Non-ASCII spelling
/// is retained; only ASCII letters are folded, matching the shared cases.
pub fn normalize_address(raw: &str) -> Option<String> {
    let mut value = raw.trim();
    if value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("mailto:"))
    {
        value = value[7..].trim();
    }
    if let Some(inner) = value.strip_prefix('<').and_then(|s| s.strip_suffix('>')) {
        value = inner.trim();
    }
    let (local, domain) = value.split_once('@')?;
    if !(1..=64).contains(&local.chars().count())
        || domain.is_empty()
        || !domain.contains('.')
        || domain.split('.').any(str::is_empty)
        || domain.contains('@')
        || value
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "<>()[],;:\"\\".contains(c))
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mailbox {
    pub address: String,
    pub name: Option<String>,
}
pub fn parse_mailbox(raw: &str, name_chars: usize) -> Option<Mailbox> {
    let raw = raw.replace('\u{00a0}', " ");
    let value = raw.trim();
    let (address, name) = if let Some(at) = value.rfind('<') {
        let address = normalize_address(&value[at..])?;
        let mut name = value[..at].trim().trim_matches('"').trim().to_owned();
        // Provider display names can append a relay service. The relay is not
        // the correspondent's name, and an address is never a display name.
        let lower = name.to_ascii_lowercase();
        let via = [" via ", " (via "]
            .iter()
            .filter_map(|marker| lower.find(marker))
            .min();
        if let Some(at) = via {
            name.truncate(at);
        }
        let name = name.trim().trim_matches('"').trim();
        let name = if name.is_empty() || name.contains('@') {
            None
        } else {
            Some(
                name.chars()
                    .filter(|c| !c.is_control())
                    .take(name_chars)
                    .collect(),
            )
        };
        (address, name)
    } else {
        (normalize_address(value)?, None)
    };
    Some(Mailbox { address, name })
}
#[cfg(test)]
pub fn domain_of(address: &str) -> Option<String> {
    normalize_address(address)?
        .split_once('@')
        .map(|(_, domain)| domain.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replays_the_shared_mailbox_cases() {
        // Shared with src/engine/mailAddress.test.ts: shared/policy/mail.v1.json.
        let policy = crate::policy::mail::table();
        for case in &policy.address_cases {
            assert_eq!(normalize_address(&case.raw), case.address, "{}", case.raw);
            assert_eq!(
                domain_of(&case.raw),
                case.address
                    .as_ref()
                    .map(|v| v.split_once('@').unwrap().1.to_owned())
            );
        }
        for case in &policy.mailbox_cases {
            let parsed = parse_mailbox(&case.raw, policy.limits.name_chars);
            assert_eq!(
                parsed.as_ref().map(|v| &v.address),
                case.address.as_ref(),
                "{}",
                case.raw
            );
            assert_eq!(parsed.and_then(|v| v.name), case.name, "{}", case.raw);
        }
    }
}
