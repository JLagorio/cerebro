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
//! No index, deliberately. Measured on the demo vault: a full-corpus query
//! ~48 µs. The bodies come from `vault/corpus.rs` (M59.4), a stat-keyed cache
//! that reads each changed file once and never re-reads an unchanged one, so
//! search_notes and ⌘K's page-text search both rank data already in hand. An
//! index would be the first derived state that could not be recomputed,
//! which is the rule `engine/okf.ts` exists to hold; the corpus can always be
//! dropped and rebuilt from the disk.
//!
//! Where this stops being right: ranking still tokenizes every body on every
//! query, and that cost is unmeasured past the demo vault's notes. When it
//! shows, the thing to keep is each cached body's tokens, beside its text —
//! and still not an index.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};
use std::ops::Range;
use std::path::Path;

use serde_json::{Map, Value};

use crate::vault::corpus::{self, Corpus, CorpusCache};
use crate::vault::entry::Entry;

/// BM25's two knobs, at the values the literature settled on.
///
/// `K1` bounds how much a repeated term can keep helping; `B` is how hard to
/// penalise a long document for having more room to contain the term at all.
const K1: f32 = 1.2;
const B: f32 = 0.75;

/// A title match is worth three body matches, a type name two, and a
/// frontmatter value one and a half (M59.2).
///
/// Notes are SHORT here — median 46 words — so a single body hit is already a
/// large fraction of a document. Without field weighting a passing mention in
/// a long note outranks a note actually titled with the thing you asked for.
/// A frontmatter value sits between the two: a `description:` or a linked
/// owner was written about the note on purpose, which a passing mention was
/// not, but it is not what the note is called.
const TITLE_WEIGHT: f32 = 3.0;
const TYPE_WEIGHT: f32 = 2.0;
const META_WEIGHT: f32 = 1.5;

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

/// At most this many distinct words of a query are searched (M59.2). The
/// rest are counted, and the answer says how many were left out.
pub const MAX_TERMS: usize = 50;

/// Every word is cut to this many characters, not bytes (M59.2): the query's
/// words and the notes' alike, so a long word still finds the note holding
/// it, and the answer says how many were cut.
pub const MAX_TERM_CHARS: usize = 80;

/// The longest excerpt, in characters, its ellipses included (M59.2).
pub const EXCERPT_CHARS: usize = 240;

/// A long candidate's window: two characters short of the cap, for an
/// ellipsis at each cut end. It starts `WINDOW_LEAD` characters before its
/// match, and each cut end moves to whitespace within `SNAP_CHARS`.
const WINDOW_CHARS: usize = EXCERPT_CHARS - 2;
const WINDOW_LEAD: usize = 60;
const SNAP_CHARS: usize = 20;

/// The marks that open or close a quoted phrase: straight and curly.
const QUOTE_MARKS: [char; 3] = ['"', '\u{201C}', '\u{201D}'];

/// Page chrome, not page data: M55.11's `PAGE_CHROME_KEYS` in
/// src/engine/pageChrome.ts. searchable-values.json lists them, and both
/// replayers hold their own list equal to it.
pub const PAGE_CHROME_KEYS: [&str; 2] = ["icon", "cover"];

/// An Agent record's own notes (D7): what an agent remembers is never
/// searchable. Agent is a reserved type name (CV-08).
const AGENT_MEMORY_KEYS: [&str; 3] = ["recent", "memory", "preferences"];

pub struct Doc<'a> {
    pub path: &'a str,
    pub title: &'a str,
    pub kind: Option<&'a str>,
    /// The note's searchable frontmatter, as `searchable_fields` reads it.
    pub meta: &'a [MetaField],
    pub body: &'a str,
}

/// One frontmatter key's searchable text (M59.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaField {
    pub key: String,
    pub text: String,
}

/// One token of a text: its byte range in that text, and the run lowercased.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// A query, read once (M59.2).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Query {
    /// The distinct words searched, in query order: each cut to
    /// `MAX_TERM_CHARS`, and at most `MAX_TERMS` of them.
    pub terms: Vec<String>,
    /// Each quoted phrase of two or more words.
    pub phrases: Vec<Vec<String>>,
    /// The whole query as a phrase, when nothing is quoted and it holds two
    /// or more words.
    pub implicit: Option<Vec<String>>,
    /// How many distinct words the query held before the cap.
    pub distinct: usize,
    /// How many distinct words the cap left out.
    pub dropped: usize,
    /// How many distinct words were longer than `MAX_TERM_CHARS` and cut.
    pub cut: usize,
}

/// Where an excerpt came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExcerptAt {
    /// A line of the body get_note prints, counted from 1, so it is the
    /// number edit_note lists.
    Line(usize),
    /// A frontmatter key.
    Field(String),
}

/// The text that best answers a query, and where it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Excerpt {
    /// Original UTF-8 window within the chosen line or flattened field,
    /// before whitespace/chip/ellipsis normalization.
    pub raw_range: Range<usize>,
    /// Exact field chosen by the ranker; never guess among duplicate keys.
    pub field_index: Option<usize>,
    pub at: ExcerptAt,
    pub text: String,
    /// Byte ranges into `text`, each one a query term's token.
    pub ranges: Vec<Range<usize>>,
}

pub struct Hit {
    /// Index into the `docs` slice — the caller owns the entry, we only rank.
    pub index: usize,
    pub score: f32,
    /// The frontmatter field or body line holding the most distinct query
    /// terms, windowed to `EXCERPT_CHARS` with its matches marked; `None`
    /// when only the title or the type matched, and always under
    /// `Scope::Name`.
    pub excerpt: Option<Excerpt>,
    /// The query terms this note holds, in query order.
    pub matched: Vec<String>,
    /// The note holds every quoted phrase, or, with nothing quoted, the whole
    /// query as a phrase.
    pub phrase: bool,
}

#[derive(Default)]
pub struct Ranked {
    pub hits: Vec<Hit>,
    /// True when nothing contained every informative term and this is the
    /// widened, any-term answer. The caller says so rather than presenting a
    /// loose match as a tight one.
    pub widened: bool,
    /// How many notes matched before the limit cut them (M59.2), so the
    /// caller can say how many more there are.
    pub total: usize,
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

/// `tokenize`, with where each token sits (M59.2): each maximal run of
/// letters and digits, as its byte range in `text`, lowercased. The same
/// tokens `tokenize` gives, in the same order, which the tests hold over a
/// table and over the whole demo vault.
pub fn token_spans(text: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut open: Option<usize> = None;
    for (at, c) in text.char_indices() {
        if c.is_alphanumeric() {
            open.get_or_insert(at);
        } else if let Some(start) = open.take() {
            out.push(span(text, start, at));
        }
    }
    if let Some(start) = open {
        out.push(span(text, start, text.len()));
    }
    out
}

fn span(text: &str, start: usize, end: usize) -> Token {
    Token {
        start,
        end,
        text: text[start..end].to_lowercase(),
    }
}

/// `word` cut to `MAX_TERM_CHARS` characters.
pub fn cut_term(word: &str) -> &str {
    match word.char_indices().nth(MAX_TERM_CHARS) {
        Some((at, _)) => &word[..at],
        None => word,
    }
}

/// `tokenize`, each token cut as a query's words are.
fn words(text: &str) -> Vec<String> {
    tokenize(text)
        .into_iter()
        .map(|t| {
            // A token of 80 bytes or fewer cannot hold 81 characters.
            if t.len() > MAX_TERM_CHARS {
                cut_term(&t).to_string()
            } else {
                t
            }
        })
        .collect()
}

/// Read a query (M59.2): its words, capped and counted, and its phrases.
///
/// Text between two quote marks (`"`, `\u{201C}` or `\u{201D}`, paired in
/// order) is a phrase when it holds two or more words; one quoted word is a
/// plain word, and a mark left unclosed quotes nothing.
pub fn parse_query(raw: &str) -> Query {
    let tokens = tokenize(raw);
    let mut long: HashSet<&str> = HashSet::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut terms: Vec<String> = Vec::new();
    let mut all: Vec<String> = Vec::with_capacity(tokens.len());
    for token in &tokens {
        let word = cut_term(token);
        if word.len() < token.len() {
            long.insert(token);
        }
        if seen.insert(word) {
            terms.push(word.to_string());
        }
        all.push(word.to_string());
    }
    let distinct = terms.len();
    terms.truncate(MAX_TERMS);

    let marks: Vec<(usize, usize)> = raw
        .char_indices()
        .filter(|(_, c)| QUOTE_MARKS.contains(c))
        .map(|(at, c)| (at, at + c.len_utf8()))
        .collect();
    let mut phrases: Vec<Vec<String>> = Vec::new();
    for pair in marks.chunks_exact(2) {
        let phrase = words(&raw[pair[0].1..pair[1].0]);
        if phrase.len() >= 2 && !phrases.contains(&phrase) {
            phrases.push(phrase);
        }
    }
    let implicit = (phrases.is_empty() && all.len() >= 2).then_some(all);
    Query {
        terms,
        phrases,
        implicit,
        distinct,
        dropped: distinct.saturating_sub(MAX_TERMS),
        cut: long.len(),
    }
}

/// The texts one frontmatter value gives search (M59.2), by the rule
/// searchable-values.json states: a string trimmed (blank gives nothing), a
/// number in its shortest spelling (1.0 reads 1), a boolean as written, an
/// array item by item, and an object or null nothing.
pub fn searchable_values(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    push_values(value, &mut out);
    out
}

fn push_values(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
            }
        }
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push(i.to_string());
            } else if let Some(u) = n.as_u64() {
                out.push(u.to_string());
            } else if let Some(f) = n.as_f64() {
                out.push(f.to_string());
            }
        }
        Value::Bool(b) => out.push(b.to_string()),
        Value::Array(items) => {
            for item in items {
                push_values(item, out);
            }
        }
        Value::Object(_) | Value::Null => {}
    }
}

/// The frontmatter a note offers search (M59.2): properties in frontmatter
/// order, then relationships in key order, each key's texts joined with
/// ", ". Keys starting `_`, page chrome, an Agent record's memory, and a
/// `title` equal to the note's own give nothing. The one rule TS
/// `searchableFields` (src/engine/searchable.ts) applies too, held to this by
/// searchable-values.json.
pub fn searchable_fields(
    title: &str,
    entry_type: Option<&str>,
    properties: &Map<String, Value>,
    relationships: &BTreeMap<String, Vec<String>>,
) -> Vec<MetaField> {
    let agent = entry_type == Some("Agent");
    let withheld = |key: &str| {
        key.starts_with('_')
            || PAGE_CHROME_KEYS.contains(&key)
            || (agent && AGENT_MEMORY_KEYS.contains(&key))
    };
    let mut out = Vec::new();
    let mut push = |key: &str, texts: Vec<String>| {
        if texts.is_empty() {
            return;
        }
        let text = texts.join(", ");
        if key == "title" && text == title.trim() {
            return;
        }
        out.push(MetaField {
            key: key.to_string(),
            text,
        });
    };
    for (key, value) in properties {
        if !withheld(key) {
            push(key, searchable_values(value));
        }
    }
    for (key, targets) in relationships {
        if !withheld(key) {
            let texts = targets
                .iter()
                .map(|t| t.trim())
                .filter(|t| !t.is_empty())
                .map(str::to_string)
                .collect();
            push(key, texts);
        }
    }
    out
}

/// Conservative query-only alias: a precomposed character must canonically
/// decompose to an ASCII letter followed only by marks. Other scripts and
/// original source bytes stay unchanged; this is not general transliteration.
fn latin_alias(text: &str) -> Cow<'_, str> {
    if text.is_ascii() {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_ascii() {
            out.push(c);
            continue;
        }
        let mut decomposition = Vec::new();
        unicode_normalization::char::decompose_canonical(c, |part| decomposition.push(part));
        if decomposition.len() > 1
            && decomposition[0].is_ascii_alphabetic()
            && decomposition[1..]
                .iter()
                .all(|part| unicode_normalization::char::is_combining_mark(*part))
        {
            out.push(decomposition[0]);
        } else {
            out.push(c);
        }
    }
    if out == text {
        Cow::Borrowed(text)
    } else {
        Cow::Owned(out)
    }
}
fn fold_words(tokens: &mut [String]) -> bool {
    let mut changed = false;
    for token in tokens {
        if let Cow::Owned(alias) = latin_alias(token) {
            *token = alias;
            changed = true;
        }
    }
    changed
}
fn folded_query(query: &Query) -> Query {
    let mut folded = query.clone();
    fold_words(&mut folded.terms);
    let mut seen = HashSet::new();
    folded.terms.retain(|term| seen.insert(term.clone()));
    for phrase in &mut folded.phrases {
        fold_words(phrase);
    }
    if let Some(implicit) = &mut folded.implicit {
        fold_words(implicit);
    }
    folded
}

fn count(tokens: &[String], term: &str) -> f32 {
    tokens.iter().filter(|t| t.as_str() == term).count() as f32
}

/// True when `phrase` appears in `tokens` as a run, in order.
fn in_sequence(tokens: &[String], phrase: &[String]) -> bool {
    !phrase.is_empty() && tokens.windows(phrase.len()).any(|w| w == phrase)
}

/// One document's words, by field, tokenized once. Every score below reads
/// these, and re-splitting per term is what makes a naive implementation
/// quadratic in query length.
struct Fields {
    title: Vec<String>,
    kind: Vec<String>,
    meta: Vec<Vec<String>>,
    body: Vec<String>,
}

impl Fields {
    /// The fields `scope` searches, tokenized, `body` being the one
    /// `scoped_body` gives; a field it does not search is empty, so no score,
    /// gate, length or phrase below can read it.
    fn of(doc: &Doc, body: &str, scope: Scope) -> Self {
        let titled = scope != Scope::Content;
        let content = scope != Scope::Name;
        let read = |on: bool, text: &str| if on { words(text) } else { Vec::new() };
        Fields {
            title: read(titled, doc.title),
            kind: read(content, doc.kind.unwrap_or("")),
            meta: if content {
                doc.meta.iter().map(|m| words(&m.text)).collect()
            } else {
                Vec::new()
            },
            body: read(content, body),
        }
    }

    fn len(&self) -> f32 {
        (self.title.len()
            + self.kind.len()
            + self.meta.iter().map(Vec::len).sum::<usize>()
            + self.body.len()) as f32
    }

    fn has(&self, term: &str) -> bool {
        let holds = |tokens: &[String]| tokens.iter().any(|x| x == term);
        holds(&self.title)
            || holds(&self.kind)
            || self.meta.iter().any(|m| holds(m))
            || holds(&self.body)
    }

    fn tf(&self, term: &str) -> f32 {
        count(&self.body, term)
            + TITLE_WEIGHT * count(&self.title, term)
            + TYPE_WEIGHT * count(&self.kind, term)
            + META_WEIGHT * self.meta.iter().map(|m| count(m, term)).sum::<f32>()
    }

    /// A phrase lives inside one field: the title, one frontmatter value or
    /// the body. Never across two, where the words only happen to touch.
    fn holds(&self, phrase: &[String]) -> bool {
        in_sequence(&self.title, phrase)
            || self.meta.iter().any(|m| in_sequence(m, phrase))
            || in_sequence(&self.body, phrase)
    }
}

/// Rank `docs` against `query`, best first: `rank_query` over the query read
/// by `parse_query`.
pub fn rank(query: &str, docs: &[Doc], limit: usize) -> Ranked {
    rank_query(&parse_query(query), docs, limit)
}

/// Where a query matches (M59.5): search_notes' `in`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Titles only.
    Name,
    /// Everything except titles: the type, frontmatter and body.
    Content,
    /// Every field: what search_notes searched before it had a scope.
    All,
}

impl Scope {
    /// `name`, `content` or `all`, as search_notes' `in` spells them; any
    /// other word is no scope.
    pub fn parse(word: &str) -> Option<Scope> {
        match word {
            "name" => Some(Scope::Name),
            "content" => Some(Scope::Content),
            "all" => Some(Scope::All),
            _ => None,
        }
    }
}

/// The body `scope` searches (M59.5). Under `Scope::Content` the line that
/// holds the note's title, its first H1 when that reads as the title, is
/// emptied, so a title word never answers there; its newline stays, so every
/// other line keeps the number get_note prints. Every other scope reads the
/// body as it is.
fn scoped_body<'b>(doc: &Doc<'b>, scope: Scope) -> Cow<'b, str> {
    let body = doc.body;
    if scope != Scope::Content
        || crate::vault::parse::extract_h1_title(body).as_deref() != Some(doc.title)
    {
        return Cow::Borrowed(body);
    }
    let Some(start) = crate::vault::parse::first_h1_line_start(body) else {
        return Cow::Borrowed(body);
    };
    let end = body[start..].find('\n').map_or(body.len(), |at| start + at);
    Cow::Owned(format!("{}{}", &body[..start], &body[end..]))
}

/// Rank `docs` against a parsed query over every field, best first, keeping
/// `limit` hits and counting the rest in `total`: `rank_scoped` with
/// `Scope::All`.
pub fn rank_query(query: &Query, docs: &[Doc], limit: usize) -> Ranked {
    rank_scoped(query, docs, limit, Scope::All)
}

/// Rank `docs` against a parsed query over the fields `scope` searches
/// (M59.5), best first, keeping `limit` hits and counting the rest in
/// `total`. Document frequency, the gate, the score, the length and the
/// phrases all read the same fields, and the excerpt is chosen from them:
///
/// | scope   | title | type | frontmatter | body             | excerpt from      |
/// | ------- | ----- | ---- | ----------- | ---------------- | ----------------- |
/// | name    | yes   |      |             |                  | nothing (snippet) |
/// | content |       | yes  | yes         | but its title H1 | frontmatter, body |
/// | all     | yes   | yes  | yes         | yes              | frontmatter, body |
pub fn rank_scoped(query: &Query, docs: &[Doc], limit: usize, scope: Scope) -> Ranked {
    if query.terms.is_empty() || docs.is_empty() {
        return Ranked::default();
    }
    let bodies: Vec<Cow<str>> = docs.iter().map(|doc| scoped_body(doc, scope)).collect();
    let mut fields: Vec<Fields> = docs
        .iter()
        .zip(&bodies)
        .map(|(doc, body)| Fields::of(doc, body, scope))
        .collect();
    let mut ranked = score_fields(query, docs, &fields);
    let mut exact = vec![false; docs.len()];
    for hit in &ranked.hits {
        exact[hit.index] = true;
    }
    // Reuse the existing transient token allocation after exact scoring. Never
    // rescan the vault or normalize the source that locators/excerpts address.
    let mut changed = false;
    for field in &mut fields {
        changed |= fold_words(&mut field.title);
        changed |= fold_words(&mut field.kind);
        changed |= fold_words(&mut field.body);
        for meta in &mut field.meta {
            changed |= fold_words(meta);
        }
    }
    let folded = folded_query(query);
    if changed || folded.terms != query.terms {
        let aliases = score_fields(&folded, docs, &fields);
        if ranked.hits.is_empty() {
            ranked.widened = aliases.widened;
        }
        for mut hit in aliases.hits {
            if exact[hit.index] {
                continue;
            }
            ranked.widened |= aliases.widened;
            hit.matched = query
                .terms
                .iter()
                .filter(|term| {
                    hit.matched
                        .iter()
                        .any(|matched| matched == latin_alias(term).as_ref())
                })
                .cloned()
                .collect();
            ranked.hits.push(hit);
        }
    }
    ranked.total = ranked.hits.len();
    ranked.hits.truncate(limit);
    if scope != Scope::Name {
        for hit in &mut ranked.hits {
            hit.excerpt = if exact[hit.index] {
                excerpt(docs[hit.index].meta, &bodies[hit.index], &query.terms)
            } else {
                excerpt_matching(
                    docs[hit.index].meta,
                    &bodies[hit.index],
                    &folded.terms,
                    true,
                )
            };
        }
    }
    ranked
}

/// The existing BM25/phrase scorer, over one already tokenized interpretation.
/// Its exact pass remains the first tier without score or order changes.
fn score_fields(query: &Query, docs: &[Doc], fields: &[Fields]) -> Ranked {
    let terms = &query.terms;
    let n = docs.len() as f32;
    let lengths: Vec<f32> = fields.iter().map(Fields::len).collect();
    let avgdl = (lengths.iter().sum::<f32>() / n).max(1.0);

    // Document frequency per term, over the fields a term can be found in.
    let df: Vec<f32> = terms
        .iter()
        .map(|term| fields.iter().filter(|f| f.has(term)).count() as f32)
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

    let quoted = !query.phrases.is_empty();
    let scored = |strict: bool| -> Vec<Hit> {
        let mut hits: Vec<Hit> = Vec::new();
        for (i, f) in fields.iter().enumerate() {
            let mut score = 0.0f32;
            let mut matched: Vec<String> = Vec::new();
            for (t, term) in terms.iter().enumerate() {
                if df[t] == 0.0 {
                    continue;
                }
                let tf = f.tf(term);
                if tf == 0.0 {
                    continue;
                }
                matched.push(term.clone());
                let idf = ((n - df[t] + 0.5) / (df[t] + 0.5) + 1.0).ln();
                let norm = K1 * (1.0 - B + B * lengths[i] / avgdl);
                score += idf * (tf * (K1 + 1.0)) / (tf + norm);
            }
            if matched.is_empty() {
                continue;
            }
            if strict && !required.iter().all(|&r| f.has(&terms[r])) {
                continue;
            }
            // A phrase is a run of words inside one field. A quoted phrase is
            // what the caller said they meant, so notes holding every one rank
            // first; with nothing quoted, the whole query read as a phrase
            // earns ×1.5. Neither gates: a note with the words apart still
            // answers (M17.19), just lower.
            let phrase = if quoted {
                query.phrases.iter().all(|p| f.holds(p))
            } else {
                query.implicit.as_deref().is_some_and(|p| f.holds(p))
            };
            if phrase && !quoted {
                score *= 1.5;
            }
            hits.push(Hit {
                index: i,
                score,
                excerpt: None,
                matched,
                phrase,
            });
        }
        // Ties broken by path so the answer is stable between identical calls;
        // an unstable order makes a tool look like it is guessing.
        hits.sort_by(|a, b| {
            let phrase_first = if quoted {
                b.phrase.cmp(&a.phrase)
            } else {
                std::cmp::Ordering::Equal
            };
            phrase_first
                .then_with(|| {
                    b.score
                        .partial_cmp(&a.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| docs[a.index].path.cmp(docs[b.index].path))
        });
        hits
    };

    let strict = scored(true);
    let (hits, widened) = if strict.is_empty() {
        (scored(false), true)
    } else {
        (strict, false)
    };
    Ranked {
        total: hits.len(),
        hits,
        widened,
    }
}

/// How many distinct `terms` `text` holds.
fn distinct_held(text: &str, terms: &[String], aliases: bool) -> usize {
    let mut tokens = words(text);
    if aliases {
        fold_words(&mut tokens);
    }
    terms
        .iter()
        .filter(|term| tokens.iter().any(|t| t == *term))
        .count()
}

/// The excerpt that best answers `terms`, in two steps (M59.2).
///
/// First the candidate: each frontmatter field in order, then each line of
/// `body` counted from 1. The one holding the most distinct terms wins — the
/// answer, not the first mention of it — and ties go to the earlier, which
/// puts a matching `description:` ahead of the body and a note's own summary
/// ahead of its later lines. No candidate holding a term gives `None`. Then
/// the window, `excerpt_window`.
pub fn excerpt(meta: &[MetaField], body: &str, terms: &[String]) -> Option<Excerpt> {
    excerpt_matching(meta, body, terms, false)
}

fn excerpt_matching(
    meta: &[MetaField],
    body: &str,
    terms: &[String],
    aliases: bool,
) -> Option<Excerpt> {
    let mut best: Option<(usize, ExcerptAt, &str, Option<usize>)> = None;
    let fields = meta.iter().enumerate().map(|(index, m)| {
        (
            ExcerptAt::Field(m.key.clone()),
            m.text.as_str(),
            Some(index),
        )
    });
    let lines = body
        .lines()
        .enumerate()
        .map(|(i, line)| (ExcerptAt::Line(i + 1), line, None));
    for (at, text, field_index) in fields.chain(lines) {
        let held = distinct_held(text, terms, aliases);
        if held > 0 && best.as_ref().is_none_or(|(most, _, _, _)| held > *most) {
            best = Some((held, at, text, field_index));
        }
    }
    let (_, at, text, field_index) = best?;
    let (text, ranges, raw_range) = excerpt_window_matching(text, terms, aliases);
    Some(Excerpt {
        at,
        text,
        ranges,
        raw_range,
        field_index,
    })
}

/// Invisible characters an excerpt drops (M59.2): soft hyphen, combining
/// grapheme joiner, Arabic letter mark, the zero-width and direction
/// controls, the line and paragraph separators, word joiners and invisible
/// operators, the byte-order mark and the blank Braille pattern.
fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{200B}'..='\u{200F}'
            | '\u{2028}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{2800}'
    )
}

/// `text` cut to at most `EXCERPT_CHARS` characters around its matches, with
/// the byte range of each query term's token in the result (M59.2).
///
/// Text of `EXCERPT_CHARS` or fewer is kept whole. Longer text keeps the
/// `WINDOW_CHARS` window, starting `WINDOW_LEAD` before a match, that holds
/// the most distinct terms (ties: the earliest), with each cut end moved to
/// whitespace within `SNAP_CHARS`. Either way invisible characters go,
/// whitespace runs collapse to one space, the ends are trimmed, and each cut
/// end gains an ellipsis. Ranges fall on token boundaries.
pub fn excerpt_window(text: &str, terms: &[String]) -> (String, Vec<Range<usize>>) {
    let (text, ranges, _) = excerpt_window_raw(text, terms);
    (text, ranges)
}

fn excerpt_window_raw(text: &str, terms: &[String]) -> (String, Vec<Range<usize>>, Range<usize>) {
    excerpt_window_matching(text, terms, false)
}

fn excerpt_window_matching(
    text: &str,
    terms: &[String],
    aliases: bool,
) -> (String, Vec<Range<usize>>, Range<usize>) {
    let matches: Vec<Token> = token_spans(text)
        .into_iter()
        .map(|mut token| {
            if aliases {
                token.text = latin_alias(&token.text).into_owned();
            }
            token
        })
        .filter(|t| terms.iter().any(|term| term == cut_term(&t.text)))
        .collect();
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let n = chars.len();
    let byte_at = |ci: usize| chars.get(ci).map_or(text.len(), |(at, _)| *at);
    let char_at = |byte: usize| chars.partition_point(|(at, _)| *at < byte);

    let (mut from, mut to) = (0, n);
    if n > EXCERPT_CHARS {
        let mut best: Option<(usize, usize)> = None;
        for m in &matches {
            // A match near the end keeps a full window, reaching back.
            let start = char_at(m.start)
                .saturating_sub(WINDOW_LEAD)
                .min(n - WINDOW_CHARS);
            let (lo, hi) = (byte_at(start), byte_at(start + WINDOW_CHARS));
            let mut inside: Vec<&str> = matches
                .iter()
                .filter(|t| lo <= t.start && t.end <= hi)
                .map(|t| cut_term(&t.text))
                .collect();
            inside.sort_unstable();
            inside.dedup();
            if best.is_none_or(|(most, _)| inside.len() > most) {
                best = Some((inside.len(), start));
            }
        }
        from = best.map_or(0, |(_, start)| start);
        to = (from + WINDOW_CHARS).min(n);
        if from > 0 && !chars[from - 1].1.is_whitespace() {
            if let Some(k) =
                (from..(from + SNAP_CHARS).min(to)).find(|&k| chars[k].1.is_whitespace())
            {
                from = k + 1;
            }
        }
        if to < n && !chars[to].1.is_whitespace() {
            if let Some(k) = (from.max(to.saturating_sub(SNAP_CHARS))..to)
                .rev()
                .find(|&k| chars[k].1.is_whitespace())
            {
                to = k;
            }
        }
    }

    let (lo, hi) = (byte_at(from), byte_at(to));
    let mut out = String::new();
    // Where each kept character of the window landed: (its byte in `text`,
    // its byte in `out`).
    let mut landed: Vec<(usize, usize)> = Vec::new();
    let mut space = false;
    for (at, c) in text[lo..hi].char_indices() {
        if invisible(c) {
            continue;
        }
        if c.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        landed.push((lo + at, out.len()));
        out.push(c);
    }
    let lead = if from > 0 { "\u{2026}" } else { "" };
    // A token is letters and digits only, so every one of its characters was
    // kept, side by side: its start lands, and its length carries over.
    let ranges: Vec<Range<usize>> = matches
        .iter()
        .filter(|t| lo <= t.start && t.end <= hi)
        .filter_map(|t| {
            let i = landed.binary_search_by_key(&t.start, |(at, _)| *at).ok()?;
            let start = lead.len() + landed[i].1;
            Some(start..start + (t.end - t.start))
        })
        .collect();
    let mut shown = format!("{lead}{out}");
    if to < n {
        shown.push('\u{2026}');
    }
    (shown, ranges, lo..hi)
}

// --- The corpus, shared by both searches (M59.4) ---------------------------

/// The notes of a corpus a search keeps, ready to rank: each kept entry,
/// its body and its searchable frontmatter, plus how many kept bodies were
/// cut at `SEARCH_BODY_CAP`.
pub struct Kept<'a> {
    pub entries: Vec<&'a Entry>,
    bodies: Vec<&'a str>,
    sources: Vec<Option<&'a crate::source_location::SourceSnapshot>>,
    metas: Vec<Vec<MetaField>>,
    /// How many kept notes were longer than `SEARCH_BODY_CAP` and were
    /// searched in their first `SEARCH_BODY_CAP` bytes.
    pub capped: usize,
}

impl Kept<'_> {
    /// The kept notes as `rank_query` reads them; `docs()[i]` is
    /// `entries[i]`.
    pub fn docs(&self) -> Vec<Doc<'_>> {
        self.entries
            .iter()
            .zip(&self.bodies)
            .zip(&self.metas)
            .map(|((e, body), meta)| Doc {
                path: &e.path,
                title: &e.title,
                kind: e.entry_type.as_deref(),
                meta,
                body,
            })
            .collect()
    }
}

/// The corpus notes `keep` keeps, as search reads them: search_notes keeps
/// its read scope and type, and ⌘K keeps every note. One builder, so the two
/// rank the same text the same way.
pub fn docs_of(corpus: &Corpus, keep: impl Fn(&Entry) -> bool) -> Kept<'_> {
    let mut kept = Kept {
        entries: Vec::new(),
        bodies: Vec::new(),
        sources: Vec::new(),
        metas: Vec::new(),
        capped: 0,
    };
    for (entry, text) in corpus.entries.iter().zip(&corpus.texts) {
        if !keep(entry) {
            continue;
        }
        kept.metas
            .push(text.search_fields.clone().unwrap_or_else(|| {
                searchable_fields(
                    &entry.title,
                    entry.entry_type.as_deref(),
                    &entry.properties,
                    &entry.relationships,
                )
            }));
        kept.entries.push(entry);
        kept.bodies.push(&text.body);
        kept.sources.push(text.source.as_ref());
        if text.capped {
            kept.capped += 1;
        }
    }
    kept
}

/// One run of an excerpt as ⌘K draws it: marked when it is a query term.
/// Offsets never cross IPC; the webview draws these parts as text.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcerptPart {
    pub text: String,
    pub mark: bool,
}

/// One ⌘K page-text hit.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultHit {
    pub path: String,
    pub title: String,
    #[serde(rename = "type")]
    pub entry_type: Option<String>,
    pub parts: Vec<ExcerptPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<crate::source_location::SourceLocator>,
}

/// ⌘K's page-text answer: the best hits, how many matched in all, whether
/// nothing held every word, and how many long notes were searched in part.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSearch {
    pub hits: Vec<VaultHit>,
    pub total: usize,
    pub widened: bool,
    pub capped: usize,
}

/// The most hits ⌘K asks for.
pub const VAULT_SEARCH_MAX: usize = 50;

/// `line` as a person reads it (M59.4): chip syntax becomes the words a
/// chip shows, footnote marks go, and a leading heading, quote, list or
/// task marker goes. `@[[p]]` reads `@p`, `[[t|a]]` reads `a`, `[[t#s]]`
/// reads `t › s`, `[[#s]]` reads `s` and `[[t]]` reads `t`. An unclosed
/// bracket stays as written. ⌘K shows these; search_notes keeps the raw
/// line, so an agent can follow the links.
pub fn display_line(line: &str) -> String {
    let rest = strip_markers(line);
    let mut out = String::with_capacity(rest.len());
    let mut at = 0;
    while at < rest.len() {
        let tail = &rest[at..];
        let (mention, open) = if tail.starts_with("@[[") {
            (true, 3)
        } else if tail.starts_with("![[") {
            (false, 3)
        } else if tail.starts_with("[[") {
            (false, 2)
        } else {
            (false, 0)
        };
        if open > 0 {
            if let Some(close) = tail[open..].find("]]") {
                if mention {
                    out.push('@');
                }
                out.push_str(&chip_label(&tail[open..open + close]));
                at += open + close + 2;
                continue;
            }
        }
        if let Some(note) = tail.strip_prefix("[^") {
            if let Some(close) = note.find(']') {
                let id = &note[..close];
                if !id.is_empty() && !id.contains(char::is_whitespace) {
                    at += 2 + close + 1;
                    continue;
                }
            }
        }
        let c = tail.chars().next().expect("at is inside rest");
        out.push(c);
        at += c.len_utf8();
    }
    out
}

/// What a chip shows for the text between its brackets.
fn chip_label(inner: &str) -> String {
    if let Some((_, alias)) = inner.split_once('|') {
        return alias.trim().to_string();
    }
    match inner.split_once('#') {
        Some(("", section)) => section.trim().to_string(),
        Some((target, section)) => format!("{} \u{203A} {}", target.trim(), section.trim()),
        None => inner.trim().to_string(),
    }
}

/// `line` without its leading markers: quote marks, a heading's hashes, a
/// footnote definition's `[^id]:`, a list bullet or number, and a task box.
fn strip_markers(line: &str) -> &str {
    let mut rest = line.trim_start();
    while let Some(after) = rest.strip_prefix('>') {
        rest = after.trim_start();
    }
    let hashes = rest.len() - rest.trim_start_matches('#').len();
    if hashes > 0
        && rest[hashes..]
            .chars()
            .next()
            .is_none_or(char::is_whitespace)
    {
        rest = rest[hashes..].trim_start();
    }
    if let Some(note) = rest.strip_prefix("[^") {
        if let Some(close) = note.find("]:") {
            if !note[..close].contains(char::is_whitespace) {
                rest = note[close + 2..].trim_start();
            }
        }
    }
    let bullet = ["- ", "* ", "+ "].iter().find_map(|b| rest.strip_prefix(b));
    if let Some(after) = bullet {
        rest = after.trim_start();
    } else {
        let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        let after = &rest[digits..];
        if digits > 0 && (after.starts_with(". ") || after.starts_with(") ")) {
            rest = after[2..].trim_start();
        }
    }
    for task in ["[ ] ", "[x] ", "[X] "] {
        if let Some(after) = rest.strip_prefix(task) {
            rest = after.trim_start();
            break;
        }
    }
    rest
}

/// `text` split at `ranges` into marked and unmarked parts.
fn split_parts(text: &str, ranges: &[Range<usize>]) -> Vec<ExcerptPart> {
    let mut parts: Vec<ExcerptPart> = Vec::new();
    let mut push = |piece: &str, mark: bool| {
        if piece.is_empty() {
            return;
        }
        match parts.last_mut() {
            Some(last) if last.mark == mark => last.text.push_str(piece),
            _ => parts.push(ExcerptPart {
                text: piece.to_string(),
                mark,
            }),
        }
    };
    let mut at = 0;
    for range in ranges {
        if range.start < at {
            continue;
        }
        push(&text[at..range.start], false);
        push(&text[range.clone()], true);
        at = range.end;
    }
    push(&text[at..], false);
    parts
}

/// A hit's excerpt as ⌘K draws it (M59.4): the line `rank_query` chose, as
/// `display_line` reads it, windowed by `excerpt_window` with its terms
/// marked. A frontmatter hit leads with its key, unmarked. A hit only its
/// title or type answered shows the note's snippet, unmarked.
pub fn excerpt_parts(doc: &Doc, hit: &Hit, terms: &[String], snippet: &str) -> Vec<ExcerptPart> {
    let raw = hit.excerpt.as_ref().and_then(|excerpt| match &excerpt.at {
        ExcerptAt::Line(n) => doc.body.lines().nth(n - 1).map(|line| (None, line)),
        ExcerptAt::Field(key) => doc
            .meta
            .iter()
            .find(|m| &m.key == key)
            .map(|m| (Some(key.as_str()), m.text.as_str())),
    });
    let Some((key, raw)) = raw else {
        let snippet = snippet.trim();
        return split_parts(snippet, &[]);
    };
    let (text, ranges) = excerpt_window(&display_line(raw), terms);
    let mut parts = Vec::new();
    if let Some(key) = key {
        parts.push(ExcerptPart {
            text: format!("{key}: "),
            mark: false,
        });
    }
    parts.extend(split_parts(&text, &ranges));
    parts
}

/// Translate the retained raw window to a body range without searching the
/// normalized display text. Line numbering also survives the content scope's
/// removal of the projected title line's text.
fn source_location(
    vault_id: &str,
    kept: &Kept<'_>,
    hit: &Hit,
) -> Option<crate::source_location::SourceLocator> {
    let snapshot = kept.sources[hit.index]?;
    let excerpt = hit.excerpt.as_ref()?;
    let entry = kept.entries[hit.index];
    let (text, range, key) = match &excerpt.at {
        ExcerptAt::Line(number) => {
            let body = kept.bodies[hit.index];
            let line = body.lines().nth(number.checked_sub(1)?)?;
            let start = line.as_ptr() as usize - body.as_ptr() as usize;
            (
                body,
                start + excerpt.raw_range.start..start + excerpt.raw_range.end,
                None,
            )
        }
        ExcerptAt::Field(key) => {
            // A selected property is canonical metadata, never body YAML. Its
            // revision-bearing locator is a separate, still unsupported carrier.
            if entry.authority.is_some() {
                return None;
            }
            let field = kept.metas[hit.index].get(excerpt.field_index?)?;
            (
                field.text.as_str(),
                excerpt.raw_range.clone(),
                Some(key.as_str()),
            )
        }
    };
    crate::source_location::locate_window(vault_id, &entry.path, snapshot, text, range, key)
}

/// ⌘K's page-text search (M59.4): every note in the vault's corpus, ranked
/// by `rank_query` exactly as search_notes ranks, `limit` clamped to
/// 1..=`VAULT_SEARCH_MAX`. It does no ledger, knowledge or label work: it
/// runs on a pause in typing.
pub fn vault_search(vault: &Path, query: &str, limit: usize) -> Result<VaultSearch, String> {
    vault_search_in(corpus::shared(), vault, query, limit)
}

/// `vault_search` over `cache`: the app passes the shared cache, a test its
/// own.
pub fn vault_search_in(
    cache: &CorpusCache,
    vault: &Path,
    query: &str,
    limit: usize,
) -> Result<VaultSearch, String> {
    let limit = limit.clamp(1, VAULT_SEARCH_MAX);
    let vault_id = crate::runtime::scope::derive_vault_id(vault);
    let corpus = cache.search_snapshot(vault)?;
    let kept = docs_of(&corpus, |_| true);
    let docs = kept.docs();
    let parsed = parse_query(query);
    let ranked = rank_query(&parsed, &docs, limit);
    Ok(vault_search_result(&vault_id, &kept, &parsed, &ranked))
}

/// Build from the ranked, retained snapshot; no disk reads belong here.
fn vault_search_result(
    vault_id: &str,
    kept: &Kept<'_>,
    parsed: &Query,
    ranked: &Ranked,
) -> VaultSearch {
    let docs = kept.docs();
    let hits = ranked
        .hits
        .iter()
        .map(|hit| {
            let entry = kept.entries[hit.index];
            VaultHit {
                path: entry.path.clone(),
                title: entry.title.clone(),
                entry_type: entry.entry_type.clone(),
                parts: excerpt_parts(&docs[hit.index], hit, &parsed.terms, &entry.snippet),
                location: source_location(vault_id, kept, hit),
            }
        })
        .collect();
    VaultSearch {
        hits,
        total: ranked.total,
        widened: ranked.widened,
        capped: kept.capped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc<'a>(path: &'a str, title: &'a str, body: &'a str) -> Doc<'a> {
        Doc {
            path,
            title,
            kind: None,
            meta: &[],
            body,
        }
    }

    fn with_meta<'a>(
        path: &'a str,
        title: &'a str,
        meta: &'a [MetaField],
        body: &'a str,
    ) -> Doc<'a> {
        Doc {
            path,
            title,
            kind: None,
            meta,
            body,
        }
    }

    fn field(key: &str, text: &str) -> MetaField {
        MetaField {
            key: key.to_string(),
            text: text.to_string(),
        }
    }

    fn paths<'a>(out: &Ranked, docs: &'a [Doc]) -> Vec<&'a str> {
        out.hits.iter().map(|h| docs[h.index].path).collect()
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
        let excerpt = out.hits[0].excerpt.as_ref().expect("an excerpt");
        assert_eq!(excerpt.text, "the pricing tiers are annual only");
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

    // --- token spans (M59.2) ---------------------------------------------

    /// Texts where a careless span walk and `tokenize` could part ways:
    /// case folding that changes length, scripts without spaces, marks and
    /// invisible characters inside a word, and line endings.
    const SPAN_TABLE: &[&str] = &[
        "",
        "--- ??? ...",
        "\u{130}stanbul calling",
        "Stra\u{df}e und STRASSE",
        "\u{6771}\u{4EAC} \u{5927}\u{962A}",
        "launch \u{1F680} day",
        "zero\u{200B}width",
        "cafe\u{301} au lait",
        "v2 build 2026-10-14",
        "snake_case and kebab-case",
        "line one\r\nline two\r\n",
    ];

    #[test]
    fn token_spans_give_the_tokens_tokenize_gives() {
        for text in SPAN_TABLE {
            let spans: Vec<String> = token_spans(text).into_iter().map(|t| t.text).collect();
            assert_eq!(spans, tokenize(text), "{text:?}");
        }
        assert!(token_spans("").is_empty());
        assert!(token_spans("--- ??? ...").is_empty());
        let words: Vec<String> = token_spans("snake_case")
            .into_iter()
            .map(|t| t.text)
            .collect();
        assert_eq!(words, ["snake", "case"]);
    }

    #[test]
    fn token_spans_agree_with_tokenize_over_the_demo_vault() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../demo-vault");
        let mut read = 0;
        for item in walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_map(Result::ok)
        {
            let path = item.path();
            let note = matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("md") | Some("mmd")
            );
            if !item.file_type().is_file() || !note {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(path) else {
                continue;
            };
            let spans: Vec<String> = token_spans(&text).into_iter().map(|t| t.text).collect();
            assert_eq!(spans, tokenize(&text), "{}", path.display());
            read += 1;
        }
        assert!(read > 20, "the demo vault was read: {read} files");
    }

    #[test]
    fn each_span_slices_its_token() {
        for text in SPAN_TABLE {
            for token in token_spans(text) {
                assert_eq!(
                    text[token.start..token.end].to_lowercase(),
                    token.text,
                    "{text:?}"
                );
            }
        }
    }

    // --- queries (M59.2) -------------------------------------------------

    #[test]
    fn fifty_distinct_words_are_searched_and_the_rest_counted() {
        let raw: Vec<String> = (0..60).map(|i| format!("w{i}")).collect();
        let query = parse_query(&format!("{} w0 w1", raw.join(" ")));
        assert_eq!(query.terms.len(), MAX_TERMS);
        assert_eq!(query.terms[0], "w0");
        assert_eq!(query.distinct, 60);
        assert_eq!(query.dropped, 10);
        let fifty = parse_query(&raw[..50].join(" "));
        assert_eq!((fifty.distinct, fifty.dropped), (50, 0));
    }

    #[test]
    fn a_long_word_is_cut_to_80_characters_not_bytes() {
        let long = "\u{e9}".repeat(120);
        let query = parse_query(&format!("{long} short {long}"));
        assert_eq!(query.terms[0].chars().count(), MAX_TERM_CHARS);
        assert_eq!(query.terms[0].len(), 2 * MAX_TERM_CHARS);
        assert_eq!(query.cut, 1);
        // And the note holding the whole word is still found by it.
        let body = format!("it says {long} here");
        let docs = vec![doc("a.md", "A", &body)];
        assert_eq!(rank_query(&query, &docs, 20).hits.len(), 1);
    }

    fn release_docs() -> Vec<Doc<'static>> {
        vec![
            doc(
                "a.md",
                "Notes",
                "the release checklist lives here, among many other words about \
                 meetings, budgets, hiring plans, vendors and the office move",
            ),
            doc(
                "b.md",
                "Release",
                "checklist for the release; again a checklist, release again",
            ),
        ]
    }

    #[test]
    fn a_quoted_phrase_ranks_first_over_a_stronger_score() {
        let docs = release_docs();
        // Unquoted, the note titled with the word scores higher.
        let loose = rank("release checklist", &docs, 20);
        assert_eq!(paths(&loose, &docs), ["b.md", "a.md"]);
        // Quoted, the note holding the phrase comes first all the same.
        let quoted = rank("\"release checklist\"", &docs, 20);
        assert_eq!(paths(&quoted, &docs), ["a.md", "b.md"]);
        assert!(quoted.hits[0].phrase && !quoted.hits[1].phrase);
        assert!(quoted.hits[1].score > quoted.hits[0].score);
    }

    #[test]
    fn a_quoted_phrase_never_gates() {
        let docs = release_docs();
        let quoted = rank("\"release checklist\"", &docs, 20);
        assert_eq!(quoted.hits.len(), 2);
        assert_eq!(quoted.total, 2);
        assert!(!quoted.widened);
    }

    #[test]
    fn curly_quotes_quote_too() {
        let query = parse_query("\u{201C}release checklist\u{201D} owner");
        assert_eq!(query.phrases, [["release", "checklist"]]);
        assert_eq!(query.implicit, None);
        let docs = release_docs();
        let out = rank("\u{201C}release checklist\u{201D}", &docs, 20);
        assert_eq!(paths(&out, &docs), ["a.md", "b.md"]);
    }

    #[test]
    fn an_unclosed_quote_quotes_nothing() {
        let query = parse_query("\"release checklist");
        assert!(query.phrases.is_empty());
        assert_eq!(query.terms, ["release", "checklist"]);
        assert_eq!(
            query.implicit.as_deref(),
            Some(&["release".to_string(), "checklist".to_string()][..])
        );
    }

    #[test]
    fn a_single_quoted_word_is_a_plain_term() {
        let query = parse_query("\"release\" notes");
        assert!(query.phrases.is_empty());
        assert_eq!(query.terms, ["release", "notes"]);
    }

    #[test]
    fn a_phrase_never_spans_two_fields() {
        let meta = [field("status", "draft release"), field("tags", "checklist")];
        let docs = vec![
            with_meta("a.md", "Release", &meta, "checklist below"),
            doc("b.md", "Other", "release checklist"),
        ];
        let out = rank("\"release checklist\"", &docs, 20);
        assert_eq!(paths(&out, &docs), ["b.md", "a.md"]);
        assert!(!out.hits[1].phrase, "title|body and field|field never join");
    }

    // --- ranking by field (M59.2) ---------------------------------------

    #[test]
    fn a_title_hit_outranks_a_frontmatter_hit_which_outranks_a_body_hit() {
        let meta = [field("status", "beta")];
        let docs = vec![
            doc("body.md", "Delta", "beta one two"),
            with_meta("meta.md", "Gamma", &meta, "one two"),
            doc("title.md", "Beta", "one two three"),
        ];
        let out = rank("beta", &docs, 20);
        assert_eq!(paths(&out, &docs), ["title.md", "meta.md", "body.md"]);
    }

    #[test]
    fn a_relationship_target_is_searchable() {
        let mut relationships = BTreeMap::new();
        relationships.insert("owner".to_string(), vec!["maya-chen".to_string()]);
        let meta = searchable_fields("Vendor delay", Some("Risk"), &Map::new(), &relationships);
        let docs = vec![
            with_meta("risk.md", "Vendor delay", &meta, "The vendor slipped."),
            doc("other.md", "Other", "nothing here"),
        ];
        let out = rank("maya", &docs, 20);
        assert_eq!(paths(&out, &docs), ["risk.md"]);
        let excerpt = out.hits[0].excerpt.as_ref().expect("an excerpt");
        assert_eq!(excerpt.at, ExcerptAt::Field("owner".into()));
        assert_eq!(excerpt.text, "maya-chen");
    }

    #[test]
    fn the_total_counts_matches_past_the_limit() {
        let docs: Vec<Doc> = ["a.md", "b.md", "c.md", "d.md", "e.md"]
            .iter()
            .map(|p| doc(p, "Note", "pricing tiers"))
            .collect();
        let strict = rank("pricing", &docs, 2);
        assert_eq!(
            (strict.hits.len(), strict.total, strict.widened),
            (2, 5, false)
        );

        let docs = vec![
            doc("a.md", "Pricing", "tiers"),
            doc("b.md", "Shipping", "dates"),
            doc("c.md", "Pricing again", "more"),
        ];
        let widened = rank("pricing shipping", &docs, 1);
        assert_eq!(
            (widened.hits.len(), widened.total, widened.widened),
            (1, 3, true)
        );
    }

    // --- excerpts (M59.2) ------------------------------------------------

    /// A line of `chars` characters holding `word` at character `at`.
    fn line_with(word: &str, at: usize, chars: usize) -> String {
        let mut line = String::new();
        while line.chars().count() < at {
            line.push_str("abcde ");
        }
        let mut line: String = line.chars().take(at - 1).collect();
        line.push(' ');
        line.push_str(word);
        while line.chars().count() < chars {
            line.push_str(" abcde");
        }
        line.chars().take(chars).collect()
    }

    fn sliced(excerpt: &Excerpt) -> Vec<String> {
        excerpt
            .ranges
            .iter()
            .map(|r| excerpt.text[r.clone()].to_lowercase())
            .collect()
    }

    #[test]
    fn a_long_line_is_windowed_around_its_match() {
        let line = line_with("target", 400, 600);
        assert_eq!(line.chars().count(), 600);
        assert_eq!(line.find("target"), Some(400));
        let excerpt = excerpt(&[], &line, &["target".to_string()]).expect("an excerpt");
        assert!(
            excerpt.text.chars().count() <= EXCERPT_CHARS,
            "{}",
            excerpt.text
        );
        assert!(excerpt.text.starts_with('\u{2026}'));
        assert!(excerpt.text.ends_with('\u{2026}'));
        assert!(excerpt.text.contains("target"));
        assert_eq!(sliced(&excerpt), ["target"]);
        assert_eq!(excerpt.at, ExcerptAt::Line(1));
    }

    #[test]
    fn the_window_holds_the_most_distinct_terms() {
        let mut line = line_with("alpha", 10, 300);
        line.push_str(" alpha beta ");
        line.push_str(&"abcde ".repeat(50));
        let terms = ["alpha".to_string(), "beta".to_string()];
        let excerpt = excerpt(&[], &line, &terms).expect("an excerpt");
        let mut held = sliced(&excerpt);
        held.dedup();
        assert!(held.contains(&"alpha".to_string()) && held.contains(&"beta".to_string()));
        assert!(
            excerpt.text.starts_with('\u{2026}'),
            "the late pair, not the early word"
        );
    }

    #[test]
    fn every_range_slices_a_query_term() {
        let terms = ["pricing".to_string(), "tiers".to_string()];
        for text in [
            "Pricing tiers: PRICING, tiers and pricing.".to_string(),
            line_with("pricing tiers", 300, 700),
            format!("{} pricing", "tiers ".repeat(80)),
        ] {
            let excerpt = excerpt(&[], &text, &terms).expect("an excerpt");
            assert!(!excerpt.ranges.is_empty());
            for word in sliced(&excerpt) {
                assert!(terms.contains(&word), "{word:?} in {:?}", excerpt.text);
            }
        }
    }

    #[test]
    fn invisible_characters_leave_the_excerpt_and_ranges_still_slice() {
        let line = "the\u{200B} pricing\u{00AD}tiers \u{FEFF}are   annual \u{2028}only \u{2800}";
        let terms = ["pricing".to_string(), "tiers".to_string()];
        let excerpt = excerpt(&[], line, &terms).expect("an excerpt");
        assert_eq!(excerpt.text, "the pricingtiers are annual only");
        assert_eq!(sliced(&excerpt), ["pricing", "tiers"]);
    }

    #[test]
    fn a_frontmatter_field_answers_when_the_body_cannot() {
        let meta = [
            field("slug", "create-an-agent"),
            field(
                "description",
                "Interview the user, then draft an Agent record.",
            ),
        ];
        let terms = ["interview".to_string()];
        let excerpt = excerpt(&meta, "# Create an agent\n\nBuild one.", &terms).expect("one");
        assert_eq!(excerpt.at, ExcerptAt::Field("description".into()));
        assert_eq!(sliced(&excerpt), ["interview"]);
        assert_eq!(
            super::excerpt(&meta, "Build one.", &["nothing".to_string()]),
            None
        );
    }

    #[test]
    fn body_lines_are_numbered_from_one() {
        let body = "first line\n\nthird holds pricing\r\nfourth";
        let excerpt = excerpt(&[], body, &["pricing".to_string()]).expect("one");
        assert_eq!(excerpt.at, ExcerptAt::Line(3));
        assert_eq!(excerpt.text, "third holds pricing");
    }

    // --- searchable frontmatter (M59.2) -----------------------------------

    const SEARCHABLE: &str = include_str!("../fixtures/searchable-values.json");

    #[test]
    fn searchable_fields_replay_the_shared_cases() {
        let file: Value = serde_json::from_str(SEARCHABLE).expect("searchable-values.json parses");
        assert_eq!(file["format"], 1);
        let chrome: Vec<&str> = file["chrome_keys"]
            .as_array()
            .expect("chrome_keys")
            .iter()
            .map(|k| k.as_str().expect("a key"))
            .collect();
        assert_eq!(chrome, PAGE_CHROME_KEYS);
        for case in file["values"].as_array().expect("values") {
            let texts: Vec<String> = serde_json::from_value(case["texts"].clone()).unwrap();
            assert_eq!(searchable_values(&case["value"]), texts, "{case}");
        }
        for case in file["entries"].as_array().expect("entries") {
            let properties = case["properties"].as_object().expect("properties");
            let relationships: BTreeMap<String, Vec<String>> =
                serde_json::from_value(case["relationships"].clone()).unwrap();
            let want: Vec<MetaField> = case["fields"]
                .as_array()
                .expect("fields")
                .iter()
                .map(|f| field(f["key"].as_str().unwrap(), f["text"].as_str().unwrap()))
                .collect();
            let got = searchable_fields(
                case["title"].as_str().expect("a title"),
                case["type"].as_str(),
                properties,
                &relationships,
            );
            assert_eq!(got, want, "{}", case["why"]);
        }
    }

    #[test]
    fn a_whole_float_reads_as_an_integer() {
        assert_eq!(searchable_values(&json!(1.0)), ["1"]);
        assert_eq!(searchable_values(&json!(-3.0)), ["-3"]);
        assert_eq!(searchable_values(&json!(0.25)), ["0.25"]);
    }

    // --- ⌘K's page-text search (M59.4) -----------------------------------

    #[test]
    fn display_line_drops_chip_syntax() {
        let table = [
            ("Ask @[[maya-chen]] first", "Ask @maya-chen first"),
            ("See [[atlas|the Atlas plan]] now", "See the Atlas plan now"),
            ("See [[atlas#Risks]]", "See atlas \u{203A} Risks"),
            ("Jump to [[#Risks]]", "Jump to Risks"),
            ("Linked [[atlas]] here", "Linked atlas here"),
            ("Embedded ![[diagram]]", "Embedded diagram"),
            ("A claim[^1] with a note", "A claim with a note"),
            ("[^1]: The source", "The source"),
            ("## Draining the queue", "Draining the queue"),
            ("> quoted [[a]]", "quoted a"),
            ("- a bullet", "a bullet"),
            ("* a star", "a star"),
            ("+ a plus", "a plus"),
            ("1. a number", "a number"),
            ("- [ ] an open task", "an open task"),
            ("- [x] a done task", "a done task"),
            ("#hashtag stays", "#hashtag stays"),
            ("an [[unclosed link", "an [[unclosed link"),
            ("a [^not a note] stays", "a [^not a note] stays"),
        ];
        for (raw, shown) in table {
            assert_eq!(display_line(raw), shown, "{raw:?}");
        }
    }

    fn marked(parts: &[ExcerptPart]) -> Vec<&str> {
        parts
            .iter()
            .filter(|p| p.mark)
            .map(|p| p.text.as_str())
            .collect()
    }

    fn joined(parts: &[ExcerptPart]) -> String {
        parts.iter().map(|p| p.text.as_str()).collect()
    }

    #[test]
    fn excerpt_parts_mark_terms_in_the_cleaned_line() {
        let body = "intro\n- [ ] Draining [[queue-design|the queue]] with @[[maya-chen]]\n";
        let docs = vec![doc("a.md", "Notes", body)];
        let query = parse_query("draining queue");
        let ranked = rank_query(&query, &docs, 5);
        let parts = excerpt_parts(&docs[0], &ranked.hits[0], &query.terms, "");
        assert_eq!(joined(&parts), "Draining the queue with @maya-chen");
        assert_eq!(marked(&parts), ["Draining", "queue"]);

        let meta = [field("description", "Owns [[draining]] work")];
        let docs = vec![with_meta("b.md", "Other", &meta, "nothing")];
        let query = parse_query("draining");
        let ranked = rank_query(&query, &docs, 5);
        let parts = excerpt_parts(&docs[0], &ranked.hits[0], &query.terms, "");
        assert_eq!(
            parts[0],
            ExcerptPart {
                text: "description: ".into(),
                mark: false
            }
        );
        assert_eq!(joined(&parts), "description: Owns draining work");
        assert_eq!(marked(&parts), ["draining"]);
    }

    #[test]
    fn a_title_only_hit_shows_the_snippet_unmarked() {
        let docs = vec![doc("a.md", "Draining", "nothing about it here")];
        let query = parse_query("draining");
        let ranked = rank_query(&query, &docs, 5);
        assert!(ranked.hits[0].excerpt.is_none());
        let parts = excerpt_parts(&docs[0], &ranked.hits[0], &query.terms, "  The snippet  ");
        assert_eq!(
            parts,
            [ExcerptPart {
                text: "The snippet".into(),
                mark: false
            }]
        );
        assert!(excerpt_parts(&docs[0], &ranked.hits[0], &query.terms, " ").is_empty());
    }

    fn search_vault_fixture(label: &str) -> std::path::PathBuf {
        let vault = crate::vault::testutil::temp_vault(label);
        for i in 0..7 {
            crate::vault::testutil::write(
                &vault,
                &format!("notes/n{i}.md"),
                &format!("# Note {i}\n\nThe pipeline is draining slowly.\n"),
            );
        }
        crate::vault::testutil::write(&vault, "notes/other.md", "# Other\n\nnothing\n");
        vault
    }

    #[test]
    fn search_location_hashes_the_same_read_as_its_range() {
        let vault = crate::vault::testutil::temp_vault("source-search-race");
        let raw = "---\r\nowner: Ada\r\n---\r\n# T\r\nSee [[atlas|the target]] 😀\r\n";
        crate::vault::testutil::write(&vault, "note.md", raw);
        let cache = CorpusCache::new(1);
        let vault_id = crate::runtime::scope::derive_vault_id(&vault);
        let snapshot = cache.snapshot(&vault).unwrap();
        let kept = docs_of(&snapshot, |_| true);
        let query = parse_query("target");
        let docs = kept.docs();
        let ranked = rank_query(&query, &docs, 20);
        // A real outside edit happens after ranking, before DTO construction.
        crate::vault::testutil::write(&vault, "note.md", "# New\nNo original passage remains.");
        let result = vault_search_result(&vault_id, &kept, &query, &ranked);
        let wire = serde_json::to_value(&result).unwrap();
        let location = &wire["hits"][0]["location"];
        assert_eq!(
            location["sourceHash"],
            crate::ledger::sha256_hex(raw.as_bytes())
        );
        assert_eq!(location["quote"], "See [[atlas|the target]] 😀");
        assert_eq!(location["bodyUtf8Range"], json!({"start":5,"end":34}));
        let locator: crate::source_location::SourceLocator =
            serde_json::from_value(location.clone()).unwrap();
        let scope = crate::source_location::SourceScope {
            vault: &vault,
            vault_id: &locator.vault_id,
            admits: &|_| true,
        };
        assert!(matches!(
            crate::source_location::resolve_source(&scope, &locator).unwrap(),
            crate::source_location::ResolveSourceResult::Changed { .. }
        ));
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn capped_body_locator_stays_in_searched_bytes() {
        let vault = crate::vault::testutil::temp_vault("source-capped");
        let raw = format!(
            "{} target 😀{}",
            "x ".repeat(corpus::SEARCH_BODY_CAP / 2 - 8),
            "tail ".repeat(50)
        );
        crate::vault::testutil::write(&vault, "note.md", &raw);
        let found = vault_search_in(&CorpusCache::new(1), &vault, "target", 20).unwrap();
        assert_eq!(found.capped, 1);
        let locator = found.hits[0].location.as_ref().unwrap();
        let range = locator.body_utf8_range.as_ref().unwrap();
        assert!(range.end as usize <= corpus::SEARCH_BODY_CAP);
        assert_eq!(
            raw.get(range.start as usize..range.end as usize),
            Some(locator.quote.as_str())
        );
        assert_eq!(
            locator.source_hash,
            crate::ledger::sha256_hex(raw.as_bytes())
        );
        assert!(locator.quote.contains("target"));
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn non_markdown_hit_has_no_body_locator() {
        let vault = crate::vault::testutil::temp_vault("source-carrier");
        crate::vault::testutil::write(&vault, "diagram.mmd", "graph TD\nA[target] --> B[other]\n");
        crate::vault::testutil::write(
            &vault,
            "board.canvas",
            r#"{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":100,"height":100,"text":"target"}],"edges":[]}"#,
        );
        let found = vault_search_in(&CorpusCache::new(1), &vault, "target", 20).unwrap();
        assert_eq!(found.hits.len(), 2);
        assert!(found.hits.iter().all(|hit| hit.location.is_none()));
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn search_location_property_uses_flattened_row_and_title_only_stays_legacy() {
        let vault = crate::vault::testutil::temp_vault("source-property");
        crate::vault::testutil::write(
            &vault,
            "note.md",
            "---\nowner: [Ada, Bo]\n---\nUnrelated body.",
        );
        crate::vault::testutil::write(&vault, "UniqueTitle.md", "Unrelated body.");
        let cache = CorpusCache::new(1);
        let found = vault_search_in(&cache, &vault, "Ada", 20).unwrap();
        let locator = found.hits[0].location.as_ref().unwrap();
        assert_eq!(locator.kind, "property");
        assert_eq!(locator.property_key.as_deref(), Some("owner"));
        assert_eq!(locator.quote, "Ada, Bo");
        assert!(locator.body_utf8_range.is_none());
        let scope = crate::source_location::SourceScope {
            vault: &vault,
            vault_id: &locator.vault_id,
            admits: &|_| true,
        };
        assert!(matches!(
            crate::source_location::resolve_source(&scope, locator).unwrap(),
            crate::source_location::ResolveSourceResult::Exact { .. }
        ));
        let title = vault_search_in(&cache, &vault, "UniqueTitle", 20).unwrap();
        assert_eq!(title.hits[0].path, "UniqueTitle.md");
        assert!(title.hits[0].location.is_none());
        let _ = std::fs::remove_dir_all(vault);
    }

    #[test]
    fn vault_search_counts_every_match_and_returns_the_limit() {
        let vault = search_vault_fixture("vault-search-total");
        let cache = CorpusCache::new(1);
        let found = vault_search_in(&cache, &vault, "draining", 3).unwrap();
        assert_eq!((found.hits.len(), found.total), (3, 7));
        assert!(!found.widened);
        assert_eq!(found.capped, 0);
        assert_eq!(found.hits[0].title, "Note 0");
        assert_eq!(found.hits[0].entry_type, None);
        assert_eq!(marked(&found.hits[0].parts), ["draining"]);
        // The limit is clamped to 1..=50, never refused.
        assert_eq!(
            vault_search_in(&cache, &vault, "draining", 0)
                .unwrap()
                .hits
                .len(),
            1
        );
        assert_eq!(
            vault_search_in(&cache, &vault, "draining", 500)
                .unwrap()
                .hits
                .len(),
            7
        );
        let none = vault_search_in(&cache, &vault, "unicorns", 50).unwrap();
        assert_eq!((none.hits.len(), none.total), (0, 0));
        // camelCase on the wire, and `type` as the entry's own word.
        let wire = serde_json::to_value(&found).unwrap();
        assert_eq!(wire["hits"][0]["type"], Value::Null);
        assert_eq!(wire["hits"][0]["parts"][0]["mark"], false);
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn vault_search_reports_capped_notes() {
        let vault = search_vault_fixture("vault-search-capped");
        let long = format!(
            "# Long\n\nEarly draining.\n{}\nLate zeppelin.\n",
            "filler words here\n".repeat(crate::vault::corpus::SEARCH_BODY_CAP / 10)
        );
        crate::vault::testutil::write(&vault, "notes/long.md", &long);
        let cache = CorpusCache::new(1);
        let found = vault_search_in(&cache, &vault, "draining", 50).unwrap();
        assert_eq!(found.capped, 1);
        assert_eq!(found.total, 8);
        // Past the first 100 KiB, a word is not searched.
        let late = vault_search_in(&cache, &vault, "zeppelin", 50).unwrap();
        assert_eq!((late.total, late.capped), (0, 1));
        let _ = std::fs::remove_dir_all(&vault);
    }

    #[test]
    fn vault_search_answers_with_an_unreadable_ledger_store() {
        let vault = search_vault_fixture("vault-search-ledger");
        crate::vault::testutil::write(
            &vault,
            "knowledge/systems/draining.md",
            "---\ntype: Concept\n---\n\n# Draining\n\nThe draining concept.\n",
        );
        // A file where the store's folder belongs: no store can be read.
        crate::vault::testutil::write(&vault, crate::ledger::LEDGER_DIR, "not a store");
        assert!(crate::ledger::has_store(&vault));
        let found = vault_search_in(&CorpusCache::new(1), &vault, "draining", 50).unwrap();
        assert_eq!(found.total, 8);
        assert_eq!(found.hits[0].path, "knowledge/systems/draining.md");
        let _ = std::fs::remove_dir_all(&vault);
    }

    // --- scopes (M59.5) --------------------------------------------------

    fn scope_docs(meta: &[MetaField]) -> Vec<Doc<'_>> {
        vec![
            doc(
                "body.md",
                "Weekly notes",
                "The pelican came up twice: pelican.",
            ),
            with_meta("meta.md", "Vendor list", meta, "Nothing here."),
            Doc {
                path: "typed.md",
                title: "Field log",
                kind: Some("Pelican"),
                meta: &[],
                body: "Seen at dawn.",
            },
            doc(
                "title.md",
                "Pelican case",
                "# Pelican case\n\nNothing about birds.",
            ),
        ]
    }

    #[test]
    fn a_name_scope_ranks_on_titles_alone() {
        let meta = [field("species", "pelican")];
        let docs = scope_docs(&meta);
        let query = parse_query("pelican");
        let out = rank_scoped(&query, &docs, 20, Scope::Name);
        assert_eq!(paths(&out, &docs), ["title.md"]);
        assert_eq!(out.total, 1);
        assert!(
            out.hits[0].excerpt.is_none(),
            "the caller shows the snippet"
        );
        // A quoted phrase reads the title alone too.
        let phrase = rank_scoped(&parse_query("\"pelican case\""), &docs, 20, Scope::Name);
        assert_eq!(paths(&phrase, &docs), ["title.md"]);
        assert!(phrase.hits[0].phrase);
        // A body word is no title word, so nothing answers it, not even widened.
        let body = rank_scoped(&parse_query("dawn"), &docs, 20, Scope::Name);
        assert_eq!(body.total, 0);
    }

    #[test]
    fn a_content_scope_never_matches_a_title_only_note() {
        let meta = [field("species", "pelican")];
        let docs = scope_docs(&meta);
        let out = rank_scoped(&parse_query("pelican"), &docs, 20, Scope::Content);
        let mut found = paths(&out, &docs);
        found.sort();
        assert_eq!(found, ["body.md", "meta.md", "typed.md"]);
        let meta_hit = out
            .hits
            .iter()
            .find(|h| docs[h.index].path == "meta.md")
            .unwrap();
        assert_eq!(
            meta_hit.excerpt.as_ref().map(|e| e.at.clone()),
            Some(ExcerptAt::Field("species".into()))
        );
        // A title word alone matches nothing, not even widened, though the
        // note's body opens with it as its H1.
        let title = rank_scoped(&parse_query("case"), &docs, 20, Scope::Content);
        assert_eq!(title.total, 0);
        // Only the heading that IS the title leaves: a section heading stays,
        // and the lines after the title keep their numbers.
        let docs = [
            doc(
                "titled.md",
                "Pelican case",
                "# Pelican case\n\nThe pelican nests.",
            ),
            doc("okf.md", "Warehouse cutover", "# Trigger\n\nGo-live night."),
        ];
        let nests = rank_scoped(&parse_query("pelican"), &docs, 20, Scope::Content);
        assert_eq!(
            nests.hits[0]
                .excerpt
                .as_ref()
                .map(|e| (e.at.clone(), e.text.as_str())),
            Some((ExcerptAt::Line(3), "The pelican nests."))
        );
        let section = rank_scoped(&parse_query("trigger"), &docs, 20, Scope::Content);
        assert_eq!(paths(&section, &docs), ["okf.md"]);
    }

    #[test]
    fn rank_query_is_the_all_scope() {
        let meta = [field("species", "pelican")];
        let docs = scope_docs(&meta);
        for raw in [
            "pelican",
            "pelican case",
            "\"pelican case\"",
            "dawn field",
            "nothing",
        ] {
            let query = parse_query(raw);
            let all = rank_scoped(&query, &docs, 2, Scope::All);
            let plain = rank_query(&query, &docs, 2);
            let seen = |r: &Ranked| {
                r.hits
                    .iter()
                    .map(|h| {
                        (
                            h.index,
                            h.score.to_bits(),
                            h.excerpt.clone(),
                            h.matched.clone(),
                            h.phrase,
                        )
                    })
                    .collect::<Vec<_>>()
            };
            assert_eq!(seen(&all), seen(&plain), "{raw}");
            assert_eq!(
                (all.total, all.widened),
                (plain.total, plain.widened),
                "{raw}"
            );
        }
        assert_eq!(Scope::parse("all"), Some(Scope::All));
        assert_eq!(Scope::parse("name"), Some(Scope::Name));
        assert_eq!(Scope::parse("content"), Some(Scope::Content));
        for word in ["", "Name", "title", "titles", " all"] {
            assert_eq!(Scope::parse(word), None, "{word:?}");
        }
    }
}

#[cfg(test)]
#[path = "search_normalization_tests.rs"]
mod normalization_tests;
