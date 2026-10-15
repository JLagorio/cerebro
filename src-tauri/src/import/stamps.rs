//! sources.v1.json: agent note doors preserve each writer-owned key's presence and YAML value.
use super::{strings, table, words};
fn fields(content: &str) -> serde_yaml::Mapping {
    crate::vault::parse::split_frontmatter(content)
        .0
        .and_then(|yaml| serde_yaml::from_str::<serde_yaml::Value>(yaml).ok())
        .and_then(|value| value.as_mapping().cloned())
        .unwrap_or_default()
}
pub fn stamp_bytes_refusal(before: &str, after: &str) -> Option<String> {
    let before = fields(before);
    let after = fields(after);
    let changed: Vec<_> = strings(&table().value["agent_guard"])
        .into_iter()
        .filter(|key| before.get(*key) != after.get(*key))
        .collect();
    (!changed.is_empty()).then(|| words("stamp_refusal", &[("keys", &changed.join(", "))]))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replays_the_stamp_guard_cases() {
        for case in table().value["cases"]["stamp_guard"].as_array().unwrap() {
            assert_eq!(
                stamp_bytes_refusal(
                    case["before"].as_str().unwrap(),
                    case["after"].as_str().unwrap()
                )
                .as_deref(),
                case["refusal"].as_str(),
                "{}",
                case["name"]
            );
        }
    }
}
