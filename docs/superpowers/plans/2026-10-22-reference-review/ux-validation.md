# Independent UX and journey validation

Date: 2026-10-22. This review cross-checks the five reference dossiers and the
strengthening plan against Cerebro's current working files and the
[M84–M90 implementation record](../2026-10-17-m84-m90-implementation-record.md).
It is a source review, not a new browser, native, assistive-technology or aesthetic
acceptance pass. No application or reference repository was run. Existing test
results and timings below are historical evidence with the limits recorded there.

The plan's main direction is sound: finish dependable writing, finding evidence,
and understanding agent work before adding more destinations. Four corrections
make it more actionable: include the assistant's false CLI-missing state in the
first reliability wave; describe existing forms, templates and concept evidence
accurately; make source-byte preservation an explicit writer contract; and choose
large-table rendering from acceptance evidence rather than from reference parity.

## Confirmed reliability and usability priorities

**CP01 is justified, with its current evidence qualifier retained.**
[`MarkdownEditor.tsx`](../../../../src/editor/MarkdownEditor.tsx), lines 671–720,
marks serialized text as `lastSaved` before the save settles and only emits from a
flush when a timer was pending. [`NoteBodyEditor.tsx`](../../../../src/editor/NoteBodyEditor.tsx),
lines 299–332, reports a failed save but does not retain a retry payload in that
failure branch. This supports the missing recovery-path finding. It does not prove
a native data-loss incident occurred. The useful acceptance journey is a settled
autosave failure, writer recovery, and Save without another edit, followed by
navigation or quit. A test that merely sees a toast does not close that journey.

The fix must keep the exact latest draft discoverable, associate the error with its
page, and distinguish acknowledged disk state from a completed attempt. A Retry
control should remain available after the toast disappears. Preserve the existing
one-editor ownership, reconciliation holds and deliberate human-save winner.
Persistent crash recovery remains a separately scoped retention decision.

**CP02 describes real presentation defects.**
[`AgentRunHistory.tsx`](../../../../src/status/AgentRunHistory.tsx), lines 29–75,
loads an unfiltered global page before filtering by actor, hides a failed detail
request, and does not fence competing detail replies. Its empty copy can therefore
be wrong even though the underlying records exist. Separately,
[`RunDetailPanel.tsx`](../../../../src/status/RunDetailPanel.tsx), lines 72–98,
maps a failed knowledge read into the same value used for not-recorded information.
The comment explicitly endorsing that collapse should change with the fix.

Repair server-side scope and selected-request identity first. Pagination is a
follow-on part of the same journey, with honest continuation information. Ordinary
agent pages need the vault plus actor scope; construct pages need their documented
scope, not an accidental global query. Preserve cross-actor lineage through a
separate bounded read. Every healthy detail section should survive another
section's failure, and Retry should repair the failing read without losing the
chosen run or keyboard position.

**Add CLI readiness to the first reliability wave.** Tolaria T6 identifies a
concrete omission from the combined queue. In
[`AiPanel.tsx`](../../../../src/agent/AiPanel.tsx), lines 1010–1014, a rejected
`checkAgent()` becomes `installed: false`; lines 1534–1554 then instruct the person
to install and reopen Cerebro. In contrast,
[`ClaudeCodeRow.tsx`](../../../../src/pages/ClaudeCodeRow.tsx), lines 9–38 and
55–79, distinguishes a failed check from a missing executable. These surfaces can
disagree about the same machine. This is an incorrect diagnosis, not merely an
optional onboarding improvement.

Use shared checking, available, missing and unavailable states with a deliberate
Recheck action and stale-response protection. Installation guidance belongs only
to a completed missing result. A successful executable/version probe does not
establish authentication; retain the existing runtime sign-in failure handling.
Acceptance covers rejection, hung checks, an executable installed while the app is
open, PATH changes, and repeated rechecks. A failed check must never tell the user
that installation is absent. This work can precede live approval acceptance and
does not require an onboarding wizard or a provider selector.

## Reclassify feature parity before adding scope

The dossiers mostly make these distinctions correctly; their more ambitious
individual rankings should not override the narrower combined plan.

| Suggested area                      | Current evidence                                                                                                                                                                    | Correct remaining question                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Forms and structured creation       | `RecordComposer.tsx` already owns typed local drafts, defaults, validation, similar-record suggestions and a same-tick duplicate-submit guard.                                      | Does a repeated task need a saved field subset/order and defaults? Test that task before introducing an intake carrier. |
| Templates and AI-assisted scaffolds | `lib/templates.ts` copies body/frontmatter, substitutes title/date and defines editable `fill:` instructions. `DocPage.tsx` exposes a blank-page template bar and Save as template. | Improve discovery or a demonstrated template workflow; do not implement templates again.                                |
| Capture                             | `lib/capture.ts` deliberately creates an untyped Inbox page; the New launcher explains destinations.                                                                                | Capture from another application is a distinct native entry point, not a missing capture model.                         |
| Search                              | Quick Open already has ranked excerpts, marked matches and partial-coverage wording.                                                                                                | Carry the scored location through to the page and measure relevance, not add a search destination simply for parity.    |
| Concept evidence                    | `ConceptReviewBar.tsx:245–262` exposes a source-count button; `ConceptDetails.tsx` renders `KnowledgePanel` provenance.                                                             | Improve passage-level navigation and run/answer evidence disclosure; do not create another concept evidence panel.      |

Saved intake, global capture and additional recipes remain CP12 candidates. Pick
one from an observed failed or slow task. A useful trial compares completing that
same task with the existing composer/template against the proposed shortcut. Mere
presence in Thought Desk or Morrow is insufficient to raise it above recoverable
writing or correct run history. Likewise, optional calendar overlays, personal
recall and deterministic rules should stay separate product decisions.

## Preserve the implemented shell, title and panel anatomy

The staged working tree is the comparison baseline. The rail/context-sidebar
shell, floating/docked/canvas assistant, first-H1 title projection and stable
metadata portal already exist. [`DocSidePanel.tsx`](../../../../src/detail/DocSidePanel.tsx)
and [`pageFrame.css`](../../../../src/components/pageFrame.css) implement one
full-height slot selected by Details, Comments or History. The outline is on the
page. These are adopted designs, not missing components or an invitation to add
another sidebar.

CP05 should deepen the current navigation seam. Quick Open's content row opens
`hit.path` without its excerpt location (`QuickOpen.tsx:353–371`), while
[`sectionLinks.ts`](../../../../src/editor/sectionLinks.ts) already carries
one-shot heading reveals across lazy readiness. Reuse that lifecycle, extending
the target contract for repeated passages, source versions and property hits.
Do not assume a display offset equals a Markdown offset after title projection.
Opening an existing file should focus its current holder, not create another
editor. Passive highlighting must not replace an unsaved editing selection.

For CP07, distinguish three facts in the user's words: what the agent was allowed
to do, what evidence it saw, and what it actually changed. Existing concept
provenance is not a complete run manifest; an assembly manifest is not the entire
ordinary-chat context. Show only the completeness each source establishes.
Source counts should continue opening existing Details, with snippets and exact
landing added there where useful. Review/Verify remains a separate human action;
neither an answer citation nor a similarity result should imply verification.

## Make source editing a precise ownership and byte contract

CP11 solves a valid problem: the current loss warning protects unsupported Markdown
but mainly offers explicit rich-edit adoption as the next writing action. However,
“use the actual file bytes” is not enough to guarantee a byte-preserving edit.

The exact whole-file reader **already exists**:
[`readNoteSource`](../../../../src/lib/ipc.ts), lines 124–130, returns source and
its hash from one read; Rust's `read_note_source` includes frontmatter and BOM
(`vault/write.rs:1882–1889`). Reuse it. The ordinary editor's `loaded.body` is an
unsuitable raw-source seed because it removes leading newlines
(`NoteBodyEditor.tsx:254–263`). An existing unsaved rich draft also cannot be
replaced by a new disk read merely because the person switches modes.

The write side needs an explicit decision. `save_note` replaces the body while
retaining existing frontmatter semantics (`vault/write.rs:1502–1536`), but its
split/compose path does not preserve every source byte.
[`parse.rs`](../../../../src-tauri/src/vault/parse.rs), lines 9–14, documents
normalization of CRLF fences, BOM and trailing whitespace on the closing fence.
Consequently, wiring a textarea to `saveNote` is not proof that unrelated bytes
survive. A narrowly guarded replacement of the actual body span, or an explicitly
limited supported-byte contract, is needed before making that promise.

The first source mode should keep metadata under its existing writers. A whole-file
frontmatter editor would be a larger authority change, especially for Agent grants,
import provenance and concepts. It is not implied by an escape hatch for an
unsupported body. Acceptance must compare exact unaffected bytes for CRLF/BOM,
empty frontmatter, trailing fence whitespace, leading body blanks and unknown
fences. Also test dirty mode switches, external writes, failed saves, undo, title
projection and quit. Switching presentation itself must produce no write, second
owner, silent draft replacement or accidental rich normalization.

## Scale is an interaction contract, not a library choice

CP04 is correctly above optional knowledge visualizations. The recorded production
p95 values—398.8 ms at 1,000×12 and 1,376.2 ms at 1,000×24—are unmet historical
targets, not fresh measurements. The previous containment experiment removed an
offscreen row from Chromium's accessibility tree and was rejected. That evidence
is more relevant than a reference's use of a virtualizer.

Thought Desk's proposed viewport model and Tolaria's virtual list are candidates,
not prescribed implementations. Cerebro currently provides logical keyboard End
and active-descendant targets (`views/useRowKeyboard.ts:292–363`). A faster list
that limits End to mounted rows, drops a rejected cell draft, or hides corrections
from assistive reading regresses existing behavior. Profile derivation,
subscriptions, layout and parsing separately; compare paging with bounded rendering
if necessary. Disclose the selected browse/search behavior rather than silently
removing browser find.

Use one mixed journey after the initial isolated baseline: filter a large table,
edit and reject a value, reach its final logical row, open a page beside it, reveal
a source, and return while an assistant thread streams. Check draft identity,
focus, frozen columns, wrapping, scroll restoration and accessible reading as well
as timing. Native VoiceOver, IME and WKWebView measurements remain separate from
browser assertions. A new rendering approach requires both proofs.

## Acceptance and ordering corrections

Keep the first implementation cycle small: failed-save characterization and
recovery; history scope/read states; CLI readiness truthfulness; retained performance
baseline; native-access preparation; and the first deterministic task fixtures.
Do not make these repairs wait for isolated agent rehearsal. Conversely, a
read-only instruction test must not be advertised as proving production writes.

Use complete journeys as the review units:

1. **Write → failure → Retry → leave → reopen:** the exact latest text survives,
   acknowledged state is accurate, and an earlier failure is considered at quit.
2. **Search → passage → Details → source → Back:** the intended occurrence is
   revealed, provenance and review state stay distinct, changed sources fall back
   honestly, and the result query/place is retained.
3. **Set up CLI → draft agent → preview → enable → run → inspect:** unavailable
   setup checks are recoverable; preview has no effects; historical scope and
   configuration are inspectable; failed sections remain visible with Retry.
4. **Large view → rejected edit → last row → pane switch → return:** keyboard and
   assistive navigation reach logical content, exact drafts remain attached to
   their fields, and measured responsiveness meets the declared workload budget.

Across these, preserve the five reading states, 200% zoom, narrow drawers, explicit
focus restoration and reduced motion. M84–M90's pending owner aesthetic review is
still pending; source inspection cannot close it. The references support clearer
feedback and continuity within Cerebro's current design, not another shell,
general workflow canvas, confidence score, whole-vault graph or duplicate content
store.
