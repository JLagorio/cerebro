//! Ranked full-text search over the scanned vault (M17.19).
//!
//! `search_notes` was `haystack.contains(needle)` with an early `break` at the
//! limit, over path-sorted entries. Two defects, and the second is the one
//! that mattered:
//!
//! 1. **Word order was load-bearing.** "onboarding checklist" scored zero
//!    against a note reading "checklist for onboarding", because the whole
//!    query had to appear as one contiguous run of characters.
//! 2. **It returned the alphabetically-first N matches, not the best N.** The
//!    scanner yields entries path-sorted, so `break` truncated in filename
//!    order. A vault whose best answer lives in `work/` never surfaced it if
//!    twenty weaker matches lived in `archive/`.
//!
//! No index, deliberately. Measured on the demo vault: a full scan is ~4.6 ms
//! and a full-corpus query ~48 µs, and `tool_search` already pays the scan and
//! reads every body on every call — it was doing all the work an index would
//! amortise and then throwing the result away. An index would also be the
//! first derived state that could not be recomputed, which is the rule
//! `engine/okf.ts` exists to hold. Ranking here is arithmetic over data that
//! is already in hand.
//!
//! Where this stops being right: roughly 5–10k notes, extrapolating linearly
//! from 34 µs per note. Past that the thing to cache is the SCAN — three times
//! the cost of reading the bodies — and still not an index.

/// BM25's two knobs, at the values the literature settled on.
///
/// `K1` bounds how much a repeated term can keep helping; `B` is how hard to
/// penalise a long document for having more room to contain the term at all.
const K1: f32 = 1.2;
const B: f32 = 0.75;

/// A title match is worth three body matches, a type name two.
///
/// Notes are SHORT here — median 46 words — so a single body hit is already a
/// large fraction of a document. Without field weighting a passing mention in
/// a long note outranks a note actually titled with the thing you asked for.
const TITLE_WEIGHT: f32 = 3.0;
const TYPE_WEIGHT: f32 = 2.0;

/// A token in more than half the corpus carries no information, so it must not
/// be able to exclude a document — a vault where every note says "project"
/// should not require the word to mean anything.
///
/// Only consulted once the corpus is big enough for the ratio to mean
/// something. At three notes, "in two of three" is noise, not evidence.
const COMMON_DF: f32 = 0.5;
const DF_IS_MEANINGFUL_ABOVE: f32 = 10.0;

/// English function words, which are noise at ANY corpus size.
///
/// The document-frequency rule cannot find these on a small vault — with ten
/// notes, "is" appearing in four of them looks informative — and "what is at
/// risk" is four tokens of which exactly one is a question. A short explicit
/// list is more predictable than a cleverer rule and fails in ways a person
/// can guess from the query they typed.
const STOPWORDS: &[&str] = &[
    "a", "an", "and", "any", "are", "as", "at", "be", "but", "by", "can", "did", "do", "does",
    "for", "from", "had", "has", "have", "how", "i", "if", "in", "is", "it", "its", "me", "my",
    "no", "not", "of", "on", "or", "our", "so", "than", "that", "the", "their", "them", "then",
    "there", "these", "they", "this", "to", "was", "we", "were", "what", "when", "where", "which",
    "who", "why", "will", "with", "would", "you", "your",
];

fn is_stopword(term: &str) -> bool {
    STOPWORDS.contains(&term)
}

pub struct Doc<'a> {
    pub path: &'a str,
    pub title: &'a str,
    pub kind: Option<&'a str>,
    pub body: &'a str,
}

pub struct Hit {
    /// Index into the `docs` slice — the caller owns the entry, we only rank.
    pub index: usize,
    pub score: f32,
    /// The line that best answers the query, trimmed and capped.
    pub excerpt: String,
}

pub struct Ranked {
    pub hits: Vec<Hit>,
    /// True when nothing contained every informative term and this is the
    /// widened, any-term answer. The caller says so rather than presenting a
    /// loose match as a tight one.
    pub widened: bool,
}

/// Split on anything that is not a letter or a digit, lowercased.
///
/// Deliberately not a stemmer: "risk" and "risks" staying distinct costs one
/// near-miss, while a stemmer costs a dependency and a class of surprising
/// matches nobody can explain from the query they typed.
pub fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect()
}

fn count(tokens: &[String], term: &str) -> f32 {
    tokens.iter().filter(|t| t.as_str() == term).count() as f32
}

/// Rank `docs` against `query`, best first.
pub fn rank(query: &str, docs: &[Doc], limit: usize) -> Ranked {
    let terms = dedupe(tokenize(query));
    if terms.is_empty() || docs.is_empty() {
        return Ranked {
            hits: Vec::new(),
            widened: false,
        };
    }

    // Tokenize once. Every score below reads these, and re-splitting per term
    // is what makes a naive implementation quadratic in query length.
    let fields: Vec<(Vec<String>, Vec<String>, Vec<String>)> = docs
        .iter()
        .map(|d| {
            (
                tokenize(d.title),
                tokenize(d.kind.unwrap_or("")),
                tokenize(d.body),
            )
        })
        .collect();

    let n = docs.len() as f32;
    let lengths: Vec<f32> = fields
        .iter()
        .map(|(t, _, b)| (t.len() + b.len()) as f32)
        .collect();
    let avgdl = (lengths.iter().sum::<f32>() / n).max(1.0);

    // Document frequency per term, over the fields a term can be found in.
    let df: Vec<f32> = terms
        .iter()
        .map(|term| {
            fields
                .iter()
                .filter(|(t, k, b)| {
                    t.iter().any(|x| x == term)
                        || k.iter().any(|x| x == term)
                        || b.iter().any(|x| x == term)
                })
                .count() as f32
        })
        .collect();

    // What a document MUST contain. A term nobody has cannot gate anything —
    // requiring it would answer nothing at all — and a term everybody has
    // gates nothing useful.
    let mut required: Vec<usize> = (0..terms.len())
        .filter(|&i| {
            df[i] > 0.0
                && !is_stopword(&terms[i])
                && (n < DF_IS_MEANINGFUL_ABOVE || df[i] <= n * COMMON_DF)
        })
        .collect();
    // The query was all function words, or every word of it is everywhere:
    // fall back to whatever actually occurs, so the tool still answers rather
    // than returning the whole vault or none of it.
    if required.is_empty() {
        required = (0..terms.len()).filter(|&i| df[i] > 0.0).collect();
    }

    let scored = |strict: bool| -> Vec<Hit> {
        let mut hits: Vec<Hit> = Vec::new();
        for (i, doc) in docs.iter().enumerate() {
            let (title, kind, body) = &fields[i];
            let mut score = 0.0f32;
            let mut matched = 0usize;
            for (t, term) in terms.iter().enumerate() {
                if df[t] == 0.0 {
                    continue;
                }
                let tf = count(body, term)
                    + TITLE_WEIGHT * count(title, term)
                    + TYPE_WEIGHT * count(kind, term);
                if tf == 0.0 {
                    continue;
                }
                matched += 1;
                let idf = ((n - df[t] + 0.5) / (df[t] + 0.5) + 1.0).ln();
                let norm = K1 * (1.0 - B + B * lengths[i] / avgdl);
                score += idf * (tf * (K1 + 1.0)) / (tf + norm);
            }
            if matched == 0 {
                continue;
            }
            if strict && !required.iter().all(|&r| has(&fields[i], &terms[r])) {
                continue;
            }
            // An exact phrase is what the caller most likely meant, and the
            // old substring behaviour got that one thing right. Kept as a
            // bonus rather than a filter, so word order helps and never gates.
            if terms.len() > 1 && contains_phrase(doc, query) {
                score *= 1.5;
            }
            hits.push(Hit {
                index: i,
                score,
                excerpt: excerpt(doc.body, &terms),
            });
        }
        // Ties broken by path so the answer is stable between identical calls;
        // an unstable order makes a tool look like it is guessing.
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| docs[a.index].path.cmp(docs[b.index].path))
        });
        hits.truncate(limit);
        hits
    };

    let strict = scored(true);
    if !strict.is_empty() {
        return Ranked {
            hits: strict,
            widened: false,
        };
    }
    Ranked {
        hits: scored(false),
        widened: true,
    }
}

fn has(fields: &(Vec<String>, Vec<String>, Vec<String>), term: &str) -> bool {
    fields.0.iter().any(|x| x == term)
        || fields.1.iter().any(|x| x == term)
        || fields.2.iter().any(|x| x == term)
}

fn contains_phrase(doc: &Doc, query: &str) -> bool {
    let needle = query.trim().to_lowercase();
    doc.title.to_lowercase().contains(&needle) || doc.body.to_lowercase().contains(&needle)
}

fn dedupe(tokens: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tokens {
        if !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// The line carrying the most distinct query terms — the answer, not the
/// first mention of it. Ties go to the earlier line, which is usually the
/// note's own summary.
fn excerpt(body: &str, terms: &[String]) -> String {
    let mut best: Option<(usize, &str)> = None;
    for line in body.lines() {
        let tokens = tokenize(line);
        if tokens.is_empty() {
            continue;
        }
        let hits = terms
            .iter()
            .filter(|term| tokens.iter().any(|t| t == *term))
            .count();
        if hits == 0 {
            continue;
        }
        if best.is_none_or(|(n, _)| hits > n) {
            best = Some((hits, line));
        }
    }
    let line = best.map(|(_, l)| l).unwrap_or("");
    line.trim().chars().take(180).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc<'a>(path: &'a str, title: &'a str, body: &'a str) -> Doc<'a> {
        Doc {
            path,
            title,
            kind: None,
            body,
        }
    }

    #[test]
    fn word_order_is_not_load_bearing() {
        // The headline defect: a contiguous-substring match scored this zero.
        let docs = vec![doc("a.md", "Onboarding", "the checklist for onboarding")];
        let out = rank("onboarding checklist", &docs, 20);
        assert_eq!(out.hits.len(), 1);
        assert!(!out.widened);
    }

    #[test]
    fn the_best_match_wins_rather_than_the_alphabetically_first() {
        // The other defect: entries arrive path-sorted and the old `break`
        // truncated in that order, so `archive/` could bury the real answer.
        let docs = vec![
            doc("archive/a.md", "Old notes", "a passing mention of pricing"),
            doc("archive/b.md", "Older notes", "pricing came up once"),
            doc(
                "work/pricing.md",
                "Pricing",
                "pricing tiers and pricing rules",
            ),
        ];
        let out = rank("pricing", &docs, 1);
        assert_eq!(docs[out.hits[0].index].path, "work/pricing.md");
    }

    #[test]
    fn a_title_hit_outranks_a_body_mention() {
        let docs = vec![
            doc(
                "a.md",
                "Meeting notes",
                "we discussed the beta at length, beta beta",
            ),
            doc("b.md", "Beta", "shipping soon"),
        ];
        let out = rank("beta", &docs, 20);
        assert_eq!(docs[out.hits[0].index].path, "b.md");
    }

    #[test]
    fn a_common_word_cannot_exclude_a_document() {
        // "what is at risk" is four tokens of which one means anything.
        // Requiring all four would answer nothing at all.
        let docs = vec![
            doc("a.md", "Risk register", "the schedule risk is open"),
            doc("b.md", "Notes", "what is at stake"),
        ];
        let out = rank("what is at risk", &docs, 20);
        assert_eq!(docs[out.hits[0].index].path, "a.md");
        assert!(!out.widened);
    }

    #[test]
    fn a_rare_term_still_excludes() {
        let docs = vec![
            doc("a.md", "Pricing", "tiers"),
            doc("b.md", "Shipping", "dates"),
        ];
        let out = rank("pricing tiers", &docs, 20);
        assert_eq!(out.hits.len(), 1);
        assert_eq!(docs[out.hits[0].index].path, "a.md");
    }

    #[test]
    fn nothing_matching_everything_widens_and_says_so() {
        // Better than "No notes matched": the caller is an agent that will
        // otherwise tell the user the vault holds nothing on the subject.
        // Both terms EXIST, just never together.
        let docs = vec![
            doc("a.md", "Pricing", "tiers"),
            doc("b.md", "Shipping", "dates"),
        ];
        let out = rank("pricing shipping", &docs, 20);
        assert_eq!(out.hits.len(), 2);
        assert!(out.widened);
    }

    #[test]
    fn a_term_no_note_holds_cannot_gate_the_ones_that_match() {
        // Requiring it would answer nothing, which is strictly worse than
        // answering what the vault does have.
        let docs = vec![doc("a.md", "Pricing", "tiers")];
        let out = rank("pricing unicorns", &docs, 20);
        assert_eq!(out.hits.len(), 1);
        assert!(!out.widened);
    }

    #[test]
    fn an_exact_phrase_is_a_bonus_and_never_a_gate() {
        let docs = vec![
            doc("a.md", "A", "release checklist is here"),
            doc("b.md", "B", "checklist for the release"),
        ];
        let out = rank("release checklist", &docs, 20);
        // Both match; the phrase wins the tie rather than dropping the other.
        assert_eq!(out.hits.len(), 2);
        assert_eq!(docs[out.hits[0].index].path, "a.md");
    }

    #[test]
    fn the_excerpt_is_the_line_that_answers_the_query() {
        let docs = vec![doc(
            "a.md",
            "Notes",
            "an unrelated opening line\nthe pricing tiers are annual only\nmore prose",
        )];
        let out = rank("pricing tiers", &docs, 20);
        assert_eq!(out.hits[0].excerpt, "the pricing tiers are annual only");
    }

    #[test]
    fn a_query_of_pure_punctuation_matches_nothing_rather_than_everything() {
        let docs = vec![doc("a.md", "A", "b")];
        assert!(rank("--- ???", &docs, 20).hits.is_empty());
    }

    #[test]
    fn ties_are_ordered_stably_so_two_identical_calls_agree() {
        let docs = vec![
            doc("z.md", "Same", "same words here"),
            doc("a.md", "Same", "same words here"),
        ];
        let first = rank("same words", &docs, 20);
        let second = rank("same words", &docs, 20);
        assert_eq!(
            first.hits.iter().map(|h| h.index).collect::<Vec<_>>(),
            second.hits.iter().map(|h| h.index).collect::<Vec<_>>()
        );
        assert_eq!(docs[first.hits[0].index].path, "a.md");
    }
}
