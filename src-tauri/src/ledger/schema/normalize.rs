//! `normalize_alias_v1` (M22.1, §84): the ONE alias-key normalization.
//!
//! Pipeline, in order: Unicode NFKC → Unicode Default Case Conversion
//! lowercase (`str::to_lowercase`, which carries the Final_Sigma rule) →
//! each run of `White_Space` characters becomes one ASCII space → trim.
//! The design names "NFKC case-folding"; it is realized as NFKC + default
//! full lowercase because that exact pipeline exists verbatim on both
//! toolchains (`String.prototype.normalize('NFKC')` + `toLowerCase()` in
//! TS), and cross-implementation parity — pinned by shared conformance
//! vectors, not trusted from either runtime — outranks the handful of
//! fold-only mappings (ẞ→ss, Cherokee) neither runtime ships natively.
//!
//! `alias` fields preserve the exact display bytes; only this computed key
//! participates in uniqueness and conflict checks. Never substitute a
//! locale-sensitive lowercase.

use unicode_normalization::UnicodeNormalization;

pub fn normalize_alias_v1(alias: &str) -> String {
    let folded: String = alias.nfkc().collect::<String>().to_lowercase();
    let mut out = String::with_capacity(folded.len());
    let mut pending_space = false;
    for ch in folded.chars() {
        if ch.is_whitespace() {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // These literals are the contract — the same vectors ship to the TS
    // reducer in M22.4. A change here is a normalization-version change,
    // not a refactor.
    #[test]
    fn the_normalization_vectors_are_pinned() {
        let vectors = [
            ("Acme Corp", "acme corp"),
            ("  spaced\u{00a0}\u{2003}out\tname \n", "spaced out name"),
            ("ﬁle SYSTEM", "file system"), // U+FB01 ligature fi → fi (NFKC)
            ("Ⅸ legion", "ix legion"),     // U+2168 roman numeral → IX → ix
            ("ΟΔΥΣΣΕΥΣ", "οδυσσευς"),      // final sigma via str::to_lowercase
            ("Straße", "straße"),          // ß is lowercase already; NFKC keeps it
            ("１２３ ｆｕｌｌwidth", "123 fullwidth"),
            ("é", "é"),                      // U+0065 U+0301 composes to U+00E9
            ("İstanbul", "i\u{307}stanbul"), // default (non-Turkish) mapping
        ];
        for (input, want) in vectors {
            assert_eq!(normalize_alias_v1(input), want, "input {input:?}");
        }
    }

    #[test]
    fn whitespace_only_input_normalizes_to_empty() {
        assert_eq!(normalize_alias_v1(" \t\u{3000} "), "");
        assert_eq!(normalize_alias_v1(""), "");
    }

    #[test]
    fn display_bytes_and_key_are_different_things() {
        // The key collapses; the display spelling (stored alongside) does
        // not pass through this function at all.
        assert_eq!(normalize_alias_v1("A  B"), "a b");
        assert_ne!("A  B", normalize_alias_v1("A  B"));
    }
}
