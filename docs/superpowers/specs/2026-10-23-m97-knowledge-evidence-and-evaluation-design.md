# M97 — Knowledge, evidence and evaluation design

**Milestone:** M97 · **Phases:** M97.1–M97.8 · **Requirements:** KNOW-01–KNOW-11.

[Master roadmap](../plans/2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](2026-10-23-m93-m99-research/README.md).

**Draft for owner review · 2026-10-23 · M97 / KNOW.** Covers CP05, CP06, CP07,
CP10 and AX12's outcome evaluations. [Implementation plan](../plans/2026-10-23-m97-knowledge-evidence-and-evaluation.md).
This adds inspectable evidence and measured usefulness to the existing guarded
knowledge system. It does not create another knowledge authority.

## Intent, evidence and alternatives

A person should be able to open the exact passage behind a search result or
answer, see what a run actually used, and understand why evidence was unavailable.
The product should measure whether its assistant completes useful tasks without
violating scope or pretending uncertainty is knowledge.

Current [search](../../../src-tauri/src/search.rs) has body-line/property excerpts
and byte ranges internally. Its `VaultHit` still carries only path/title/type/display
parts; [Quick Open](../../../src/app/QuickOpen.tsx) opens `hit.path`. The
[assembly manifest](../../../src-tauri/src/assembly/manifest.rs) already records
selection intents, limits and counterevidence; it is not a record of every page
an ordinary chat encountered. [Backlinks](../../../src/engine/links.ts) and
[concept evidence](../../../src/knowledge/KnowledgePanel.tsx) already exist.
The work is source continuity, selective disclosure and evaluation depth.

| Approach                                                   | Tradeoff                                                                | Proposal                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| Better labels over existing path-only results              | Small UI improvement; repeated/stale passages remain ambiguous          | Insufficient for exact citations                 |
| Versioned source locations plus evidence/behavior fixtures | Adds one shared contract and meaningful measurement                     | Recommended first                                |
| Embeddings, global graph or confidence score first         | New machinery without a measured retrieval problem; authority confusion | Defer until labeled misses justify an experiment |

Retain lexical retrieval, existing corpus cache, assembly safeguards, human-only
Verify and the three Knowledge tabs. No automatic concept verification, inferred
support from a backlink, background graph crawl or provider-key requirement.

## Requirements

- **KNOW-01:** Markdown body/property results carry a source-versioned location
  from search through IPC, navigation and the one editor owner.
- **KNOW-02:** Resolving a location distinguishes exact, relocated, changed,
  unavailable and unsupported. Never select the first repeated quote by guess.
- **KNOW-03:** Search → source → Back preserves originating query, selection,
  pane, scroll and conversation draft. Reveal executes once after readiness.
- **KNOW-04:** Run configuration is an immutable bounded operational manifest,
  distinct from the existing assembly working-memory manifest and chat context
  receipt. Missing historical facts remain not recorded.
- **KNOW-05:** Inspect “Configuration used” and “Why this evidence” through
  existing run/page surfaces, respecting present read grants and originating vault.
- **KNOW-06:** Selected, encountered, read, cited and supporting are distinct
  evidence roles; none automatically means human-verified or sufficient support.
- **KNOW-07:** Backlinks gain bounded source context; unlinked mentions are an
  explicit search with counts/caps, not automatic relations or epistemic writes.
- **KNOW-08:** Outcome fixtures evaluate permission/effect boundaries, expected
  sources/artifacts and recovery independently from presentation and token cost.
- **KNOW-09:** Retrieval fixtures use reviewed relevance/counterevidence labels
  at the actual production cutoff, including multilingual and heterogeneous content.
- **KNOW-10:** Normalization, embeddings, attachment search and graph work are
  experiments gated by measured misses and access/cost bounds.
- **KNOW-11:** Evidence reads and reports never expose credentials, ungranted
  source excerpts or full retained prompts by accident. Operational evidence does
  not enter the epistemic ledger unless existing materiality policy requires it.

## Shared location and evidence contract

Proposed first-version DTO, owned in `shared/knowledge/source-location.v1.json`
with Rust/TS shared cases:

```text
SourceLocator {
  version: 1, vaultId: string, path: string, sourceHash: string,
  kind: "body" | "property",
  bodyUtf8Range?: { start: u32, end: u32 }, propertyKey?: string,
  quote: string, prefix: string, suffix: string
}
ResolveSourceResult =
  Exact { locator } | Relocated { locator, previousHash } |
  Changed { path, reason } | Unavailable { reason } | Unsupported { reason }
EvidenceRef {
  runId: string, assemblyId?: string, sourceId?: string, locator?: SourceLocator,
  role: "selected" | "encountered" | "read" | "cited" | "supporting",
  recordedAt: string
}
```

`body` requires its UTF-8 byte range and forbids `propertyKey`; `property` requires
its exact key and forbids a body range. Ranges address the unnormalized Markdown
body excluding frontmatter, end-exclusive and checked at UTF-8 boundaries.
`sourceHash` hashes the raw complete file bytes, including metadata. This makes
even a metadata-only change explicit; relocation can still recover the same body
passage. Hashes do not reconstruct content. Proposed quote cap is 240 Unicode
scalars; prefix/suffix 80 each; resolver never scans an unbounded remote document.

The search producer retains the selected original range before display-line
normalization. Do not find an offset in the displayed wikilink label and apply
it to raw Markdown. Rust resolves version/path/read scope; frontend maps raw
source spans through editor block/title projection into UTF-16 transaction
positions. If a custom carrier has no reliable position map, open the source
context with an explicit unsupported-reveal state, not a wrong selection.

Version evidence is captured by the existing
[corpus changed-file read](../../../src-tauri/src/vault/corpus.rs), which already
derives entry and body from the same bytes. Extend its cached `CorpusText` with
`SourceSnapshot {rawSha256, carrier, bodyStartUtf8, searchedBodyBytes, capped}`:
`rawSha256` is lowercase hexadecimal SHA-256 of the complete raw read, before
frontmatter removal/body capping; `carrier` is Markdown or an explicit unsupported
tag. Markdown body start and searched byte count refer to that same read. Failed
reads have no source snapshot. Keep path, snapshot, metadata, body and selected
raw occurrence together through `Kept` and ranking; `SourceLocator.sourceHash`
equals that snapshot's `rawSha256`. A later read must never stamp
a new hash onto an older hit. Original excerpt-window offsets are retained before
`display_line`/ellipsis normalization, with raw ranges checked inside the searched
body. Unchanged-file cache hits reuse the same source snapshot without rereading.
Resolution may read newer bytes and report changed/relocated; that never rewrites
which version the search result originally observed. Board/Mermaid search carriers
remain unsupported in v1 rather than receiving Markdown offsets.

On equal hash, validate range and quote then reveal exactly. On changed hash,
try only a unique exact quote plus recorded context in the readable source;
label it relocated. Multiple/no candidates return changed. A moved file may be
found through a proven source identity mapping; a matching filename alone is not
proof of the move. Revoke read access first, then return unavailable without
leaking cached excerpt text. Imported source identity is preserved, not promoted.

Property locations reveal the existing metadata row, not an invented body range
or an exact array element. Quote/context come from the same `searchable_fields`
flattening used by production search. With equal file hash, validate the key and
searchable value then focus the read-only row anchor without entering edit mode.
After a file change, the same key plus uniquely matching recorded value context
permits a relocated row; a renamed/missing key or changed/ambiguous value returns
changed. Never guess a key rename. Arrays/relations may be shown in full by that
row, with no claim that a specific flattened member was selected. The current
DocProperties/RecordPageProperties owner expands the necessary property section;
unsupported or unreadable fields show source-context/unavailable instead. This
does not create another property editor or silently change saved field visibility.

The initial scope is local Markdown body/property. PDFs may later use page/text
coordinates and office extracts part/paragraph IDs with extraction version; they
must be new tagged carrier versions with their own resolution tests. Remote URLs
without retained bytes/provider revision show live/unknown version rather than
fabricating a stable location. [CHAT](2026-10-23-m95-chat-and-supervised-agents-design.md)
stores references and its own disclosed context receipts, not a rival locator.

### Source opening and return ownership

The current [Quick Open](../../../src/app/QuickOpen.tsx) unmounts on close and
keeps its query/selection locally; ordinary page visit state cannot reconstruct
it. Add a bounded session-only origin snapshot, held by the existing navigation
visit/request owner, with no query or excerpt persistence:

```text
QuickOpenSnapshot { query, category, level, expandedFor, activeRowKey, scrollTop }
SourceReturnOrigin =
  Visit { vaultId, pane, visitId } |
  QuickOpen { vaultId, pane, visitId, snapshot: QuickOpenSnapshot } |
  Conversation { vaultId, threadId, turnId, presentation, scrollAnchor }
SourceOpenRequest { requestId, locator, origin, intent: default|full_page|beside }
openSource(request) -> Promise<NavOutcome>
returnToSourceOrigin(requestId) -> Promise<restored|origin_unavailable>
```

M97.2 implementation ruling (2026-10-23): source opening awaits the existing scoped resolver before navigation. The UI has a vault path, while locators carry registered vault IDs; treating those as equal would permit a foreign locator to open an unrelated same-relative path. Async preflight retains the originating pane/visit and cancels on superseding requests, input, navigation or any vault transition, including A → B → A. Editor readiness still revalidates source/version before reveal.

`src/app/sourceOpen.ts` coordinates the existing `useOpenPath`, `navigateIn`,
`openPane` and peek APIs through `useSourceNavigation()`, which returns the
`openSource`/`returnToSourceOrigin` functions above. Bind existing hooks during
render; never call `useOpenPath` as an ordinary function during dispatch. This
coordinator is not a replacement routing service. The existing
visit state owns pending reveal/return records; Quick Open accepts a one-shot
resume snapshot. Keep at most one request/origin per retained source visit or
live peek generation, replacing superseded records and clearing with that owner.
Bind the request to the **actual** resulting editor holder or
peek owner/generation, including unchanged/reused `NavOutcome`, rather than only
to a newly allocated visit. One editor per path remains authoritative. A later
request for that holder supersedes an unrevealed earlier one; source deletion,
vault switch or owner replacement cancels stale work. An explicit person action
may focus the holder, but delayed readiness never steals focus after they move
elsewhere. A parked holder is activated through existing pane rules.

“Return to results” restores the originating visit and reopens Quick Open with
query/category/level/expanded results/active row/list scroll; if results changed,
retain the query and choose a surviving row. Ordinary Back keeps page-visit
semantics rather than reopening unrelated dialogs. Peek promotion transfers the
pending reveal/return record to the promoted owner. Missing origins say unavailable
and leave a usable source page. Conversation return references existing thread,
draft and scroll ownership without copying its draft. M92's primary source action
still jumps to its citing turn inside canvas; only its explicit secondary source
open uses this coordinator after floating as M92 requires.

## Manifest ownership and user experience

`RunConfigurationManifestV1` records run/vault identity, dispatch time, effective
grant, policy/artifact digests, Agent/Skill identity and content hashes, requested
and observed model/CLI version, connector spec identities and known configuration
limits. Proposed encoded cap: 64 KiB. The writer fails with an operational
diagnostic if a required field cannot be recorded; optional missing observations
are explicitly unknown. Truncation is field-specific and declared, never silent.
No secret/environment/header values or instruction bodies are retained in v1.
Hash-only history cannot reconstruct old instructions; comparison says so.

The Rust dispatch path writes the manifest through the runtime writer before
starting a child process. Read-only readers return a versioned manifest or
not-recorded/unavailable. Existing pre-write receipts still govern individual
writes; the manifest is observational, not an authorization token.

“Configuration used” shows the original grant and known configuration alongside
today's version, with changed/not-recorded labels. “Why this evidence” renders
the existing assembly manifest's selected items, intents, caps and contradiction
disposition. Ordinary chat context is a separate section labeled by its coverage.
Source details show review/freshness/support as separate facts. A low or high
numeric confidence is not a substitute for those facts.

Keep source identity distinct from event-level evidence. The compact existing
[source collector](../../../src/engine/ai/sources.ts) keeps the first `via` for a
deduplicated source; it cannot prove that a later fetch, read or citation occurred.
The inspector consumes `EvidenceObservation {id, ref: EvidenceRef, attemptId?,
toolCallId?, turnId?, assemblyItemId?, basisRef?}` from CHAT delivery/read receipts
or the assembly producer, with IDs stable across replay. Multiple observations
for the same source/version retain their roles and failed/not-read outcomes;
display grouping never promotes search-only or failed-fetch evidence to read.
`selected` comes from selection/assembly, `encountered` from returned discovery,
`read` from recorded successful delivery, and `cited` from the particular answer's
explicit reference. `supporting` requires a named recorded claim/basis judgment
(`basisRef`), labeled as such; a link, read or model assertion alone is insufficient
and never grants human verification. Legacy compact lists retain limited-coverage
labels. M91/M92's display lists and rail do not become a second receipt producer.

Repair the existing [resource adapter](../../../src/agent/elements/decisionsSources.ts)
under its owning M91/M92 handoff: `ResourceTarget = VaultPage {path} |
ExternalUrl {url} | MissingLocal {path} | Descriptor {text}`. Only a proven current
vault page gets local file/open semantics; safe HTTP(S) links retain their policy.
A scope such as “all queries in project X” is plain descriptor text, not a file
icon or passage request. Unresolved path-shaped references say missing rather
than becoming descriptors or clickable pages. Extend the existing
[citation/resource target helper](../../../src/editor/citations.ts) and shared
fixtures rather than adding a second classifier in Knowledge. Explicit rooted
local paths and recognized file-path references can be marked missing; ambiguous
legacy strings remain non-clickable descriptors without a claim of file identity.
Unknown/unsafe schemes stay inert text. Pass this classification through
`ResourceRow`/Knowledge presentation without creating an epistemic relationship,
changing citation numbers or adding another property/Verify writer. AI elements
stay presentation-only; any primitive prop extension is reviewed with its shared
consumers rather than silently changing M92's source contract.

Backlink rows show a bounded excerpt and open the recorded occurrence. Mention
discovery runs only on request, inside readable scope, with a proposed 50-result
page and explicit continuation/truncation. Resolve filenames/keys/titles through
the existing link rules, not ad hoc lowercased matching. Creating a suggested
link is a normal human edit with the current writer and undo semantics.

The current [backlink index](../../../src/engine/links.ts) intentionally dedupes
body links by source/target and stores entry/via only. Keep that cheap summary;
exact landing uses a new bounded on-demand Rust occurrence producer over raw
corpus snapshots, not guessed offsets reconstructed from the index:

```text
SourceOccurrence { id, location: SourceLocator, targetPath, targetFragment?, via }
OccurrencePage = Ready { snapshotId, rows, nextCursor, truncated, counts } |
                 ChangedSnapshot { reason }
counts = { shownOccurrences, shownPages, examinedSources,
           cappedSources, unavailableSources, unsupportedSources }
find_source_occurrences(scope, targetPath, mode: linked|mention, cursor?)
  -> Result<OccurrencePage, SourceReadError>
find_mentions(scope, targetPath, cursor?) -> Result<OccurrencePage, SourceReadError>
```

`find_mentions` delegates to the same occurrence query in mention mode. The page
cap is 50. Proposed shared per-page work caps are 500 examined sources and 8 MiB
of examined searchable bytes, stopping at whichever limit is reached first;
retain the corpus's 100 KiB per-body cap. Encode these in the shared artifact,
review them against scale fixtures before acceptance, and disclose skipped/capped
carriers. A work-limit stop returns a continuation cursor and `truncated`, even
with zero matching rows; an exhausted corpus alone ends continuation. This bounds
query scanning after the existing corpus snapshot, not corpus loading itself.
Occurrence IDs derive from source path/hash plus raw range, or property key for row-level
relations; repeating body links remain separate. Sort by source path then carrier,
property key/range. Bind opaque cursors to target identity, mode, readable-scope
digest and corpus snapshot identity; a changed corpus/scope returns ChangedSnapshot
and requires explicit refresh without retaining revoked excerpt text. Counts name
pages versus occurrences and disclose truncation/unavailable sources, never claim complete absence
after a scan/read failure. Link target resolution, aliases and fragments use the
existing shared target rules. A mention is only a text occurrence until a person
chooses an existing human link writer.

## Evaluation contract

Start with twelve versioned scenarios: find/cite a passage; preserve repeated
occurrence; answer with counterevidence; abstain on unavailable evidence; recover
a failed save; scope an old Agent run; deny stale content; queue unattended
ask-first work; handle a failed child; repair expired connector auth; create a
mail draft without sending; and reconcile remote success with lost response.
The last scenario consumes M96's deterministic adapter, not a real account in CI.
Add moved/deleted sources, imported prompt injection and hidden cross-vault content
as adversarial variants. Fixtures declare expected sources, allowed effects,
forbidden writes, review requirements, final artifacts and known/unknown usage.

Offline replay uses deterministic inputs and real production guards/reducers.
Each hard assertion has a negative control that demonstrably fails when the
assertion is violated. Live runs use the user's own CLI in explicitly disposable
vaults/accounts, recorded through the existing kit and sanitized before retention.
They are opt-in at execution time; skipped or unavailable cases do not pass.
Record CLI/model/policy/build identity, raw outcomes, time/cost availability and
variance over at least three runs per selected task (proposed starting sample,
not a statistical reliability guarantee).

Retrieval labels identify relevant and contradictory passages for exact wording,
paraphrase, accent variants, aliases, long sources, imports, heterogeneous records
and unanswerable queries. Report recall at the real production cap, supported
answers, counterevidence coverage, scope leakage, latency and abstention separately.
No invented quality percentage is a release threshold before the first reviewed
baseline. Zero forbidden effects and zero scope leakage are hard fixture gates;
model/human quality judgments cannot override them.

Optimization candidates retain exact-match priority and raw-position mapping.
Token/corpus caches invalidate on bytes/schema/scope; embeddings must justify
locality, deletion, incremental cost and relevance benefit. Original-attachment
search is opt-in and uses bounded contained extraction; failure is not no matches.
Global graph, flashcard recall and broad semantic relation writes remain deferred.

## Privacy, acceptance and dependencies

There is no general completed-run purge contract established by this review.
Proposed configuration-manifest lifecycle: retain completed manifests for 90 days,
with a 64 MiB per-vault serialized-payload budget; expire oldest completed manifests
first and never evict an active run's manifest. If active manifests exhaust the
budget, new capture fails explicitly before launch rather than silently running
without required evidence. Keep a small expiry/not-recorded reason on the run;
do not purge the run itself. ACT owns any independently required unresolved-effect
receipts. M97.3 owns this new bounded lifecycle, including migration, clock,
quota, explicit deletion and SELECT-only read states; it is an owner proposal,
not a description of existing retention. No prompt bodies are archived.
Source excerpts use the conversation's approved content
retention or are resolved on demand; revocation hides them in either case.
Scenario artifacts are synthetic or sanitized, stored outside real vaults. Import
and verification gates retain their existing semantics.

Acceptance requires Unicode/repeated/stale/title/property/source-carrier cases in
both languages; a complete search/citation/Back journey; unavailable manifest and
revoked evidence states; immutable dispatch evidence after Agent edits; and a
reproducible offline report with negative controls. Live quality and native source
reveal remain separately recorded. M93 owns save/history/native/scale repair, M95
context and CLI normalization, M96 effects, and M98 preview/rehearsal. This draft
does not claim new retrieval scores, successful live tasks or native validation.

M97.2 repair contract amendment: Return awaits the existing save decision and revalidates the live visit/layout before reporting its outcome or reopening results. If the origin file is now held in another pane, reuse that holder instead of creating a second editor. A superseding navigation/return cancels the older result. This async return signature is required because dirty save acknowledgement can arrive later.
