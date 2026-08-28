# M33a.0 + M33a.1 — Description, relations, and a concept-type vocabulary

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the distiller record what it already knows — a one-line
description, and the supersessions it currently writes as prose — and give it a
real vocabulary to type concepts with instead of falling back to `Reference`.

**Architecture:** Three of the four changes are contract text: the
`write_concept` tool schema, the manual `distillPrompt`, and the M26 ingest
`RULES`. The fourth ships the concept-type vocabulary as a hashed artifact
under `shared/policy/`, loaded by Rust with `include_str!` and a digest check,
exactly like `lanes.v1.json`. No model changes; no new surfaces.

**Tech Stack:** Rust (`src-tauri/src/mcp.rs`, `src-tauri/src/knowledge.rs`,
`src-tauri/src/ingest/prompt.rs`), TypeScript (`src/lib/prompts.ts`), JSON
policy artifacts under `shared/policy/`.

**Spec:** `docs/superpowers/specs/2026-08-16-cerebro-m33a-knowledge-threads-design.md`

**Measured baseline** (`~/Documents/test`, 30 concepts from 4 transcripts):
`description` 0/30 · `supersedes` 0/30 · `refines` 0/30 · `contradicts` 0/30 ·
16 of 30 typed `Reference` (3 programs + 13 systems).

---

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src-tauri/src/mcp.rs` | MCP tool catalog + `write_concept` | Modify: `description` required; relation and type guidance in the tool description |
| `src/lib/prompts.ts` | Prompts the app hands the agent | Modify: `distillPrompt` requires description + lifted relations |
| `src-tauri/src/ingest/prompt.rs` | The M26 ingest `RULES` | Modify: add the lift-relations rule |
| `shared/policy/concept-types.v1.json` | The vocabulary, as data | Create |
| `shared/policy/concept-types.v1.sha256` | Its digest | Create (generated) |
| `shared/policy/README.md` | The artifact index + regeneration ritual | Modify: one table row, one regen line |
| `src-tauri/src/knowledge.rs` | Knowledge guards; now also the vocabulary loader | Modify: `CONCEPT_TYPES`, `concept_type_names()`, digest test |

**Deliberately NOT in this plan:** vault-declared type extensions. Those need
`tool_catalog` to take the vault, which ripples through five call sites.
Tracked as a follow-on task in the spec's D3; the static list is what fixes the
measured defect.

---

## Task 1: `description` becomes a required field

**Files:**
- Modify: `src-tauri/src/mcp.rs:748-782` (the `write_concept` input schema)
- Test: `src-tauri/src/mcp.rs` (tests module, same file)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/mcp.rs`:

```rust
#[test]
fn write_concept_requires_a_description() {
    // 0 of 30 concepts in a real distilled vault carried one, so every list
    // row rendered as title + type + Unreviewed and nothing else. Optional
    // meant absent.
    let tool = tool_catalog(true)
        .into_iter()
        .find(|t| t["name"] == "write_concept")
        .expect("write_concept is served");
    let required: Vec<&str> = tool["inputSchema"]["required"]
        .as_array()
        .expect("schema declares required")
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(
        required.contains(&"description"),
        "description must be required, got {required:?}"
    );
}
```

- [ ] **Step 2: Run it and watch it fail**

```sh
cd src-tauri && cargo test --lib mcp::tests::write_concept_requires_a_description
```

Expected: FAIL — `description must be required, got ["path", "type", "title", "body"]`

- [ ] **Step 3: Make it required**

In `src-tauri/src/mcp.rs`, the `write_concept` entry, change the required list
argument on the last line of its `inputSchema`:

```rust
            }), &["path", "type", "title", "description", "body"])
```

And sharpen the field's own description (currently `"One sentence"`):

```rust
                "description": { "type": "string", "description": "One sentence saying what this concept is. It is the only line shown beside the title in every list, so 'what it is' beats 'why it matters'." },
```

- [ ] **Step 4: Run it and watch it pass**

```sh
cd src-tauri && cargo test --lib mcp::tests::write_concept_requires_a_description
```

Expected: PASS

- [ ] **Step 5: Commit**

```sh
git add src-tauri/src/mcp.rs
git commit -m "feat(knowledge): a concept must say in one line what it is (M33a.0)"
```

---

## Task 2: Tell `write_concept` that relations are recorded, not narrated

**Files:**
- Modify: `src-tauri/src/mcp.rs:765-779` (the `supersedes` / `refines` / `contradicts` field descriptions and the tool description)
- Test: `src-tauri/src/mcp.rs` (tests module)

**Why:** the distiller writes *"RFA-2-019: thermal correlation → superseded by
3-002"* in a markdown table and leaves `supersedes` empty. The field
descriptions read as definitions; none of them says "and if you wrote this in
the body, put it here too."

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn write_concept_says_a_narrated_relation_must_also_be_recorded() {
    // The measured failure: 30 concepts, 0 relations, and bodies full of
    // "superseded by" in prose. A field description that only DEFINES the
    // field does not tell a model to look back at what it just wrote.
    let tool = tool_catalog(true)
        .into_iter()
        .find(|t| t["name"] == "write_concept")
        .expect("write_concept is served");
    let text = tool["description"].as_str().unwrap().to_lowercase();
    assert!(
        text.contains("body") && text.contains("supersedes"),
        "the tool description must tie body prose back to the relation fields"
    );
}
```

- [ ] **Step 2: Run it and watch it fail**

```sh
cd src-tauri && cargo test --lib mcp::tests::write_concept_says_a_narrated_relation_must_also_be_recorded
```

Expected: FAIL — the assertion, since the current description mentions neither.

- [ ] **Step 3: Extend the tool description**

Replace the `write_concept` `"description"` value in `src-tauri/src/mcp.rs`
with:

```rust
            "description": "Create or replace a concept in the knowledge/ bundle (Open Knowledge Format). You maintain this bundle; the user only verifies it. Always record where a claim came from in `sources`. Never write `verified` — that is the human's stamp, and claiming it would defeat the review model. If the body says one thing replaced, narrowed or disagrees with another, say it in `supersedes`/`refines`/`contradicts` as well: prose is for the reader, the fields are what lets anything answer 'is this still true'. Only assert a relation whose target you read in this run.",
```

- [ ] **Step 4: Run it and watch it pass**

```sh
cd src-tauri && cargo test --lib mcp::tests::write_concept_says_a_narrated_relation_must_also_be_recorded
```

Expected: PASS

- [ ] **Step 5: Commit**

```sh
git add src-tauri/src/mcp.rs
git commit -m "feat(knowledge): a relation written in prose must also be a field (M33a.0)"
```

---

## Task 3: The same two rules in `distillPrompt`

**Files:**
- Modify: `src/lib/prompts.ts:15-34`
- Test: `src/lib/prompts.test.ts`

**Why:** `distillPrompt` is the manual "Learn from this" path, and it wrote the
30 concepts we measured. Its contract doc-comment already says the prompts
*"name the exact tools and fields the rest of the app depends on the agent
producing."* Description and relations are two such fields.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/prompts.test.ts`:

```ts
describe('distillPrompt', () => {
  it('asks for the two fields a real vault came back empty on', () => {
    // Measured on ~/Documents/test: 30 concepts, description 0/30,
    // supersedes/refines/contradicts 0/30 — while the bodies narrated
    // supersession in prose.
    const prompt = distillPrompt('inbox/capture.md', 'A capture');
    expect(prompt).toContain('description');
    expect(prompt.toLowerCase()).toContain('in the body');
  });
});
```

Add `distillPrompt` to the existing import at the top of the file if it is not
already there.

- [ ] **Step 2: Run it and watch it fail**

```sh
pnpm test:run src/lib/prompts.test.ts
```

Expected: FAIL — `expected '...' to contain 'description'`

- [ ] **Step 3: Extend the prompt**

In `src/lib/prompts.ts`, change item 4 and add one line after the `supersedes`
sentence:

```ts
    `4. Anchor every concept with \`about\`, cite this note in \`sources\` (resource: ${path}), and give each one a one-sentence \`description\` — it is the only line shown beside the title in every list.`,
```

and, immediately after the existing `supersedes` line:

```ts
    'Anything you state in the body about one concept replacing, narrowing or disagreeing with another must ALSO be in `supersedes`/`refines`/`contradicts`. A supersession written only as prose cannot answer "is this still true". Only assert a relation whose target you read in this run.',
```

- [ ] **Step 4: Run it and watch it pass**

```sh
pnpm test:run src/lib/prompts.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```sh
git add src/lib/prompts.ts src/lib/prompts.test.ts
git commit -m "feat(knowledge): distil asks for a description and records its relations (M33a.0)"
```

---

## Task 4: The lift-relations rule in the ingest `RULES`

**Files:**
- Modify: `src-tauri/src/ingest/prompt.rs:127-150` (`const RULES`)
- Test: `src-tauri/src/ingest/prompt.rs` (tests module, beside
  `the_rules_say_the_thing_the_fence_is_for`)

**Why:** D3 in the spec — the two distil paths must not diverge on what they
require, or the vault's shape depends on which one ran.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn the_rules_say_a_narrated_relation_is_not_a_recorded_one() {
    // The manual path and this one must ask for the same fields, or the
    // bundle's shape depends on which button ran.
    let lower = RULES.to_lowercase();
    assert!(
        lower.contains("supersed"),
        "the standing rules must name supersession as something to record"
    );
}
```

- [ ] **Step 2: Run it and watch it fail**

```sh
cd src-tauri && cargo test --lib ingest::prompt::tests::the_rules_say_a_narrated_relation_is_not_a_recorded_one
```

Expected: FAIL

- [ ] **Step 3: Add the rule**

In `src-tauri/src/ingest/prompt.rs`, append one bullet to `const RULES`, after
the *"Say what you did not do"* bullet:

```rust
- Record relations, do not narrate them. If what you observed means one claim
  supersedes, refines or contradicts another, propose that relation. A
  supersession stated only in prose cannot answer whether something is still
  true. Only assert a relation whose target you read in this run.
```

- [ ] **Step 4: Run it and watch it pass**

```sh
cd src-tauri && cargo test --lib ingest::prompt::tests::the_rules_say_a_narrated_relation_is_not_a_recorded_one
```

Expected: PASS

- [ ] **Step 5: Commit**

```sh
git add src-tauri/src/ingest/prompt.rs
git commit -m "feat(ingest): both distil paths ask for the same relations (M33a.0)"
```

---

## Task 5: The concept-type vocabulary, as data

**Files:**
- Create: `shared/policy/concept-types.v1.json`
- Create: `shared/policy/concept-types.v1.sha256` (generated in Task 6)

**Why:** `write_concept`'s type field says `"e.g. Metric, Playbook,
Reference"`. The same run typed `Risk`, `Decision` and `Metric` correctly and
fell back to `Reference` for 3 programs and 13 systems — words it was never
given. The list ships as data because a hard-coded copy in either language is a
review-blocking defect (`shared/policy/README.md`).

- [ ] **Step 1: Create the artifact**

`shared/policy/concept-types.v1.json`:

```json
{
  "format": 1,
  "artifact_version": 1,
  "rule_version": "concept-types/2026-08-16",
  "fallback": "Reference",
  "types": [
    { "id": "Program", "hint": "A named programme or project the work belongs to" },
    { "id": "System", "hint": "A system, subsystem or component, and how it is built" },
    { "id": "Decision", "hint": "A choice that was made, by whom, and what it settled" },
    { "id": "Risk", "hint": "Something that could go wrong, and what it depends on" },
    { "id": "Issue", "hint": "Something that HAS gone wrong and is open" },
    { "id": "Action", "hint": "Work owed by someone, with a deadline where one was given" },
    { "id": "Assumption", "hint": "Something taken as true without evidence yet" },
    { "id": "Hypothesis", "hint": "A proposed explanation that could be tested" },
    { "id": "Forecast", "hint": "A dated expectation about what will happen" },
    { "id": "Question", "hint": "Something nobody could answer, worth returning to" },
    { "id": "Finding", "hint": "Something measured or observed, with its basis" },
    { "id": "Metric", "hint": "A number, how it is computed, and what moves it" },
    { "id": "Playbook", "hint": "How to do something, in order" },
    { "id": "Reference", "hint": "Background that fits none of the above" }
  ]
}
```

- [ ] **Step 2: Seed the digest file with a deliberately wrong value**

Task 6 `include_str!`s this path, so the crate will not compile — and the
ignored test that writes the real digest cannot run — unless the file already
exists. Seed it wrong rather than right, so a forgotten regeneration fails
loudly instead of silently passing:

```sh
printf 'regenerate-me\n' > shared/policy/concept-types.v1.sha256
```

- [ ] **Step 3: Commit the artifact and its placeholder**

```sh
git add shared/policy/concept-types.v1.json shared/policy/concept-types.v1.sha256
git commit -m "feat(policy): a concept-type vocabulary, as data (M33a.1)

The digest is a placeholder: it is written by an ignored test that cannot run
until the loader in the next commit exists, and a wrong value there fails the
load rather than passing it."
```

---

## Task 6: Load it in Rust, with a digest check

**Files:**
- Modify: `src-tauri/src/knowledge.rs` (append; it currently ends at line 585)
- Test: `src-tauri/src/knowledge.rs` (its existing tests module)

**Pattern to follow:** `src-tauri/src/attention/lanes.rs:40-70` — `include_str!`
the JSON and the digest, `deny_unknown_fields`, hash what was loaded, compare.

- [ ] **Step 1: Write the failing test**

Add to the tests module in `src-tauri/src/knowledge.rs`:

```rust
#[test]
fn the_vocabulary_matches_its_digest_and_names_the_words_the_vault_needed() {
    // Two processes in two languages asserting the SAME bytes, not each
    // asserting self-consistency (shared/policy/README.md).
    let names = concept_type_names();
    // The measured gap: 3 programs and 13 systems all landed on Reference
    // because those two words were never in the tool's description.
    assert!(names.contains(&"Program"));
    assert!(names.contains(&"System"));
    // And the fallback must still be offerable, or a concept that is honestly
    // background has nowhere to go.
    assert!(names.contains(&"Reference"));
}
```

- [ ] **Step 2: Run it and watch it fail**

```sh
cd src-tauri && cargo test --lib knowledge::tests::the_vocabulary_matches_its_digest_and_names_the_words_the_vault_needed
```

Expected: FAIL to compile — `cannot find function 'concept_type_names'`

- [ ] **Step 3: Write the loader**

Append to `src-tauri/src/knowledge.rs`:

```rust
// --- The concept-type vocabulary (M33a.1) ----------------------------------

/// The words the agent is allowed to type a concept with.
///
/// Data rather than a Rust array because `okf.ts` resolves `conceptType`
/// against the same idea on the read side, and a rule implemented as twin
/// Rust and TS code is a review-blocking defect (`shared/policy/README.md`).
///
/// It ships as one static list rather than per-vault: a vault that declares
/// its own types can still use them — `conceptType` is free-form by OKF §4.1
/// and consumers must tolerate unknown values — this is what the agent is
/// OFFERED when it has nothing else to go on, which was the measured failure.
const CONCEPT_TYPES_JSON: &str = include_str!("../../shared/policy/concept-types.v1.json");
const CONCEPT_TYPES_DIGEST: &str = include_str!("../../shared/policy/concept-types.v1.sha256");

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ConceptTypeArtifact {
    format: u64,
    artifact_version: u64,
    rule_version: String,
    fallback: String,
    types: Vec<ConceptTypeDef>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ConceptTypeDef {
    id: String,
    hint: String,
}

fn concept_types() -> &'static ConceptTypeArtifact {
    use std::sync::OnceLock;
    static LOADED: OnceLock<ConceptTypeArtifact> = OnceLock::new();
    LOADED.get_or_init(|| {
        let digest = crate::ledger::sha256_hex(CONCEPT_TYPES_JSON.as_bytes());
        assert_eq!(
            digest.trim(),
            CONCEPT_TYPES_DIGEST.trim(),
            "concept-types.v1.json does not match its digest — regenerate it, \
             see shared/policy/README.md"
        );
        let artifact: ConceptTypeArtifact = serde_json::from_str(CONCEPT_TYPES_JSON)
            .expect("concept-types.v1.json parses");
        assert_eq!(artifact.format, 1, "unknown concept-types format");
        assert!(
            artifact.types.iter().any(|t| t.id == artifact.fallback),
            "the fallback must be one of the offered types"
        );
        artifact
    })
}

/// Every type name, in artifact order.
pub fn concept_type_names() -> Vec<&'static str> {
    concept_types()
        .types
        .iter()
        .map(|t| t.id.as_str())
        .collect()
}

/// The vocabulary rendered for a tool description: `Name — hint`, one per
/// line, so the model reads what each word is FOR and not just that it exists.
pub fn concept_type_menu() -> String {
    concept_types()
        .types
        .iter()
        .map(|t| format!("{} — {}", t.id, t.hint))
        .collect::<Vec<_>>()
        .join("; ")
}
```

Silence the two fields the loader validates but never reads again by prefixing
them where clippy complains; if `artifact_version` and `rule_version` are
flagged as dead, add `#[allow(dead_code)]` above the struct with the comment
`// Read by the digest test and by anyone diffing the artifact.`

- [ ] **Step 4: Generate the real digest**

The placeholder seeded in Task 5 makes the crate compile and the load fail, so
this test can now run. Add it beside the loader's tests, matching the ritual in
`shared/policy/README.md`:

```rust
/// Regenerating the digest is a deliberate act, so it is a test you run by
/// name rather than something the suite does on its own.
///
/// `cargo test --lib knowledge::tests::write_concept_types_digest -- --ignored`
#[test]
#[ignore]
fn write_concept_types_digest() {
    let digest = crate::ledger::sha256_hex(CONCEPT_TYPES_JSON.as_bytes());
    std::fs::write(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/policy/concept-types.v1.sha256"
        ),
        format!("{digest}\n"),
    )
    .unwrap();
}
```

Then run it:

```sh
cd src-tauri && cargo test --lib knowledge::tests::write_concept_types_digest -- --ignored
```

Expected: `test result: ok. 1 passed`, and
`shared/policy/concept-types.v1.sha256` now exists.

- [ ] **Step 5: Run the real test and watch it pass**

```sh
cd src-tauri && cargo test --lib knowledge::tests::the_vocabulary_matches_its_digest_and_names_the_words_the_vault_needed
```

Expected: PASS

- [ ] **Step 6: Add the artifact to the README index**

In `shared/policy/README.md`, add a row to the file table:

```markdown
| `concept-types.v1.json` + `.sha256` | The words the agent may type a concept with (M33a.1), and a one-line hint for each. Loaded by `src-tauri/src/knowledge.rs` into `write_concept`'s tool description. Rust-only for now: the read side (`okf.ts`) resolves a concept's type against the vault's own catalog and tolerates unknown values by OKF §4.1, so there is no twin to disagree with. |
```

And a line to the regeneration block:

```sh
# after an edit to concept-types.v1.json
cargo test --lib knowledge::tests::write_concept_types_digest -- --ignored
```

- [ ] **Step 7: Commit**

```sh
git add src-tauri/src/knowledge.rs shared/policy/concept-types.v1.sha256 shared/policy/README.md
git commit -m "feat(policy): load the concept-type vocabulary, digest-checked (M33a.1)"
```

---

## Task 7: Offer the vocabulary in `write_concept`

**Files:**
- Modify: `src-tauri/src/mcp.rs:750` (the `type` field description)
- Test: `src-tauri/src/mcp.rs` (tests module)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn write_concept_offers_the_vocabulary_rather_than_three_examples() {
    // "e.g. Metric, Playbook, Reference" is what produced 3 programs and 13
    // systems all typed Reference: the model picked the safest word it had
    // been shown.
    let tool = tool_catalog(true)
        .into_iter()
        .find(|t| t["name"] == "write_concept")
        .expect("write_concept is served");
    let text = tool["inputSchema"]["properties"]["type"]["description"]
        .as_str()
        .unwrap();
    for name in crate::knowledge::concept_type_names() {
        assert!(
            text.contains(name),
            "the type description must offer {name}; got {text}"
        );
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```sh
cd src-tauri && cargo test --lib mcp::tests::write_concept_offers_the_vocabulary_rather_than_three_examples
```

Expected: FAIL — `the type description must offer Program`

- [ ] **Step 3: Build the description from the artifact**

In `src-tauri/src/mcp.rs`, inside `base_tools()`, above the `json!` array, add:

```rust
    // Built from the artifact, never written out here: a second hand-kept
    // list of type names is exactly the twin-inventory defect
    // shared/policy/README.md exists to prevent.
    let concept_types = format!(
        "OKF concept type. Pick the closest of: {}. Use the vault's own type name instead when one fits better.",
        crate::knowledge::concept_type_menu()
    );
```

and replace the `type` field line with:

```rust
                "type": { "type": "string", "description": concept_types },
```

- [ ] **Step 4: Run it and watch it pass**

```sh
cd src-tauri && cargo test --lib mcp::tests::write_concept_offers_the_vocabulary_rather_than_three_examples
```

Expected: PASS

- [ ] **Step 5: Run the whole Rust suite**

```sh
cd src-tauri && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

Expected: all pass. If a test asserted the old `"e.g. Metric, Playbook,
Reference"` string, update it to assert the new contract rather than the old
words — and delete any comment that explained why three examples were enough.

- [ ] **Step 6: Commit**

```sh
git add src-tauri/src/mcp.rs
git commit -m "feat(knowledge): offer the vocabulary, not three examples (M33a.1)"
```

---

## Task 8: Prove it on the vault that failed

**Files:**
- None modified. This is the validation the whole plan exists for.

**Why:** every previous task asserts the *contract* changed. Only this one
shows the *output* changed, and the baseline is measured, not remembered.

- [ ] **Step 1: Record the before**

```sh
cd /Users/joseflagorio/Documents/test && git rev-parse HEAD && \
grep -c "^description:" knowledge/**/*.md ; \
grep -l "^supersedes:" knowledge/**/*.md | wc -l ; \
grep -h "^type:" knowledge/**/*.md | sort | uniq -c
```

Expected, matching the plan header: no `description:` lines, no `supersedes:`
files, and `16 Reference / 8 Risk / 4 Decision / 1 Metric`.

- [ ] **Step 2: Build and run the app against that vault**

```sh
./scripts/mac-build.sh
```

Open the vault at `~/Documents/test`, then re-run "Learn from this" on
`inbox/capture-2026-08-16-1212.md` (the IMS-7 CDR Session 3 transcript — it is
the one whose concept narrates *"RFA-2-019 … superseded by 3-002"* in a table).

- [ ] **Step 3: Measure the after**

```sh
cd /Users/joseflagorio/Documents/test && \
grep -c "^description:" knowledge/decisions/cdr-session-3-disposition.md ; \
grep -A3 "^supersedes:" knowledge/decisions/cdr-session-3-disposition.md
```

Expected: a `description:` line, and a `supersedes:` list naming the concept
the body already said was replaced.

- [ ] **Step 4: Write down what actually happened**

Append the observed before/after to
`docs/superpowers/plans/2026-08-16-cerebro-m33a-vocabulary-and-relations.md`
under a new `## Outcome` heading — including anything that did NOT change, and
any relation the agent asserted that looks wrong. A prompt change that produces
plausible-but-false relations is the risk named in the spec (§7, D4), and this
step is where it would first be visible.

- [ ] **Step 5: Commit the outcome**

```sh
git add docs/superpowers/plans/2026-08-16-cerebro-m33a-vocabulary-and-relations.md
git commit -m "docs(plan): what the vocabulary and relation changes did to a real vault (M33a.1)"
```

---

## Full gate before handing back

```sh
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test:run
cd src-tauri && cargo test && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

`pnpm e2e` is not required: nothing here touches a rendered surface. Check the
port is free first if you run it anyway (`lsof -iTCP:5173 -sTCP:LISTEN`).
