# M93–M99 — Implementation record

Status: **In progress; no milestone is complete.**

The owner authorized implementation on 2026-10-23 on the existing `m53-macro-port`
branch alongside Claude's M92 work. Starting source identity:
`6c92709187ee0f1c54a049be23b7717eeb3dfcae`. The execution follows the
[master roadmap](2026-10-23-m93-m99-master-roadmap.md) and its paired milestone
specifications. This record distinguishes implemented work, reviewed work and
release evidence; a passing test count does not close an unresolved review finding.

On 2026-10-25, the owner directed that raw acceptance runs, browser captures,
logs and copied source snapshots stay local and Git-ignored. Links below into
`docs/acceptance/`, capture directories and raw reports refer to those local
files; they are unavailable in a fresh checkout. Maintained plans, specs,
decisions and the result summaries in this record remain tracked.

## Current disposition

Last reconciled: 2026-10-27. Bounded implementation results; no milestone is complete.

| Milestone                                | Implemented and checked                                                                                                                                                                                                                                            | Work still open                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M93 — Reliable workspace                 | Save/recovery/history repairs reviewed; prepared selection comparison and original 60 browser checks accepted. Closed native consumer: 18 tests; IPC audit: 117 checks passed                                                                                      | Native quit/dialog/participant acceptance, measured scale, accessibility and aggregate gates                                                                     |
| M94 — UI polish and journeys             | Approved five-surface composition; 32-case correction and six Settings cases pass. Missing-database repair passes 35 component and four browser cases across both engines/themes, with all eight captures inspected                                                                                                     | Broader surfaces and journeys, accessibility and native acceptance                                                                                               |
| M95 — Chat and supervised agents | Delegation, restart recovery and historical inspection; native logical-generation admission and lifecycle pass 15 runtime, seven native, two interaction-link and one cancellation-race checks. Frontend ownership passes 173 focused and 819 affected mock/IPC checks; full typecheck and scoped lint pass | Unresolved-effect guard integration, real CLI recovery, Stop/shutdown, backend isolation, archive integration and remaining controls. Public jobs stay disabled |
| M96 — Connectors, MCP and actions | Fixed GitHub adapter and shared effect kernel checks pass. Original held-call ownership, edited approval, access grants and exact MCP cancellation controls pass. Credential and per-run access dialogs pass browser previews in Chromium and WebKit | Per-action catalog bindings pass; actual held MCP Allow/Stop/window-close fixtures pass; real provider/credential acceptance is open. Earlier disposable Keychain put remains uncertain and cleanup-pending |
| M97 — Knowledge, evidence and evaluation | Independent relevance-label review; twelve-query native baseline and measured accent experiment accepted within its local limits. Search 53, source location four, native controls six and harness 115 checks pass | Wider source and outcome acceptance, opt-in live answer-quality evidence and retention/aggregate gates |
| M98 — Workflows and automation | Definitions, sequential runner, retained worker, original run controls, active cancellation, timer ownership, file commands and scoped views pass their focused native groups. Publication preserves exact JSON numeric tokens | Library draft authoring passes focused and display-browser checks; native runtime controls are being integrated. Enable/restart scheduling, preview/rehearsal disposition and native journeys remain open. Completed-detail retention remains Off |
| M99 — Rust services and storage | Native backup coordinator and portable-copy checks pass; backup UI passes both-browser preview. Selected semantic readers pass 37 checks, selected search 15 and baseline readers 38. Selected checklist/title CAS and retained recovery pass focused checks | Remaining metadata consumer adoption, native backup chooser acceptance, migration/rollback/export and activation. Current-vault conversion remains unauthorized |

The original M94 44-case run remains **43 passed, one failed**; its focused
four-case follow-up closes the resize-test synchronization and row-readability
review only. The original M95 eight-case run remains **seven passed, one failed**;
the focused two-case follow-up reaches raw reveal, inspection, close/focus and
no-duplicate assertions in both engines. Neither follow-up creates a passing
rerun of its original aggregate. Stable browser inputs and qualified cleanup were
accepted separately.

Native tooling integration also passes the fresh quit-asset build, 11 build
contract checks and full lint, with stable registered targets and native producer
inputs. The current quit runner also passes its two fixed ownership controls and
independent review. All seven synthetic native private-output cases pass under
the separately qualified owner, including the real timeout, cancellation and
disposal paths. The earlier driver remains test-only. The 2026-10-26 continuation adds the
production adapter and retained owner wiring, while test builds require an explicit
fixture. Native quit timing and real-account acceptance remain open.

The cleanup receipt records 4,690 generated-artifact additions unstaged while
local files and maintained source were preserved. Staged entries changed from
5,480 to 791 at that checkpoint, including the ignore update. Raw evidence stays
local and ignored; maintained results and decisions remain tracked.

## Integration checks — 2026-10-27

The canonical scan correction passes all 125 selected metadata checks, all
37 selected semantic regressions and all 15 search cases, including public-search
privacy. The first canonical frontend consumer group passes 46 cases, including
actual Rust-produced read/write fixtures, exact Decimal and Date presentation,
missing-carrier refusal and stale full-width acknowledgement invalidation. The
initial expanded affected group passed 591 of 592 checks, failing checkbox Done
focus. The unchanged production code then passed the isolated instrumented case
and all 592 affected checks with focus tracing; the earlier failure remains
recorded and final verification without instrumentation is pending. Full
TypeScript checking passes. Native saved-view consumer adoption remains in progress. Number and Date each
pass four browser cases across both engines and themes; the read-only reason/Done
spacing follow-up passes its focused WebKit visual check.

Workflow document reads preserve the tombstone publication revision: all
11 document cases pass. All 19 retained publication/recovery cases pass.
The public Unpublish route and Library action are integrated; all 63 workflow
editor, Library and schedule checks pass. The corrected IPC suite now passes all
137 checks, including six new native-fixture bypass controls; the earlier three audit failures
remain recorded. Step reorder and explicit historical manual-run selection now
pass all 15 Library checks, alongside six shared Button checks. The corrected native publication/Enable group passes all 23 cases, including
refusal of unpublished and superseded versions and original-request replay. The native pinned-version workflow journey now passes eight bounded cases: a run
waits on its original published version, the definition is edited and unpublished,
and explicit Continue completes the original run with its original version. The
actual native database records one run, two steps, one consumed wait and no
retained bodies, reservations, effects or grants. Independent review verified
the source, binary, output and process-cleanup evidence. This closes that
fixed journey only; automatic Enable/restart and provider journeys remain open.
Completed workflow-detail retention remains off and undecided.

The corrected archive UI group now passes all 453 affected checks and full
TypeScript checking at that source revision. Confirmed cache pairs are cleared
without rewriting unconfirmed sibling messages or unknown thread fields; raw
reasoning and tool-payload edits invalidate a previously checked copy. Four browser cases cover its five states across
Chromium/WebKit and light/dark themes, with representative originals inspected.
The first 433/436 run remains failed historical evidence. Native archive readers
pass eight cases, retention six, body codecs seven and terminal/resume handling
five. The per-vault capacity fix passes its full 256 MiB test across two store
identities without eviction or cross-store reads. Generated import field names
now match actual serialization. Legacy import now passes all 15 cases, including explicit cache copies for
completed turns whose bodies were not archived, original timing preservation and
cursor pagination. The same-thread cache preservation finding is closed by those frontend checks.
The actual native ACT regression reproduced a closed-run effect-owner guard gap.
Its correction now passes all four ACT checks plus 15 import, five archive-core,
eight read and six retention regressions. Independent source review found no
blocker. The explicit import browser journey is being verified. No current-vault retention setting or imported content has
been changed.

The isolated late-350 ms native quit observation passes its expected deadline
boundary and independent cleanup review. It does not prove real editor/disk or
packaged-app acceptance. Three fresh managed connector journeys now pass through
the actual native opening, original run and held MCP approval route. Allow admits
exactly one fixed fake-provider entry and records its expected successful output.
Stop and window close each refuse a late answer and admit zero provider entries.
Each journey passes six semantic cases, exact source/binary checks and independent
cleanup review. The fixed provider performs no real credential or network access.
These results do not establish real-account or packaged-app acceptance.

The earlier deliberately failed provider result remains failed historical evidence.
The three successful journeys each exited naturally, were reaped, and had their
exact main process, owned child and process group observed absent. Attempted
cleanup signals returned EPERM; those remain failed signals, not claimed delivery.
Normal Rust compilation passes with 23 warnings at the prior integration checkpoint;
strict Clippy and aggregate release gates remain open.

## Metadata, archive and publication integration — 2026-10-26

The latest native integration passes all 120 selected metadata cases, including
exact Decimal and calendar Date writes, explicit removal, original-request recovery
and prior controls. The metadata UI passes 107 related checks and full TypeScript
checking after repairing keyboard focus when Check save removes its initiating
button. Date presentation and the real-browser focus follow-up are still being
verified. Selected-vault scanning still projects the entire metadata object through
the legacy scalar adapter; exact numbers outside that adapter's domain expose a
remaining scan/presentation gap. These write checks do not establish complete
selected-storage adoption or authorize converting the current vault.

Workflow Unpublish storage passes 36 file cases and 44 journal cases. The file
pointer keeps monotonic publication revisions and an explicit tombstone; the
journal atomically pauses automatic admission and records recovery progress.
The retained native coordinator and public UI wiring remain in progress. The
schedule preview separately passes four browser cases across Chromium/WebKit and
light/dark themes; its fixture does not establish a native running schedule.

Archive read/search/export projection passes six native cases, including literal
search characters, bounded pages and per-attempt CLI sessions. The actual branch
anchor test passes; an older codec control exposes an unresolved distinction
between invalid optional anchor metadata and retained body completeness. The V50
import schema preserves migration history and existing workflow inputs; three
explicit legacy-cache import cases still fail at the unimplemented writer. UI
review also found late-read expiry races, now being repaired before adoption.
The archive remains off for the current vault.

The corrected native-command inventory group passes all 48 checks. Missing
workflow/managed command rows were an inventory gap, not evidence that legacy
commands had been blocked: the outer guard delegates no-root/legacy requests to
the existing authenticated handlers and rejects selected storage. The earlier
contrary explanation and no-root assertion were incorrect and are withdrawn.
Neither that inventory correction nor the smoke-window background-scheduling
parity fix proves the cause of the failed native quit or managed-access attempts.
Fresh desktop acceptance remains outstanding. Normal Rust compilation passes;
32 production warnings remain, so this is not a strict Clippy pass.

## 2026-10-26 integration follow-through

The next native integration run compiled its test binary and normal library,
regenerated policy digests and workspace/workflow contracts with the actual Rust
producers, and verified those generated inputs before behavioral checks. It passed
all eight fresh-schema staging cases, 22 existing staging cases, four original
workflow-access reads, 93 original workflow ownership cases, three MCP response
ownership cases, 53 action-policy cases, four original action-preparation cases,
16 effect-kernel cases, 26 held-call cases and eight MCP cancellation controls.
Normal compilation still reports warnings; this is not a strict Clippy pass.

The requested-property reader now passes the eleven previously failing cases;
its corrected 39-case group now passes all cases, including a stored object under
a Text declaration remaining visible but read-only. The retained metadata owner
passes twelve cases; mounted property adoption remains in progress. All 38 selected-reader
regressions pass. An initial inactive schema-4 stage rejects even valid no-op
request history without changing ordinary portable-backup history rules.

The fresh combined browser run passes all 58 cases with no skips, retries or flaky
results: 48 utility composition and keyboard-focus checks, eight chat-recovery
checks and two workflow-authoring journeys across Chromium and WebKit. A scoped
parent-owned focus handoff keeps End/Home on the selected Library tab across the
page-owner change. The four focus captures and representative narrow/light/dark
screens were inspected. The earlier 52-case run and historical 43/44 and 7/8
reports remain failed historical observations; this new aggregate supplies the
passing regression result. These browser fixtures do not establish native runtime
or provider acceptance.

The numeric first-run handle zero correction passes two native checks. Shared
tool status ownership passes all 37 native policy checks. The focused frontend
integration passes all 446 tests, with no skipped cases, plus the full TypeScript
check. This includes original-run access selectors, stale review identity,
monotonic account/query/whole-vault ceilings, Library navigation and actual IPC
contracts. Native production compilation passes but still has warnings.

The pure awake-schedule decision now passes all 23 cases. Native activation
bindings pass 26, atomic scheduled occurrences pass 24, workflow storage passes
32 and the original native workflow group passes 117 (including those 24 occurrence
cases). The migration history passes, including the separate V47 active-FLOW
preservation check. The retained worker now passes all eighteen queue/dispatcher checks and eight
original reserved-claim checks. Capacity is reserved before storage work, exact
cancellation tokens are rechecked around the original transaction, and the running
dispatcher avoids its own join lock. The actual automatic producer remains in
integration; these checks do not establish a running schedule.
Original-run recovery inspection now passes all 273 chat tests and the retained
metadata owner passes twelve, with full TypeScript passing. The history is a
read-only view of the captured native root: cached references are stripped, stale
answers cannot disclose details after a vault change, and unknown coverage stays
explicit. A separate real owner test reproduces the missing notification when a
property cell unmounts; the global recovery host integration is being completed.

The owner approved the opt-in conversation archive on 2026-10-26. It remains off
for the current vault; implementation now proceeds under the recorded Off/30/90
/Forever choices and 256 MiB cap. Workflow completed-detail retention is still
awaiting the owner's choice after the optional 90-day recommendation.

The latest real desktop 150 ms cancellation attempt completed normally and
retained the original draft. Its original aggregate remains failed: the Python
validator rejected the production Boolean leave acknowledgement, and both
post-exit signal attempts returned EPERM. Corrected pure validation finds the
actual cancellation 47.316 ms before the native deadline and independently
observed original-process/group absence. Signal errors are preserved, with no
claim that those signals were delivered. Independent cleanup and timing reviews now accept a linked observation of that
immutable 150 ms run; its original failed aggregate stays unchanged. The first 350 ms attempt reached the native release but never recorded cancel
ingress before the deadline; it remains failed. The smoke configuration omitted
production background scheduling, a concrete discrepancy under correction rather
than a proved cause. The managed connector attempt likewise stopped at access
review with zero grants, invocations, receipts or provider entries; later provider
behavior is untested by that attempt. The corrected pure
supervisor/managed-report suites pass 103 and eight tests. Original retained-child
identity passes both native cases; this does not establish the managed connector
journey or provider acceptance.

The latest focused frontend group passes all 260 tests and the full TypeScript
check. It includes canonical Text and Checkbox ownership, keeping Boolean values
typed through save/recovery, closing an editor when Use current selects read-only
content, the global retained-save tray, and freezing the visible chat question
before prompt assembly. The polished shared tray passes four browser previews across Chromium/WebKit
and both themes at 360 px; all four original captures were inspected. Its long
target paths wrap, controls remain visible, and keyboard focus stays readable.
Native metadata writing now passes all 76 cases, including Boolean and exact
Email/Phone/URL strings. The Checkbox Done focus repair passes the mounted
regression. Contact controls pass four browser cases and Checkbox controls pass
four separate browser cases across both engines and themes, with representative
original captures inspected. Number authoring is the next selected metadata slice.

The approved archive's native core now passes five codec, five terminal/resume,
ten admission and fifteen generation checks, plus three source/artifact,
three ACT-owner and six retention cases. A separate real-capacity check admits
256 MiB of bounded answers and refuses the next one without eviction. Four actual
Git-close controls also pass after settlement ordering changes. Source references,
active-owner deletion guards and conservative resume coverage are repaired;
full history/settings/export consumers remain in integration. The actual Rust
exporters and TypeScript generator pass the two conversation and seven workflow
transport checks with no generated drift. The current vault remains Off.

Native activation selection passes 32 cases and schedule coverage/preview passes
37. The captured producer and six application commands are integrated. All 50
focused schedule-session, retained-owner, panel and Library tests pass, as does
full TypeScript checking. The worker passes twenty checks and reserved claims
pass eight, including an initially empty scan. Actual browser and desktop
schedule acceptance remain open. No automatic workflow is enabled by these checks.

No connector mail-send restriction is removed. These open checks keep M93–M99 open.

## Evidence recorded so far

- Bounded connector inventory repair: independent specification and quality review
  passed. Focused unit/lab checks: **242 passed**. Corrected browser rerun:
  **6 passed**. Unavailable configuration preserves existing grants and editing
  input, provides Retry, and does not claim the saved grants are absent.
- M93.1 independent specification and quality review now pass. Four reproduced
  save/reconciliation/attachment races were repaired, including a stale read
  arriving after an acknowledged save. Latest implementation checks passed
  **52 focused tests**; the unchanged independent disk-loss probe also passed.
- M93.2 common report, quit and Mermaid checks: **89 passed**. Navigation/store
  integration checks: **185 passed**. These establish the covered frontend
  behavior only. They do not close the remaining participant inventory or
  native quit-deadline acceptance.
- M93.2 latest body/Markdown/Trash/duplication checks passed **104 tests**.
  Invalid sheet preparation blocks autosave as well as explicit Save; forced
  retirement no longer silently chooses the local side of a merge conflict.
  Canvas/sheet implementation passed **77 focused tests** and **27 expanded
  canvas tests**, plus app TypeScript and scoped lint. Independent review found
  whole-page sheet-draft loss and deferred open-beside focus drift. Repairs now
  retain exact child payloads and capture the originating pane; independent
  specification/quality rereview now passes, including **17 independent checks**.
  The final sheet repair group passed **65 tests**, including the
  unchanged independent probe. Separate registry checks passed **26 tests**.
  Deletion recovery and the full participant inventory remain open.
- M93.2 scalar/title slice passed **179 focused tests** and **2 browser tests**
  before independent review found a false refusal when restoring an unchanged
  title. A second review caught correction back to the stored title after a
  refusal. Both repairs now pass independent specification/quality review:
  **32 combined field/help checks** include all three unchanged field probes.
  A retained-body guard also prevents a title write bypassing an unmounted dirty
  body (**68 store/title checks**; independent guarded-title group **4 passed**).
  Final shared gates remain separate.
- M93.3/.4 scoped native history passed **42 fleet tests** and independent
  specification/quality review with **6 focused native checks**. Frontend/mock
  integration passed **775 checks**; independent review then reproduced stale
  origin/navigation races. The latest intent-reservation repair passed **211
  tests**, including unchanged probes and the actual pane/restoration hosts;
  independent rereview is in progress.
  Matching child runs remain listing anchors; cursor scope precedes limits,
  lineage is bounded, and origin reads never invent the active vault.
- Save-before-navigation and failed-save Retry browser cases passed **2 tests**.
  Structural Mermaid preparation and explicit cancellation passed **111 tests**.
  These results do not establish packaged quit timing or crash retention.
- M94.4 specification and quality review now pass. Repairs cover resumed and
  waiting composers after pending success/failure, newer draft revisions,
  schema-hidden scalar recovery and visible proposed destinations. The final
  independent run passed **58 tests**, including both unchanged duplicate-create
  probes. Earlier browser checks passed; final shared integration is separate.
- M94.1/.2 now have [comparison evidence](../specs/2026-10-23-m94-ui-implementation/README.md).
  Four collection/utility geometry cases passed across five host widths in both
  themes, and two application baseline cases captured twelve scenes. The combined
  run passed eight tests and retained two failures in existing surface checks
  (Library golden height and a sidebar New locator). No golden was updated.
  Pages is the first application composition under verification; nine existing
  component tests pass. Property-disclosure copy now says Show all properties /
  Hide properties; **48 adjacent component checks passed**. The corrected Pages
  candidate passed **14 browser cases** across Chromium and WebKit, with a
  separate **10-case capture run** preserving evidence from concurrent M92 tests.
  The first candidate's two visual defects and its screenshots remain recorded.
  Independent UI review and broader first-slice acceptance remain open.
- M93.8 source presentation passed **109 focused tests**, native writer checks
  (**143 passed, one intentional ignored test**) and two browser cases before
  independent review found a stale source-read data-loss race. Its preserved
  probe reproduced actual disk loss, then passed unchanged after repair. The
  repaired focused group passed **110 tests**; independent rereview is pending.
  This passing count does not establish final source-editing acceptance.
- M93.6 produced four successful correctness-only smoke cases: table100×12,
  document64KiB, transcript1000 and search10000. Timing samples are withheld.
  Independent review found three tooling defects in setup deadlines, popup
  isolation and phase attribution; all three repairs passed independent rereview
  with **23 tests**, including the unchanged original stall probe. No benchmark
  improvement, numerical budget or scale experiment has been accepted.
- M93.9 recovery coverage is recorded in the [coverage decision](../../acceptance/2026-10-23-reliability/recovery-coverage.md).
  Existing native Git commit tests passed **23**, and restore tests passed **7**.
  The owner subsequently approved the opt-in journal (decision below). Its
  implementation is in progress; no vault has been automatically enabled.
- M93.10 has five local versioned guides under Settings → About → Product help.
  Help and existing Settings checks passed **42 tests** before one additional
  generator rejection case. Light/dark browser checks passed **2 tests** at
  900×600. After independent review, repairs preserve keyboard focus when guides
  open, explain paused-agent activation and disclose connector working copies.
  The compiler/catalog/UI slice now passes independent specification/quality
  review and **11 focused help tests**. Final light/dark keyboard browser rerun:
  **2 passed**, 17 seconds; both new screenshots inspected. The two guided
  disposable-vault journeys remain open.
- The amended M99.1 pilot passed **7 native tests** (one intentional ignored
  schema exporter), **26 contract tests**, and **136 IPC/consumer integration
  tests** with overlap. Full app/tools/engine typecheck, scoped lint, formatting
  and byte-identical regeneration passed. The legacy snapshot preserves whole
  source bytes and their hash; it does not invent stable IDs or metadata revisions.
  Independent specification/quality review passed with **26 contract checks**
  and byte-identical generation verification.
- The amended M99.2 prototype passed **14 native tests**, one intentional ignored
  exporter run separately, **87 contract/value/IPC checks**, and generation drift
  verification. Independent specification/quality review passed with **14 native
  and 34 contract checks**. Exact decimal lexemes, tagged null versus Remove,
  schema-directed dates and explicit legacy conversion refusals are covered.
  Validation remains test-only until the disposable comparison consumes it;
  this is not production mutation or storage-migration acceptance.

Focused frontend checks use the pinned local Node 26.3.1 and pnpm 10.34.7 where
recorded. An initial unpinned full-suite diagnostic reported 24 failures and
16,613 passes; it is not a current release baseline. Existing warnings and
concurrent changes require attribution during the final pinned gates.

## Release boundaries

No production storage conversion, credential access, real provider mutation,
publication, push or retention-policy activation has been performed. These are
separate decisions or acceptance gates in the approved plans. Independent
implementation continues while those gates remain open.

Native IME, VoiceOver, packaged save/quit timing, live CLI supervision and other
external acceptance retain their own evidence records. Browser success is not a
substitute for them. No protection is claimed for Dock Quit, logout, shutdown or
process crashes by the session-only draft changes.

## 2026-10-23 continued verification

The M93.3/.4 history activation fix passed independent review with36focused cases, including unchanged real-store race probes and actual pane hosts. The M93.8 source-read repair passed independent review with12targeted cases plus a crossing-conflict probe. The no-op presentation status followup passed111focused unit cases and6final source browser cases; independent review confirmed real edits still report the owner's dirty/saving/failed state.

The bounded M94 first application slice passed independent specification/quality review. It includes opt-in compositions, Pages candidate2, property disclosure labels and aligned shared source controls. The reviewer inspected11images and verified all manifests and17source hashes. [Evidence](../specs/2026-10-23-m94-ui-implementation/interaction-results.md) retains earlier failures, rejected candidate1 and warning noise. Owner composition review was requested before wider adoption, as UX-04 requires.

M99.3 passed independent rereview after a semantic-read failure was reproduced with a wide integer plus a relation and conservatively classified unsupported. The final native evidence covers 20 cases. M99.4 is building the disposable two-store comparison; no production conversion or storage choice has been accepted.

M96.1's bounded action contract/catalog foundation passed independent rereview after complete-envelope admission was added. The repair passed 28 native tests, with two deliberate ignored exporters. M96.3 still owns provider dispatch, durable approvals, account scope and public broker registration. M97.1's first source producer passed its initial focused checks; independent review found two property-resolution cases now being repaired (unreadable metadata and unchanged repeated values).

The owner approved M93.9's opt-in recovery journal on2026-10-23 with the proposed seven-day,100-MiB global and10-MiB per-entry limits, protected-mail exclusion and explicit save-without-copy failure choice. [Decision record](../../acceptance/2026-10-23-reliability/recovery-coverage.md). Implementation can proceed; vault opt-in and native acceptance are still separate.

The proposed UI can be reviewed in the running prototype at `http://localhost:5173/`: **Pages → All pages → List view** (or the `g p` chord). The owner has requested directions to this screen, not yet approved wider adoption.

The Save as template caller now settles retained owners, checks same-version metadata/body and retires stale vault origins. Its focused 96-test check passed; independent review remains pending. A separate real-editor regression reproduced a batch/typing race. Holding owners before batch IPC now preserves in-flight typing through both success and refusal; 116 focused checks across editor, store, undo, rename and leave registry pass. Independent review remains pending for that change too. The original newer-vault notification test was updated to verify an origin hold before dispatch plus no notification to a new vault's watcher.

M97.1 passed independent specification and quality rereview after both property-resolution fixes: 60 frontend checks and four native checks passed (one intentional ignored exporter). The first producer is complete; source reveal/navigation remains M97.2. Save as template passed independent rereview after a stale-origin failure toast was reproduced and fixed (26 focused checks). The batch/typing hold also passed independent review, including three real-editor cases covering successful/refused writes and moved imports. These are bounded slices, not completion of M93.2 or the milestones.

## Recovery integration and storage comparison review

M93.9 native journal, commands and guarded export passed independent review after a first-install interruption was reproduced and repaired. New initialization stages and validates SQLite before publication; an existing unknown/corrupt authoritative file remains unavailable. Final focused native evidence: 30 recovery checks, six consumer checks, strict all-targets Clippy. Frontend review also passed after repairing History refresh while it remains open (45 focused tests). The final light/dark browser journey passed twice with exact BOM/CRLF export/restore; both five-state recovery labs passed their browser replay. [Browser captures and limits](../../acceptance/2026-10-23-reliability/m93-recovery-journal-browser.md). Lab followup passed independent specification and quality review. Packaged acceptance remains open; no entire milestone is complete.

M99.4 actual disposable adapters and their report acceptance checker passed independent rereview after the checker was repaired to refuse incomplete/failed evidence (52 tests). Historical 1k and corrected adversarial reports remain unchanged; the earlier 5k attempt has no completed output and is explicitly unavailable. A fresh root-owned 5k run completed against a separate disposable fixture: 5,000 converted, originals unchanged, zero semantic differences, and both stores passing the named query/backup/external-edit/recovery exercises. Its [raw artifact](2026-10-23-m99-store-comparison/5k-final.json) is retained byte-for-byte and passed complete outcome/source-digest validation at its tracked path. No performance winner, storage-authority selection or production conversion follows from these contended samples. The checker currently rejects the emitter's future `unsupported_retained` disposition; the fixed comparison fixtures do not emit it. That extension needs a focused fixture before accepting reports which contain it.

M97.2 source reveal/navigation is in progress over the accepted producer/resolver. Scope checking occurs before navigation, so a foreign locator cannot open the current vault's same-relative-path page. The return flow preserves actual visit/peek ownership; M92 conversation-return integration remains a separate handoff.

M96.2's [concrete credential-platform decision](../specs/2026-10-23-m96-credential-platform-decision.md) recommends Rust-only macOS Keychain. The plan requires owner/platform selection before the dependency is added; that answer is pending while lifecycle work can proceed against disposable seams. No credential has been imported.

The latest shared app/tools/no-DOM typecheck passed. Checklist action guards passed seven causal regressions and two real-editor preservation cases; template application passed atomic/stale-owner checks, real page/editor cases and a browser refusal→Retry→Undo journey. Both caller slices await independent review. Library and source-reveal review reproduced additional generation, metadata and navigation/focus races; their original implementers own the first repair rounds. These reviews have not been converted into acceptance claims.

## Latest integrated review checkpoint

Checklist guards passed independent specification and quality review. Apply-template review reproduced a late field/child-buffer race during the store's second body-only barrier. The repaired caller re-prepares and checks held target/template drafts immediately before dispatch; the unchanged original probe and 17 helper/real-editor cases passed independently. The stable editor and existing atomic batch/Undo remain the owners. [Save-participant inventory](../../acceptance/2026-10-23-reliability/save-participants.md) reflects these accepted bounded callers.

Library retained drafts passed independent round-two review after all three title/metadata findings were repaired: coherent scanned/source versions on open/reload, acknowledged rename rebasing that preserves intentional H1 edits, and independent Name generations that prevent an authored H1 reverting during a later Save. Final evidence includes134focused checks, five browser cases and all three unchanged review probes. This does not close deleted-target recovery, rename identity, explicit-form classification or full M93 acceptance.

M97.2's three navigation/focus findings passed independent rereview. Final clean browser replay passed five cases, but earlier first-load editor absence, including one15-second wait, remains an unresolved intermittent observation. No production fix or cause was inferred from later passes. Conversation return still requires the existing chat owner integration; full M97.2/native acceptance is open.

M96.2 native account lifecycle is frozen for independent review:27focused native checks and strict all-target Clippy passed. Its full native run returned4090pass/31fail/59ignored:28failures involved restricted process/network execution and three exposed unregistered recovery paths in safety checks. The latter were repaired and independently reviewed with precise receipt/staging/writer registrations;424vault tests passed,0failed,11ignored, and strict all-target Clippy passed. No checks were skipped or weakened to hide the environmental failures; those broader cases still require an appropriate-permissions replay. The managed credential/provider path remains test-only, with its platform decision and production routing/integration pending.

The [M99 authority packet](../specs/2026-10-23-m99-workspace-authority-decision.md) passed independent review after adding explicit recoverable-content backup categories, old-client/live-sync limits and the direct guarded-byte/Agent-memory/List/Collection persistence seams. The completed5k artifact was independently validated. The owner has been asked for the concrete SQLite/JSON-sidecar/legacy portability choice. No selection or real vault migration is recorded.

The latest app/tools/no-DOM typecheck passed. A fresh pinned full frontend suite is now running with two workers in `/tmp/cerebro-m93-m99-full-vitest-current.log`; its result is pending, not acceptance. No milestone is complete.

## Owner decisions recorded — 2026-10-23

The owner explicitly selected **macOS Keychain through Rust** for M96 managed connector secrets and **SQLite metadata + visible Markdown bodies** for M99. The concrete credential and authority documents record the accepted answers and tradeoffs. Native-store dependency/adapter and M99.6–M99.8 implementation may proceed; no actual account import, real provider mutation or current-vault conversion was performed or authorized by these platform/architecture choices. React/editor remain; native Rust UI/WASM are deferred. M94 wider visual composition still awaits the owner's aesthetic disposition.

## 20:10 implementation checkpoint

The pinned frontend suite completed: 899 files passed, 11 failed; 17,229 tests
passed, 32 failed and 15 skipped. The full log remains
`/tmp/cerebro-m93-m99-full-vitest-current.log`. Ten CLI-recording failures arose
from sandbox process-group access; the unchanged local stand-in suite passed
all 35 cases with appropriate permissions. Nine frontend files needed test
contract/isolation updates for the current typed save acknowledgement, retained
creation/field sessions, consolidated controls and shared 40px table gutter.
Their focused final replay passed all 159 tests. These are test-only changes;
their exact nine-file packet is `m93-full-front-reconciliation/` in the SDD
record. Independent review is pending. One Library retention case failed only
in the full run and passed in the focused replay; its cause remains open.

M96.2 repair1 passed independent specification and quality rereview. A private
verification epoch rejects stale health observations without invalidating the
structural/secret binding revision. V33 adds that epoch while V32 remains
byte-identical. Legacy migration preserves unknown raw JSON lexemes and refuses
ambiguous duplicate envelope keys. Final evidence: 32 connection tests and 49
runtime tests passed, one runtime test ignored. Repair Clippy remains scheduled
for the combined native gate; prior Clippy is not substituted for this repair.
The approved Keychain adapter is next, not yet implemented.

Deleted-target recovery design is approved within M93's existing requirements.
The frontend owner is implementing exact-instance retention, shared recovery
cards and typed child/field/diagram/canvas adapters. A separate native agent owns
bounded read probes, create-only Save as and one-use guarded export tokens. Copy
or export never acknowledges or discards the retained original. Neither slice
has complete integration/acceptance evidence yet.

M99.6 selected SQLite staging is in progress. A complete inactive stage must
account for every discovered source file and required attachment, recheck hashes
and root inventory before publication, and bind the selected metadata store and
visible bodies in a manifest. No current vault conversion, registration or
activation is authorized. The Rust library module registration is public while
all prior comparison prototypes remain test-only; staging has no product caller.

The existing owner's Tauri dev watcher rebuilds Rust on native edits and holds
the shared Cargo artifact lock. It has not been stopped or restarted. Cargo
checks remain serialized among our agents; contended timings are not performance
acceptance.

Root reproduced seven chat launch failures before repair: failed or timed-out
saves, invalid fields, retained child buffers, late edits during prompt expansion,
queue handling and same-tick vault round trips. The new barrier checks the
flush report and rechecks retained state immediately before native dispatch;
focused repair verification is still in progress. M92 rendering/protocol owners
are preserved. The M95.3 conversation-retention proposal is now concrete and
has been sent to the owner; the new archive remains disabled and unimplemented.

## 20:40 implementation and review checkpoint

The chat launch save barrier and nine-file test reconciliation both passed independent specification and quality review. The reviewer verified original/final/evidence hashes and ran346 focused tests across12 suites, all passing. Two stale explanatory comments were corrected afterward; the historical reviewed packet remains intact. The complete frontend suite is not yet green: the unchanged LibraryPage first retention case remains unresolved under the original full run. No milestone is complete.

Deleted-target native commands are registered with in-memory export state and actual window-destruction cleanup. Native command8 tests, shell action17 tests and writer-registry1 test passed. The root close-hook compile initially lacked tauri::Manager, now corrected. The first helper binary missed a simultaneous canonical-alias fix and failed one case; a rebuilt final helper passed all17. Native review independently replayed25 tests. No real native dialog/account/credential action was performed.

The integrated recovery review FAILED with three P1 frontend lifecycle defects: restored scanner entries hide still-required recovery controls; missing diagrams remount a retired editor after explicit discard; pending rich serialization can reach a replacement owner through a late key lookup. The original implementer owns repair1. Two original probe expectations also needed correction without discarding their RED evidence: a blocked discard retains the original owner (so it cannot simultaneously create a new replacement), and a held recovery face need not remount the normal source editor. Corrected discriminators must prove the safety contract and explicit resolution; independent rereview remains required.

M99.6 inactive SQLite staging passed51 migration and14 service tests, with one ignored test in each filter, plus140 frontend/contract tests. Exact12-file packet m99-6-staging-report.md is ready for independent review. No semantic-producer adoption, current-vault conversion, activation or backup completion is implied.

M93.5 readiness implementation is underway. Root frontend owner had10 causalRED failures then10GREEN, plus malformed-wire RED then11GREEN. Two real AiPanel/Settings cases failed before wiring, then passed; combined Settings/rail/attachments/readiness88 tests passed. One shared observation now distinguishes checking/available/missing/unavailable and supports explicit recheck while preserving the current draft, DOM, question, approval and scroll. A6-second IPC watchdog only releases UI waiting; it does not claim native child cleanup. Browser light/dark proof and final static checks are running. Native toy-process RED produced12 failures and2 passes; bounded native discovery and per-run binary/version/PATH observation are being implemented, with legacy cache removal and command registration pending.

M96 Keychain adapter design is approved under the owner's platform selection. Target-only security-framework/core-foundation/sys dependencies are being added; exact scoped no-prompt queries, device-only/unlocked protection, bounded Rust copy and finite redacted errors are tested through fake SecItem calls. No real Keychain calls are made. Signed/entitled packaged acceptance and blocking-worker integration remain explicit activation gates; the OS call itself has no promised cancellable deadline. Nine native RED tests are currently compiling under the root Cargo reservation.

M95 archive retention question remains pending. A concrete M98 JSON/limits/desktop-schedule/retention proposal was written and sent to the owner; no workflow activation is inferred. Wider M94 visual acceptance also remains pending. Existing prototype directions are localhost5173 → Pages → All pages → List.

## 20:55 verification and independent-review checkpoint

M93.5 shared CLI readiness now passes 16 focused frontend cases, 48 independently rerun frontend cases, both light/dark browser scenarios at wide and minimum 900×600 sizes, and 23 native toy-process cases. Existing interaction/input/stdin/discovery filters also passed. All three TypeScript configurations and strict all-target Rust Clippy passed at the recorded source snapshot. The root inspected minimum-window screenshots. The legacy check_agent command is explicitly listed under the IPC contract's existing M54 owner retention rule after its production callers moved to the new readiness command; 53 IPC contract cases passed. The original frozen patch and this separate contract amendment are both preserved.

Readiness independent review found one Important defect: eagerly enumerating optional nvm fallback directories can prevent a valid PATH executable from being checked or run. The original native implementer owns repair 1 with causal toy coverage. No real user CLI/account was invoked. Native package/login-shell acceptance and latency remain separate.

The macOS Keychain adapter compiled and passed 41 connection tests using fake SecItem calls, including all accepted lifecycle regressions. The root's strict Clippy pass includes this adapter. Exact six-file implementation/dependency packet is complete; independent adapter review and signed/provisioned packaged acceptance remain pending. No real credential or Keychain item was accessed.

M99.6 independent review requires two repairs. A compiled disposable test proved that a governed Knowledge/ alias is accepted as an ordinary conversion proposal because the staging check uses raw prefixes. Separate filesystem evidence showed a 0755 metadata directory and 0644 database, which can broaden private metadata access under a traversable parent. The original implementer owns repair 1. The review probe was removed and source bytes restored exactly; the generated test binary still contains the temporary probe until the next compile and must not be mistaken for pristine source evidence. Physical staging remains inactive; no user vault conversion or activation occurred.

Deleted-target repair 1's first browser replay failed and revealed a StrictMode defect: capture ownership changed inside an impure useMemo factory, so React's discarded second calculation could retire the value it kept. The agent reproduced two causal unit failures and repaired that lifecycle; a fresh five-case browser run is underway. Earlier focused passes are not substituted for this failed browser evidence. Original recovery findings and independent rereview stay open until the final repair is checked.

M94 composition, M95 archive retention and M98 workflow platform/retention answers remain pending. The approved M93 journal, M96 Keychain and M99 SQLite decisions remain effective. No milestone is complete.

## 21:18 accepted repairs and next implementation checkpoint

The bounded M93.5 CLI-readiness repair passed independent SPEC and QUALITY review. Optional nvm fallback discovery is now lazy, so an unused bad fallback cannot block a valid PATH executable. The final native suite passed 29 cases. The reviewer preserved a contended 27-pass/two-timeout run, unchanged isolated passes and a subsequent 29-pass full replay; one-second toy-test budgets are not the production five-second budget. No actual CLI/account was invoked. The exact native repair and concurrent M92 drift are separately attributed in `m93-readiness/native/repair1/repair1-rereview.md`.

Deleted-target recovery repair 2 passed independent SPEC and QUALITY review. Admission checks and the actual second reader now retain recovery ownership through failure; the original four independent failure probes and added second-read cases passed. Implementer verification passed 338 tests in 22 files, all three TypeScript configurations, scoped lint/format and five browser cases. The reviewer independently passed 54 adversarial cases and checked all 32 final overlay hashes and ten genuine preimages. `m93-deleted-target-repair2-rereview.md` closes R1 for this bounded frontend slice; native dialog/quit and remaining participant acceptance stay separate.

M99.6 inactive staging repair 1 passed independent SPEC and QUALITY review. The existing knowledge guard covers governed aliases; filesystem folding covers retained/private aliases; a conflicting control-directory alias refuses before output. New staging directories and SQLite files are created private, including verified journal permissions. Fresh migration results are 59 passed/one intentionally ignored; service results are 14 passed/one intentionally ignored. Both Important findings are closed in `m99-6-staging-fix1-rereview.md`. No migration command, activation or current-vault conversion was added. A subsequent compiler rebuild changed the test-binary hash; the reviewer records current-binary evidence separately from the original packet.

The six-file M96.2 Keychain adapter passed independent SPEC and QUALITY review, patch/hash reconstruction and 41 connection tests. Tests use fake item operations below real query construction; no real Keychain item was read or written. Signed/provisioned packaged acceptance and production routing remain open. Root's subsequent whole-crate `cargo fmt --check` and strict all-target Clippy passed, the latter in 2m00s including native readiness/staging repairs and concurrent M92 source at that check. The next broker delta is not covered by that historical pass.

A fresh full frontend run with two workers is in progress at `/tmp/cerebro-m93-m99-full-vitest-followup.log`. Its Library retention file passed all 21 tests, but that alone does not establish a cause or resolution for the earlier aggregate failure. New M95 quota tests/implementation are beginning during the aggregate run; final results must retain this source-snapshot limitation and be supplemented with focused final verification. The test-only multi-block reattach addition passed its final focused check without act warnings, scoped lint and Prettier; review and the real CLI matrix remain open.

Next owned slices: M95.1 honest cache-trim availability and bounded repeat-save admission; M96.3 durable native action approvals/claims using reserved runtime migration V34; M99 semantic conversion producer and actual authority-consumer matrix. Agents capture genuine preimages and causal failures before production changes. Existing M94 composition, M95 archive and M98 platform/retention questions remain pending. No milestone is complete.

## 21:43 quota/browser, mixed aggregate and native implementation checkpoint

M95.1 quota repair passed independent SPEC and QUALITY review, 113 focused tests, scoped lint/format and all three TypeScript configurations. Its real-hook integration preserves live IDs, attach cursor and incremental words before Done; unavailable CLI history does not erase the explicit cache-trim warning. Later cache saves avoid serializing discarded historical bodies while retaining reference scans; no absolute byte or sublinear bound is claimed. The test-only multi-block reattachment case and root Retry radius-token correction were included in review.

Root added and visually checked two Chromium cases at 900 × 600 in light/dark: the start-of-transcript availability notice is reachable with real wheel scrolling, and the same composer node/draft survives a live turn, minimize/reopen and canvas expansion. Both passed; the tools TypeScript configuration and scoped E2E lint passed. An initial visibility assertion targeted the outer Chat container and failed; correcting the test to wheel-scroll the actual named Conversation region passed without a production layout change. The tracked chat/CLI validation index now links screenshots/log and closes its stale quota/review rows. The native CLI is pinned 2.1.250, but the isolated profile is unsigned. A fresh private test fixture was prepared through the existing recording driver and owner login requested; current live CLI acceptance remains environment-blocked.

The full frontend aggregate ended with 918 files passing / six failing, 17,383 tests passing / nine failing / 15 skipped. It ran during concurrent M92 and quota source edits and is a mixed snapshot, not a release-green gate. The root-owned Retry radius token caused one theme failure and was repaired with 18 focused theme/readiness/Environment passes. Six quota failures came from new tests encountering the in-progress implementation; the final 113-case suite and independent review cover the repaired contract. Current Environment passes and all 13 railConnectors cases pass; these focused reruns do not rewrite the historical aggregate. Library's 21-case aggregate pass does not establish the cause of its older intermittent failure.

M96.3 second native candidate passed 59 tests with exactly three newly introduced expected failures: explicit attended-person decision audit and two stable request-key recovery cases after catalog retirement. The earlier seven failures now pass, including clean-process stop recovery, changed binding, expiry projection and conservative cancellation/reconciliation. The three fixes are in the next frozen candidate. A formatter ran after its final compile had been queued; no genuine immediate pre-format snapshot was captured. That run must be labeled source-changing and rerun against the frozen final source; original total-change preimages remain available. No production authority factory, adapter credential use or external provider call is enabled by this foundation.

M99 semantic production passed all 66 migration cases (one ignored) and 14 workspace-service cases (one ignored), including the captured-stage inventory check and exact body-only BOM preservation. The archive validator's remaining independent body split caused a real failure and now uses the same guarded boundary helper. Stronger malformed-inventory/budget tests await the final binary; an independent reviewer is checking the exact seven-file packet. Consumer adapters, supported-client gating, file/metadata journal and complete backup/restore remain unimplemented and explicit in the actual-consumer matrix. No current vault was converted.

M93 open-page rename work has causal failures and focused passes for text, Mermaid, canvas and fields; folder Undo/Redo, refused rename and Library explicit-Save ownership are under implementation. No milestone is complete. Existing owner choices and pending M94/M95/M98 decisions remain unchanged.

## 22:32 attribution, rename review and selected-authority checkpoint

M96.3 broker repair 1 passed independent SPEC/QUALITY rereview. Five new causal probes had reproduced edited-input authorization drift and live cancellation/reconciliation releasing an unresolved submission fence; all five now pass. The frozen actions filter passed 67 tests (50 action checks, including 35 broker checks, plus 17 shell checks), with two intentional ignored regenerators; runtime follow-up passed three. The reviewer verified exact original/RED/GREEN patches, all nine current source hashes and copied log hashes. Current-input authority and continuous cross-process submission ownership close both Important findings within the test-gated foundation. No native production authority factory, credential route or provider is enabled. Digest stability and expired-approval read projection remain explicit preactivation work.

M93.2 rename identity passed 280 affected tests, then 16 harness checks after a test-only lint correction, scoped lint/format and tools/engine typechecks. Independent review nevertheless reproduced four Important defects: source Canvas remount escaping the pending hold, stale read rejection replacing destination readiness, retained destination draft/recovery overwritten by source remapping, and clean absent Canvas blocking Home navigation after acknowledgment. The original implementer owns repair 1. Destination admission must defer before editable owner creation and preserve any already-authored late incarnation in discoverable recovery; no silent merge or effect throw is accepted. Browser/native rename acceptance and rereview remain open.

Root's M95.1 child-attribution candidate passed 232 tests across six suites, all three TypeScript configurations, scoped lint/format and two visually inspected 900×600 Chromium cases in light/dark. The first browser attempt failed at sandbox loopback bind; unchanged checks passed with permitted local-server access. Four root test matcher typing errors found by M93's app check were corrected; root's subsequent app check passed. The existing native unreadable-child case and meter filter passed 1 and 60 tests from the then-built binary, with its exact historical hash/source snapshots retained; later Cargo rebuilds replace that binary path and are not represented as the same executable. Independent chat review is in progress; no acceptance or live CLI claim yet.

M99's bounded inactive semantic producer passed independent review and the final strengthened 66 migration/14 service tests, one deliberate ignored case in each filter. Normal cargo check then exposed unsafe-libyaml remaining a dev dependency after its syntax parser entered production. Moving the same locked dependency to normal dependencies passed cargo check --lib, without Cargo.lock changes. Selected-authority implementation now has causal REDs: nine actual scan/read/Full width cases fail at the explicit missing resolver/store implementation; native admission has one legacy-control pass and three causal missing-guard failures; two real mounted DocPage/store-action cases fail while selected mock scan/read are unavailable. The implementation includes a finite classification of all 226 existing native commands, trusted binding/marker resolution, canonical metadata-only Full width and an initial read-only selected page. No production binding writer, activation or current-vault conversion is authorized. Ordinary unbound legacy resolution must be restored before broader selected functionality proceeds.

Existing owner decisions remain effective: opt-in bounded recovery journal, macOS Keychain, SQLite metadata with visible Markdown bodies. M94 wider composition, M95 archive retention, M98 workflow platform/retention and isolated CLI login remain unanswered. Independent work continues; no milestone is complete and no stable full repository gate is claimed.

## 22:52 healing, admission and compatibility checkpoint

The independent M95 child-attribution review found partial cache healing could graft another child's identity/parent content despite the reducer guards. Root captured eight causal failures plus one compatible control, then scoped healing to a matched reply with compatible call names, parents and recorded child identities. Ambiguous or conflicting attribution retains cached content and the visible unavailable fact. Final affected checks passed 241 tests across seven files, plus 14 rail checks; scoped lint/format pass. The missing Subagent path in the initial command is explicitly accounted for by the actual separately run component. Static rereview found no new must-fix issue; current coordinated TypeScript and final evidence acceptance remain pending. The original packet and exact executed RED snapshot remain preserved. Native signed-in CLI acceptance and archive retention remain open.

M93 rename repair now covers the four original review probes, delayed editor admission, real two-card Copy/Save-as/discard isolation and deferred Library recovery. A 43-case focused pass was followed by an adjacent run with 373 passes and six failures: a caller-owned field identity object was mutated through remapping, explicit Library Load new version was wrongly reusing a retained owner, and ordinary Canvas readiness became unnecessarily asynchronous. The implementer is repairing these observed regressions under unchanged behavioral assertions. No final rename acceptance is claimed.

M99's exact legacy/unbound resolver control passed, followed by normal cargo check; the unfinished checkpoint still emits dead-code warnings and is not Clippy clean. The Rust schema exporter and generated TypeScript projection passed, with genuine before/final bytes preserved and both action contract files unchanged. The mounted selected-page pair passes. A new mock guard suite initially failed in fixture setup, which is explicitly not causal evidence; after correcting only fixture creation, ten projection cases pass and five actual selected write/Git/Agent admission cases fail as intended. A real local-listener regression also proved permanent shutdown would prevent later legacy rebind: the normal sandbox run failed loopback permission, and the unchanged permitted run demonstrated cancellation/closure but retained binding, permanent quitting and failed legacy RPC. Selected suspension and native admission implementation continue; no current-vault conversion or production binding writer exists.

M96 fix2 addresses stable versioned request lookup and expired approval presentation. Eleven actual native probes produced nine causal failures and two legacy/history controls passed. The candidate retains V34's 64-character hash columns, versions explicit domain-tagged tuple bytes/private payload metadata, reads frozen legacy encodings without rewriting historical rows, and rejects ambiguous or mismatched versions. SELECT-only expiry presentation hides actionable approval; an internal test-gated refresh rechecks authority/revision/fence without dispatch or fabricated person approval. Static independent review found no Critical/Important finding, with native GREEN in progress. Concurrent old/new writers remain unsupported and the broker remains unactivated.

The opt-in recovery journal, macOS Keychain and SQLite metadata decisions remain accepted. Wider M94 composition, M95 archive retention, M98 workflow platform/retention and isolated CLI login remain unanswered. No milestone is complete and no stable whole-repository gate is claimed.

## 23:11 accepted chat/broker repairs and remaining authority checks

M95 child-attribution repair 1 passed final independent SPEC/QUALITY review. The reviewer verified both final source hashes, genuine preimages, exact patch, executed causal RED and copied GREEN/static logs. The final bounded result is 241 affected tests across seven files plus 14 rail checks, scoped lint/format and all three coordinated TypeScript configurations. The tracked chat/CLI validation index and M91/M92 handoff now distinguish this accepted projection/healing slice from the still-open live CLI, archive and whole-app gates. Existing light/dark child-detail browser captures are linked as historical UI evidence; the healing repair did not change those UI files.

M96 broker fix2 passed the frozen actions filter (78 passed, two intentional ignored regenerators) and runtime follow-up (three passed), then final independent SPEC/QUALITY review. Versioned lookup compatibility and expired-approval presentation are accepted within the unactivated foundation. Native admission is the next slice: root reviewed the exact two-table V35 proposal, the verified single-local-owner context, explicit account/action grants and shared admission policy. Isolated causal tests may proceed; real authenticated bearer/client/native producer hooks and their tests remain necessary before acceptance. No provider route or credential use is enabled by that approval.

M93 rename repair 1 passed its final 379 affected tests and typed replay, but independent review reproduced a fifth defect: explicit discard removed a late draft's recovery card while its hidden save wrapper still blocked Home. Repair 2 captured that actual consumer failure and now retires wrappers only for the successfully discarded owner identity, with a weak tombstone against delayed re-registration. Copy and Save as retain the original disposition requirement. The frozen repair 2 passed 103 directly affected tests, scoped lint/format and all three TypeScript configurations; independent rereview is in progress. Browser/native rename acceptance remains open.

M99 selected authority now passes 24 focused frontend cases and all 11 native scan/read/one-key/corpus cases. An expanded native run passed 32 cases, failed five new causal probes and ignored one deliberate generator. Those failures cover stale opening-generation publication, a dangling export symlink, loss of the typed refusal envelope, overlapping registered roots and prior app-session teardown. Their candidate fixes are under fresh verification. The real selected-suspension test separately passed closure/cancellation plus a later authenticated legacy RPC. Two additional regressions now check that an already-observed selected binding cannot silently become legacy authority after its registry/marker disappears or changes; their RED run is in progress. No activation, current-vault conversion or whole-repository green gate is claimed.

The accepted recovery-journal, macOS Keychain and SQLite metadata choices remain effective. M94 wider composition, M95 archive retention, M98 workflow platform/retention and isolated CLI login remain unanswered. Independent implementation continues; no milestone is complete.

## Selected authority, source occurrences and editor review checkpoint

M93 rename repair 2 passed independent specification and quality review, including the unchanged hidden-wrapper regression. The bounded browser acceptance now also passed both Source-page and Canvas rename/Undo/Redo journeys in a frozen replay (two passed). Exact Source bytes and owner identity survived; Canvas scene Undo still worked at the renamed path. The earlier source-changing replay remains historical. [Acceptance and captures](../../acceptance/2026-10-23-reliability/m93-open-page-rename-browser.md) distinguish these cases from still-open native timing, dialogs and wider participant acceptance. Scoped browser-test lint, format and tools typecheck passed.

M99 selected-authority tests reached 43 passed and one intentional ignored generator, including opening-generation publication under the same lock, denial-only remembered bindings and the bounded remembered-root cap. Additional causal probes then found one mounted-root over-refusal and three Save-a-copy destination failures. Narrow fixes are published but not yet reverified. Two further tests target the canonical metadata database/registry namespace; their RED run is pending compilation. Existing vaults have not been converted or activated.

M96 native-admission causal checks recorded 14 failures with two negative controls passing, plus the real V35 migration missing-table failure. The reviewed two-table migration and isolated authority/grant/catalog candidate are now published. Its first build found five integration errors before running any test or digest regenerator; the original implementer owns those repairs. Real native/MCP proof producers, explicit grant creation, provider dispatch and Keychain activation remain unconnected and unaccepted.

M97 contextual source occurrences passed 113 frontend checks; the remaining contract failure identifies its unregistered native command. Seven native query probes failed against the empty stub, and the candidate native query is now ready for verification. Four positive editor-location probes failed before mapper implementation; the first implementation passed those but regressed two standalone-link refusal cases, which remain recorded and are being repaired without changing their expectations. Return-to-discovery context still needs its own causal coverage.

M95.4 selected-text review found the existing Apply path mutates a live DOM range without validating document version or ownership. A bounded repair now has actual-editor causal tests queued: capture model/range/page ownership, validate before Apply, and use the existing editor transaction/save/Undo owner. This does not imply archive, supervised-job or complete M95 acceptance. Owner decisions and unanswered gates remain as recorded; no milestone is complete.

## 2026-10-24 implementation and independent-review checkpoint

M95 selected-text Apply now validates the captured editor model, revision, range and vault/page owner, then uses the existing editor transaction/save/Undo path. Frozen initial checks passed28 focused tests and110 broader editor tests. Browser3 passed all four light/dark Apply/save/Undo and concurrent-edit conflict/Cancel cases. The earlier first-load editor absence remains a startup limitation; a20-second readiness allowance and timing/error attachment do not establish a performance fix. Visual inspection also found the contextual popover placed far from its selection; geometry repair is still open.

Independent review found Keep mine could preserve the proposal's whitespace despite rejecting its words. Root reproduced three causal failures with29 controls passing, then changed the consumer to pass the captured original text whenever no hunks are accepted. The repair passed87 tests across four actual files plus27 reconciliation tests; scoped lint and format pass. Fresh TypeScript and final independent rereview remain pending for that amendment. Historical commands naming nonexistent reconciliation paths are not counted as executed files.

M97 occurrence discovery's Unicode ordering and existing-Visit peek restoration repairs passed122 checks across seven actual files; the corrected adjacent paths separately passed46 checks across four files. All three TypeScript configurations passed before the newest review probes. Browser3 failed both occurrence journeys at the initial linked-results read. Independent review traced React effect replay cancelling that read and leaving a permanent interrupted/Refresh state. It also found Return accepts scan-retained unreadable origins, fragment wire/ID normalization differs between Rust and the browser, and dense mention matching may perform quadratic boundary work. Causal probes are now running; no contextual-discovery browser acceptance or complete M97.5 acceptance is claimed. Mention insertion remains unimplemented.

M99's latest pre-review selected-authority checks passed48 tests with one intentional ignored generator, plus22 file-action checks. Independent review then reproduced a Full width mutation crossing the aggregate metadata read limit and selected opening retaining an old pending approval. Additional actual lifecycle probes reproduced retained conversation grants, finished/live journal leases, late-close requeue and an unused write approval surviving a consumed Allow. The corrected generic stop_all control passes. The bounded aggregate/cancellation repair is under fresh verification. Inspection separately confirmed an in-flight legacy run can register/spawn after selected suspension; generation-bound admission is still required before accepting the lifecycle. No user vault conversion or selected activation occurred.

M96 normalized native actor handling now passes105 action/file-action checks with two intentional ignored generators, including the root's mechanical lint repairs. Native/MCP proof producers, attended grant writer, managed credential route, external transport and real Keychain activation are still unconnected. Strict whole-tree Rust lint/fmt and independent final admission rereview remain open.

All milestones M93–M99 remain incomplete. The accepted opt-in recovery journal, macOS Keychain and SQLite metadata/Markdown body decisions remain effective. Wider M94 composition, M95 archive retention, M98 workflow platform/retention and isolated CLI login remain unanswered. The user asked whether everything was done and was told clearly that substantial connector, workflow, UI and storage work remains. No stable whole-repository gate, current-vault conversion, external provider action, commit or deployment is claimed.

## 2026-10-24 browser and native review checkpoint

Selected-text Apply now has final Keep mine rereview, corrected popover geometry,
all three TypeScript checks, and four Chromium plus four WebKit journeys passing.
The source-discovery journey passes at both widths in both themes in Chromium and
WebKit. The chosen atomic link has a visible ring; actual editor/native-range
checks identify only the intended occurrence. Both browser flows preserve exact
saved bytes and their existing Undo/return state. See the tracked
[M95 selected rewrite](../../acceptance/2026-10-24-chat/m95-selected-rewrite.md) and
[M97 contextual discovery](../../acceptance/2026-10-24-knowledge/m97-source-discovery.md)
acceptance records and captures. These are mock-IPC browser results, not live CLI
or packaged-native acceptance.

The remaining Unicode fragment discrepancy had two causal frontend failures and
one native shared-case failure. Both readers now use the same explicit scalar
list after canonical whole-name resolution. The final checks pass 21 occurrence,
six adjacent IPC and seven native cases, with literal body/property occurrence
IDs. All TypeScript configurations and scoped lint pass. The first frontend
command also named a nonexistent adjacent test path and therefore ran only the
21-case file; the corrected six-case IPC command is recorded separately.

M99 selected-authority repair 2 passed actual publication and thread-preparation
checks, but review found delayed write-approval insertion and a capacity check
suppressing deterministic ambient work. Three real causal failures and a live
consumed-answer positive control were recorded. Repair 3 validates current answer
identity/input before any approval replacement; opening capture retains closing
and generation checks while publication still enforces process capacity. The
frozen result is 338 passing checks: 73 interaction, four admission, four actual
publication, 24 thread, 184 agent-module and 49 workspace checks, with one
intentional ignored generator. Independent source rereview found no remaining
P1/P2 in this repair. Whole-app acceptance and the remaining selected-authority
writers, journal, backup and activation are still open.

M96's first real native ownership/storage implementation passed its original
seven checks. Independent review then found a constructor symlink substitution
and an AppKit getter used off the main thread in the proposed integration. The
actual constructor interleaving reproduced the symlink failure, with the regular
replacement control passing. Repair is underway; native opening hooks remain
unintegrated. No grant writer, action/provider route or real credential access is
enabled by these results.

The twelve-case M97 outcome harness passes 25 checks, tools TypeScript and scoped
lint after two causal pre-write budget failures were fixed. Missing product/model
capabilities remain unavailable. Independent review found incomplete native
producer fingerprints; a bounded complete-input inventory is being prepared.
No actual native outcome capture or live quality result is claimed.

All M93–M99 milestones remain incomplete. Existing owner choices and pending
composition/archive/workflow decisions remain unchanged. No current vault was
converted, no external provider action ran, and no commit or deployment occurred.

## 2026-10-24 native owner, outcome capture and aggregate verification

M96 owner-fix1 closes the constructor symlink and off-main AppKit findings in
independently reviewed source. The actual start_watcher hooks now prepare and
bind the retained native owner without enabling action/provider routes. Ten
focused owner tests pass; cargo check --lib, strict library and all-target Clippy,
and cargo fmt --check pass. Only native_owner is promoted to production; the
account/broker surfaces remain test-gated. Real native callback, Destroyed/timeout
and forced-unavailable legacy-opening acceptance remain open.

The M97 outcome provenance repair passes 36 focused checks, tools TypeScript and
scoped lint, with no remaining independent P1/P2 source finding. The actual Rust
capture uses 804 declared inputs (16,375,859 bytes); its SQLite broker records one
provider submission and reconciliation from outcome_unknown to succeeded, with
an unacknowledged retry denied. The provider is synthetic. The actual offline
command exits 3 with four passed, zero failed and eight unavailable outcomes;
all six negative controls pass. See the
[outcome acceptance record](../../acceptance/2026-10-24-knowledge/m97-outcomes.md)
and its finite report. Neither native capture nor a passing harness establishes
live answer quality or the unimplemented product observation paths.

A fresh full frontend run held all 4,826 recorded inputs unchanged and finished
with 934 files passing, four failing; 17,609 tests passed, 13 failed and 15 were
skipped. Ten failures came from sandbox-denied process inspection in the CLI
recorder; its permission-correct isolated replay passes all 35 tests. The other
three exposed stale test contracts for occurrence rows, overlapping statuses and
model-owned selection. Reviewed test-only updates preserve their user behavior
and pass all 144 tests in those three files. All TypeScript configurations,
scoped lint and final formatting pass. The original failed aggregate is retained;
this is a complete failure disposition, not a claim that the original run passed.

The broader native test baseline is running separately with documented abort-based
interruption cases excluded. Its final result remains pending. No milestone is
complete; current-vault conversion, real provider actions and deployment remain
outside the actions performed here.

## 2026-10-24 completed-message Copy and native baseline disposition

Completed questions and final answers now have persistent, keyboard-reachable
Copy controls through the existing AI MessageToolbar. Final answer copying uses
the displayed turn projection, excludes reasoning/tool payloads, and waits while
a reply streams, waits, is suspended or has a gap being restored. Independent
review reproduced the restoration gap before the guard was repaired. The bounded
slice passes 52 focused checks, 290 panel/conversation/turn-host integration checks,
all TypeScript configurations, scoped lint/format and four light/dark Chromium/
WebKit journeys. See [Copy acceptance and captures](../../acceptance/2026-10-24-chat/m95-message-copy.md).
Clipboard/native permissions remain outside the mock-clipboard browser evidence.
Save/Add artifacts, Edit question, durable receipts/archive and supervised jobs
remain open.

The broad native baseline finished with 4,318 passing tests, two failures,
40 ignored and 62 explicitly filtered interruption cases. Abort-based crash
patterns were excluded by the documented local procedure. One failure required
an explicit test-only file marker; the other mixed M54 grant ordering with M99's
new earlier workspace-authority boundary. Reviewed tests now separately prove
real legacy scope refusal/recording, grant-level no-scan order and missing-root
authority refusal. Those three checks plus the receipt audit pass against the
compiled binary; production refusal order was preserved.

The M96 shared native-lineage extraction remains test-gated and passed independent
source review. Its actions:: filtered suite passes 116 tests (including file-action
controls), with three ignored. A new invalid-UTF8 fixture initially failed while
creating a directory; it now tests the actual SQL insert kernel with an in-memory
invalid path, retaining strict identity refusal and zero writes. The two new
publication metadata tests currently fail against deliberately closed new-API
scaffolding, with four existing publication controls passing; this is not evidence
of completed native provenance, grants or managed execution.

The first compiled M99 paired body/SQLite journal now blocks its original pending
read/Full width probes, and its normal/interruption/recovery controls run. Review
identified three defects: normal saves adopting an externally installed postimage,
publication without a postcommit body check, and lost temporary/evidence inode
identity between validation and action. Five actual boundary probes reproduce
those failures with 63 controls passing. Repairs are in progress; the journal has
not passed acceptance and has no editor/startup activation. Generated native/TS
error contracts were refreshed through their owned generators and pass 88 frontend
contract checks. Current-vault conversion remains unauthorized and unperformed.

## 2026-10-24 Save answer and paired-journal repair

Save answer now previews a frozen completed answer, lets the person choose its
title/folder, and creates one ordinary page through the existing guarded batch
with one Undo. Independent review reproduced preview/title loss during streaming
and restoration; stable turn ownership repairs it and also survives a changed
final-part key. The final focused group passes 13 checks, broader chat integration
passes 218 checks, and four final Chromium/WebKit light/dark journeys pass.
See [Save answer acceptance](../../acceptance/2026-10-24-chat/m95-save-answer.md).
These groups overlap; Add selection, context/artifact receipts, Edit question,
archive and supervised jobs remain open.

The M99 paired journal's five reproduced boundary failures now pass unchanged.
The focused service group passes 68 checks (one intentional ignored exporter),
and related migration checks pass 66 (one intentional ignored report). Independent
rereview found no remaining P1/P2 in that bounded repair. Strict all-target Clippy
then identified an oversized private acknowledgement enum; boxing its receipt
resolves the warning without changing its semantics, and the strict check passes.
Startup dispatch, selected-aware recovery-copy reconciliation, editor adoption,
remaining adversarial acceptance, backup/import and migration activation remain
open. No current vault was converted.

The M96 actual-publication metadata slice passes six tests, including independent
Stop and revoke/remint paths. Review found an auxiliary metadata-lock failure
could incorrectly invalidate a valid legacy grant. The actual regression then reproduced that failure; the
narrow repair preserves legacy permission while returning absent optional metadata.
The unchanged regression, six publication controls and 116 actions-filtered checks
(including file-action controls) pass. Independent rereview accepts the repair,
and strict all-target Clippy plus cargo fmt --check pass. Durable lineage, grants
and provider execution remain open. All M93–M99 milestones remain incomplete.

## 2026-10-24 selected startup recovery

Selected opening now runs paired recovery after legacy suspension and before
scan, watcher startup and generation publication. Exact clean schema-2 stores
remain read-only with no new lock; pending/unknown stores refuse. Eight actual
startup failures preceded the integration. The final startup filter passes 11
checks, the workspace service group passes 77 (one ignored exporter), and related
migration checks pass 66 (one ignored report). These groups overlap. Strict
all-target Clippy and cargo fmt --check pass; independent review found no concrete
P1/P2. See [paired journal and startup acceptance](../../acceptance/2026-10-24-storage/m99-paired-journal.md).

Tauri watcher instantiation, non-Unix behavior, selected-aware retained-copy
reconciliation, editor/external-edit adoption, full backup/import and migration
activation remain open. No current vault was converted or activated.

## 2026-10-24 retained-copy classification repair

Five native regressions reproduced pending-copy deletion/false commitment, reverse
path-lock acquisition and unavailable-root misclassification during selected paired
saves. Cleanup now classifies only positively identified legacy workspaces; selected
and unknown authority retain their unexpired pending bytes. Original-key expiry and
the approved retention/privacy/size limits are unchanged. The five probes pass, as
do 31 recovery checks (three intentional ignored helpers) and 81 workspace-service
checks (one intentional ignored exporter). Strict all-target Clippy and formatting
pass. Root independently reviewed the author patch against actual sweep, expiry and
authority resolution. These checks overlap and do not close M93 or M99.

[Paired-journal evidence](../../acceptance/2026-10-24-storage/m99-paired-journal.md)
now records this limitation explicitly: selected retention rows still need a durable
join to their original paired operation before reconciliation and editor adoption.
No vault was enabled, converted or activated.

## 2026-10-24 original publication and exact token provenance

M96 now retains the original admitted preparation and checked CLI session in the
actual successful publication receipt. The shared actual token-mint path supports
an exact listener/slot witness, whose new consumers remain test-gated until the
retained native-owner caller lands. Four new API scaffold failures now pass
unchanged; the publication group passes ten checks, admission four, and capacity
and optional-metadata-poison controls one each. Strict all-target Clippy and
formatting pass. Root independently reviewed the bounded author patch.

[Publication provenance evidence](../../acceptance/2026-10-24-connectors/m96-publication-provenance.md)
distinguishes these results from still-open native callback authentication, durable
authority finalization, grant UI, provider execution and packaged Keychain checks.
No callable action authority or completed connected journey is claimed.

## 2026-10-24 explicit mention insertion

The ordinary untyped Markdown path now offers Link mention → source-owned
Insert/Cancel, using the existing checked batch and app Undo. Independent review
found stale pending state after Back and a JS/Rust U+0085 whitespace mismatch;
both were reproduced and repaired without weakening their assertions. Final
integration passes 239 checks, plus an overlapping 12-case affordance group.
The actual native composer replays nine byte cases; four Chromium/WebKit theme
journeys pass exact insertion, Cancel, retained editor and Undo. All TypeScript
projects, scoped lint and final formatting pass; independent rereview found no
remaining concrete P1/P2.

[Acceptance and prototype steps](../../acceptance/2026-10-24-knowledge/m97-mention-link.md)
record the supported source class, before-dispatch target check, native/mock
boundary and remaining M97 work. No milestone is complete.

## 2026-10-24 — Source-list semantics and native finalization review

M97.4's bounded resource classifier now distinguishes exact listed pages, safe
HTTP(S) links, missing local references and descriptions. Inert rows no longer
receive file/open semantics. Actual behavioral RED was 18 failed/35 passed;
the implementation passed 119 checks across three files. A test-only unsupported
Testing Library option was caught by TypeScript, removed without changing its
exact string name assertion, and all 16 KnowledgePanel cases passed again.
All three TypeScript projects, scoped lint and formatting passed. Independent
review found no concrete remaining P1/P2 in this slice. Four Chromium/WebKit
light/dark real-page journeys passed with numbering, keyboard navigation and
unchanged files; body-ready screenshots and the original cold-load assertion
failures remain in the [acceptance record](../../acceptance/2026-10-24-knowledge/m97-resource-targets.md).
No latency budget, actual read/supporting role or native accessibility is claimed.

M96's native retained-owner finalizer is now registered. Its original three
SQL cases changed from 1 failed/2 passed to 3 passed; the larger publication group
passed 13, actions 116 with 3 intentional ignored cases, admission 4 and poisoned
metadata 1. Production cargo check passed with warnings attributable to the
still-closed M99 retention scaffolding. Independent review found a P2: the
existing ledger store loader can perform an unbounded/blocking read while the
new finalizer holds ownership and runtime-write locks. A bounded local repair
is in progress. Passing SQL cases do not close that finding or prove the real
native window callback. No public managed action route is enabled by this slice.

The existing page-read and lazy-editor loading branches now use the shared
accessible StateMessage instead of empty divs. Existing editor, mention-link
and state-message checks passed 69 cases. This is a loading-state presentation
repair; it changes no editor/save lifecycle or owner-selected composition.

## 2026-10-24 — Native store-read review repair

The M96 read-stall finding above is repaired. The original filesystem probes
changed from 3 failed/2 passed to passing; the full native-owner group passed
19 with one intentional child entry exercised through its finite parent tests.
The same freshly compiled test binary passed all 13 publication cases.
Production cargo check and cargo fmt passed; the separate closed M99 retention
scaffold still accounts for three warnings, so the final strict combined gate
is pending. The [native provenance record](../../acceptance/2026-10-24-connectors/m96-publication-provenance.md)
explains the retained bounded-file check and the remaining actual-window and
action-integration limits.

M95.6's [concrete supervised-job limits decision](../specs/2026-10-24-m95-supervised-job-decision.md)
was sent for the owner's required choice. Existing foreground research is
separate; supervised execution remains unavailable pending its scope proof.
M97.3's immutable configuration producer is proceeding with the approved
secret-free metadata and retention defaults. No milestone is complete.

## M99.7 protected retention and M95.6 owner decision — 2026-10-24

The selected body operation now joins the optional recovery copy to its exact
paired intent and performs startup recovery before scanning. The protected group
passes **26 tests**; overlapping broader groups pass **103 workspace-service,
35 recovery and 66 migration tests**, with their existing ignored helpers recorded
separately. Shared policy/twin checks pass **4 tests**. Strict all-target Clippy
and formatting pass after the command reads its same managed MCP state internally.
The three independent review probes first reproduced real failures and now pass
unchanged. [The acceptance record](../../acceptance/2026-10-24-storage/m99-paired-journal.md)
records the reviewed retirement-first contract change, original evidence, missing
expiry-witness limitation and pending-copy settlement gap. This does not complete
general selected editor writes, backup/import or migration activation.

The owner approved [M95.6 read-only supervised-job limits](../specs/2026-10-24-m95-supervised-job-decision.md):
one level, two concurrent children, eight per session, a ten-minute deadline,
256 KiB results and desktop-awake execution. Implementation is authorized;
execution remains disabled until backend isolation passes. Durable result-body
retention remains subject to the separate conversation-retention decision.

## 2026-10-24 integrated baseline and next native test stages

The permission-correct full frontend replay passes **942 files and 17,767 tests**,
with 15 existing skips, in 563.49 seconds. The original replay is preserved: it
passed 17,757 tests, failed ten recorder checks because process inspection was
sandbox-denied, and accidentally collected three source-evidence copies under
`.superpowers`. Test discovery now excludes those local packets, while retaining
all 942 real source suites. Lint and formatting also exclude the preserved local
packets; browser-automation snapshots are excluded from formatting. No product
test assertion or coverage threshold was removed or lowered.

The broad Rust baseline passes **4,402 tests**, with 41 ignored helpers and 62
crash-pattern cases excluded by M91's documented procedure, in 251.37 seconds.
The fresh native outcome capture still reports four passed/eight unavailable
product outcomes and six passing negative controls; its provider is synthetic.
All three TypeScript configurations pass. Full lint exposed one missing pure
generated-workspace-type import allowance; its new causal test failed before
the narrow exception and the complete **409-case import-rail suite** then passed.
A companion check requires that generated module to contain only type declarations
and no imported dependencies. Full lint passes. Formatting-only repairs retain
TypeScript/JavaScript syntax trees and JSON values, with original bytes saved.

These are checkpoint results. Subsequent native tests are now deliberately
registered before their implementations: M96 reproduces the original-publication
lifetime and catalog namespace gaps, actual writes through its proposed read
surface, and an oversized UTF-8 lineage read. M97's configuration stage produces
11 expected missing-functionality failures while three real lifecycle controls
pass. M99's selected editor stage is under compilation. The working tree therefore
is not a completed green release candidate; source identities and failing/passing
logs remain in the local evidence packets.

## 2026-10-24 — Retained native reads, configuration capture and selected save protocol

M96's three descriptive native commands now use the original published run and
opening, bounded metadata SELECTs and the compiled action catalog. The catalog
stage passes **209 tests**, with four intentional ignored helpers. V37 preserves
existing grants while admitting the compiled dotted action namespace. The finite
command inventory test reproduced four missing entries; they are now explicitly
classified, and actual selected-workspace denial remains in place for the M97
vault reader. No account writer, provider effect or Keychain route is enabled by
this read-only checkpoint. Actual macOS-window acceptance is being executed in a
separate, disposable, opt-in smoke executable.

M97's immutable run-configuration capture now records bounded, secret-free facts
from actual assembly and grant inputs before dispatch. Identifiers and private
selectors remain hashes; no prompt body, credentials or environment values are
retained. Generated Rust/TypeScript contracts replace the handwritten UI shape.
The native scope repair passes **43 tests**, with one ignored exporter. An added
terminal-row probe reproduced incorrect recorded status when a completed row had
no completion time; the reader now reports unavailable without deleting it.
The UI and contract group passes **75 tests**. The eight application/lab journeys
passed in Chromium and WebKit; a subsequent four-case replay refreshes the lab
captures after removing synthetic readable actor/model labels. These are browser
fixtures, not a live CLI or provider acceptance result.

M99's existing native save door now handles an ordinary selected-page body with
one request identity and a durable original operation. Pending or lost replies
resolve the original attempt; they do not authorize another write. Exact body
bytes and metadata remain separate. Crash checks replay the original receipt
once. Independent review reproduced a false zero for retention evictions after
resume; an actual 100 MiB quota test now reports the unrecorded count as unknown.
The combined native group passes **134 tests**, with one ignored exporter, in
124.67 seconds, covering these changes, paired recovery and command registration.

The retained frontend DocumentOwner has started adopting that protocol. Its four
additional boundary tests fail against the closed scaffold and pass after the
implementation; **84 tests** pass across eight owner/save/recovery files. The
selected page remains read-only while IPC forwarding, synchronous Entry-version
publication, Full width ordering, exact reads and explicit uncertain-outcome
reconciliation are integrated. No current vault was converted or activated.
All three TypeScript projects and scoped owner lint pass. Independent owner review
found no further concrete P1/P2. Strict combined gates remain in progress. The next
IPC/Entry/Full width tests reproduce eight expected failures while one existing
error-preservation control passes; their implementations are proceeding. No
M93–M99 milestone is declared complete by these checkpoint results.

## 2026-10-24 — Actual native read acceptance and next guarded consumers

M96's opt-in disposable macOS harness now passes **13/13** actual observations:
live original catalog and metadata reads, with fresh positive controls before
Stop, same-path reopen, A→B→A, same-byte/new-inode store replacement and actual
window destruction. The independent supervisor verified exit zero and matching
compiled/current source and binary identities. The [native acceptance record](../../acceptance/2026-10-24-connectors/m96-publication-provenance.md)
preserves the two startup refusals, narrow Tauri configuration repairs and precise
limits. This is actual Wry/injected-command read provenance with a fixture CLI;
real providers, account credentials, effects and packaged signing remain unproved.

The initial M95 bounded-validator and M96 retained account-metadata kernels pass
**90 tests** with no failures or ignored cases. Original RED was one passing
legacy control and eighteen intended missing-functionality failures. All original
assertions remain. The account kernel and supervised-job module remain test-gated;
no provider, secret or job executor is exposed. Separate corrupt-row probes then
reproduced an oversized attempt being rewritten and a mismatched payload cancelling
a replacement ticket. The shared reader now bounds text before allocation and
checks its identities against the selected physical row. The unchanged probes and
broader native group pass **115 tests**, with one intentional exporter ignored.
Fresh native formatting and strict all-target Clippy pass after four narrow lint
corrections; these are checkpoint gates, not a complete application release.

The M99 IPC/Entry/Full width group now passes its functional cases: the combined
replay has **219 passing tests and two IPC inventory failures**. The optional
smoke handler now has a separate exact default-off contract audit; all other Rust
orphan commands remain checked. M96's three currently uncalled descriptive reads
are named with reasons under the existing M54 rule. The remaining two inventory
failures identify the genuinely unfinished mounted selected-page reader consumer;
no placeholder import was added to hide them. All milestones remain open.

M99's next mounted-reader and explicit uncertain-save choice tests are registered.
The first run found a fixture-spy lifecycle error in eight cases; that setup was
corrected without changing assertions. The corrected run now reaches all intended
missing-functionality assertions: **12 fail and two negative controls pass**.
The nine mounted cases currently stop at the explicitly closed selected load;
remount, lost-reply, metadata barrier and explicit-choice acceptance await their
implementation and successful replay. The selected page is still read-only.

### Current mounted editor and native connector checkpoint — 2026-10-24

M99's first actual mounted editor implementation passed its original 14 cases.
Independent review then reproduced an opening-epoch defect in explicit conflict
choices; three adjacent initial/reconcile/source reads and the post-save
presentation observer had the same issue. Each negative failed against the real
mounted component before repair, with same-opening controls passing. The repaired
24-case mounted/owner group passes in 10.47 seconds. A known native Applied
acknowledgement remains acknowledged when the view changes; its stale asynchronous
presentation response is suppressed. Broader existing-editor tests and compiler
checks are running. SelectedDocPage remains read-only, and no current vault has
been converted or selected editing exposed.

M96's original-owner reserve/unlocked credential work/completion implementation
passed 38 of 39 combined connector/job checks. The sole failure compared a captured
intermediate cleanup-pending flag with its correctly settled value; every binding,
revision, health and observation field was identical. A fixture-only correction
now checks both states and retains full equality for all other fields. Actual
commit/lost-ack tests, original-owner retirement, exact cleanup, acquisition replay
and real mutex/SQLite lock probes passed. Independent source review found no
blocking defect in this four-file slice. Public credential writers and provider
routes remain unavailable pending their authenticated integration and acceptance.

M95's 11 transient result tests and 11 approved-limit/publication checks pass in
that combined run. Independent review found that Serde's default representations
accept positional arrays and an object-shaped enum beyond the declared JSON
schema. Additive byte-decoder probes are being run before repair. This transient
validator adds no result-body persistence, child execution or isolation claim.

M93 now has a [fresh production diagnostic and compositing experiment](../../acceptance/2026-10-24-reliability/performance-current/README.md).
The full baseline timed out during its fourth case. Two isolated clipping
variants completed their selected cases with every row retained; the outer-cell
variant recorded 1,000×24 synthetic keyboard p95 of 76.6 ms, against 1,382.3 ms
in the original baseline. The loaded-machine and instrumentation limits remain
explicit. No production CSS adoption or performance acceptance follows: browser
checks for long fields, Find, edit/remove targets and zoomed pickers are in progress.

### Integrated checkpoint — 2026-10-24

M99's mounted selected editor repair is independently reviewed. Additional real
component probes reproduced a save-await epoch race, an uncaught child-sheet
preparation refusal, and a stale error after successful retry. Repairs retain the
original durable acknowledgement, prevent a newer draft draining through a stale
opening, preserve the refused child draft and clear the alert after resolution.
The final three-file group passes **28 tests** (12.67 seconds); the preceding
broader editor group passes **236 tests**. SelectedDocPage remains read-only.
Human editor last-write-wins remains the documented contract; the native journal
captures the actual displaced external bytes before installing the human edit.

M95's strict transient-result decoder and M96's original-owner account
reservation/completion now pass **148 native tests**, with one intentional
exporter ignored. Alternate positional JSON and object-shaped enum inputs are
refused; literal duplicate-key controls pass. Native formatting and strict
all-target Clippy pass. No child execution, real credential import or provider
route is enabled. Authenticated Settings list/add-selection/disable is the next
bounded slice, with closed scaffolds registered for failure-first checks.

M93's real long-field Find failure is repaired in both browser engines. The
reveal preserves the existing selected bytes and focus, restores resting
truncation, and leaves ordinary pointer selection alone. Wrapper-only clipping
is now adopted while inner text truncators retain their hidden overflow.
**32 Chromium/WebKit journeys** pass across data-display and grouped tables,
including frozen columns, failures, zoomed pickers and Find; **115 TableView
tests** pass. All three TypeScript configurations, scoped lint and formatting
pass at this checkpoint. A guarded production build succeeds with all **2,236
source inputs unchanged** during the build. Its full performance matrix and
native Find/accessibility acceptance remain open; the earlier isolated CSS
experiments are diagnostic and do not establish native performance acceptance.

### Settings metadata, selected pages and scale checkpoint — 2026-10-24

M96 now routes actual Settings list, Add selection and Disable through the injected
native window and retained original runtime owner. Metadata transactions preserve
classified commit/lost-ack outcomes; no credential or provider route is opened.
A cross-connection active-ticket cancellation defect was reproduced before a
shared-kernel identity guard repaired it. The native group passes **112 tests**,
with one intentional exporter ignored, and independent specification/quality
review passes. Strict all-target Clippy and native formatting pass. A separate
fully qualified corrupt-row fixture replay passes **1 test**; the preceding
short-name `--exact` invocation selected zero tests and is not evidence.

The first frontend review found lost mutation ownership across Settings unmount
and stale account detail after reselecting during Disable. Eight additive cases
failed before repair while seventeen original cases passed. The app-session
repair now passes **25 mounted cases**; the broader current frontend invocation
passes **132 checks** across four files. All three TypeScript configurations and
scoped lint pass. Independent rereview found a remaining pagination race: a
precommit first page can survive remount, and a terminal postcommit page can
incorrectly reconcile an uncertain Add. That finding remains open; passing tests
do not establish Settings acceptance. New native metadata acceptance will use a
separate disposable process from the unchanged thirteen-case read capture.

M99 now mounts the native selected editor through the actual page dispatch when
the matching workspace is ready. Browser selected pages remain exact read-only
views. Native eligibility reasons and failed reads stay visible; body saves keep
the existing editor/Undo/Full width owner and original operation descriptor. The
focused replay passes **47 tests**, with independent specification/quality review
passing. A fixture previously counted both `Start` and `Resolve` as separate
writes; a diagnostic confirmed identical original-operation identity, target,
body and request key. The corrected test requires both exact envelopes and one
operation key. Actual native UI and remaining selected-workspace consumers still
need acceptance. No current vault was converted or activated.

M93's guarded production matrix completed four cases before the 5,000 × 12 case
timed out during filtering; nine later cases were unattempted. A separate
five-sample profile on the same unchanged frozen bundle completed and recorded
keyboard p95 **1,344.3 ms**, with only 39–53 ms recorded as JavaScript per timed
sample. These overlapping browser counters do not identify the remaining work.
A subsequent loss-free trace records 1,112.799 ms in Layerize during one
1,413.912 ms marked keyboard interval; nested durations are not additive.
A next rendering experiment is being scoped before source changes. The [performance record](../../acceptance/2026-10-24-reliability/performance-current/README.md)
retains the failed matrix, partial samples and subsequent diagnostic separately;
no timeout, sample target or acceptance budget was relaxed.

### Settings metadata review closure and actual native profiles — 2026-10-24

The remaining Settings pagination finding is repaired and independently reviewed.
A continuation now inherits the reconciliation eligibility of its first page;
a page loaded before Add settles cannot be made eligible by a later terminal
page. A fresh automatic first page followed by explicit Load more remains valid.
Both new negative cases reproduced a second actual Add before the repair. The
unchanged 29 mounted cases and 55 IPC cases now pass (**84 checks**, 7.12 seconds),
with all three TypeScript targets and scoped lint passing. The scoped round-two
review reports all findings addressed and no new P1/P2.

[Two disposable native profiles](../../acceptance/2026-10-24-connectors/native-settings-metadata/README.md)
then passed **13 original read observations and 16 metadata observations** in
separate fresh processes using the identical binary and compiled/current source.
The metadata profile exercises actual authenticated wrappers, original runtime
ownership, invalid/stale input refusal, Stop/opening persistence, exact origin
restoration and actual window retirement. Its final SELECT-only audit finds one
disabled synthetic metadata account and zero attempts, secret references, cleanup
rows or grants. Independent specification/quality review passes. These are native
wrapper tests, not mounted Settings clicks or production release-signing evidence.

The explicit feature-enabled strict Clippy command subsequently found eight errors
in older harness startup/environment/printing sites. The default native gate had
not included that optional feature. A bounded repair is being prepared: set only
the spawned app's isolated environment in its supervisor, validate it in Rust,
and use the existing bounded diagnostics logger. The original successful native
reports remain pinned to their exact source; rebuild/replay after this repair is
required. No real credential, Keychain item or provider was accessed.

### Harness repair and selected-editor refresh failures — 2026-10-24

The native harness lint repair is now independently reviewed. Strict feature-enabled
all-target Clippy passes, the binary rebuild succeeds, and separate fresh processes
again pass all **13 read and 16 metadata observations**. The latest evidence is
under [repaired native profiles](../../acceptance/2026-10-24-connectors/native-settings-metadata/README.md).
Both runs use binary `92501a91163d38d2572930199fe3e7dbb8b163ae00bd77f85cdccd5142a62aa8`
and current/compiled source digest
`1385c113cb48fc1cdc3027e2c6bd7792b796c582be6a16fc8517f0e18108ebfa`.
The earlier feature-lint failure is retained as historical evidence. A separate
default-off packaged Keychain acceptance proposal is undergoing review; no signing
or Keychain operation has run yet.

M99's new selected-editor watcher suite first failed in its native transport
fixture. After correcting that fixture, the actual run reports **13 failed and
4 passed** across 17 cases. The failures cover refresh after a failed workspace
scan, persistent read failure and Retry, stale openings, and preserving newer
typing across an original acknowledgement. A diagnostic confirms a new draft's
`Start` followed by its `Resolve`, in addition to the original draft's `Start`;
this is distinct from the earlier accepted same-operation fixture correction.
Stale-toast checks also exposed a missing native window fixture, corrected in a
separate test-only patch. That correction preserves every existing assertion; the
fresh full run still reports **13 failed and 4 passed** (10.86 seconds), with
the unrelated file-drop notices gone. Production repair and independent review
remain open.

M93's text paint-containment diagnostic is rejected. On the unchanged frozen
bundle, Layerize remained **1,108.597 ms** versus the preceding **1,112.799 ms**
single observation, while the marked interval was **1,749.092 ms**. These loaded
machine observations do not establish a controlled regression or improvement.
No containment CSS was adopted. The next candidate first checks actual truncation,
selection and pointer behavior in both browser engines before any source change
or performance comparison. Full scale and native acceptance remain open.

The selected-editor refresh repair now passes all **17 unchanged watcher cases**
(16.55 seconds) and **179 existing checks** across the selected-page, store,
refresh-coalescer and legacy editor suites (17.57 seconds). All three TypeScript
targets and scoped lint pass. The two-file repair records ordered failed-scan
observations without replacing Entries, holds the existing editor owner before
newer typing can drain, and shows separate persistent page-read and workspace
refresh failures. Retry uses the existing reconciliation path. Independent spec
and quality review passed with no P1/P2 findings; no native UI, broader authority
adoption or conversion is inferred.

The M93 clipping experiment's cleanup replay collected all four browser contexts
and exited naturally. Both owned browser servers were closed and their exact
loopback endpoints refused connections. The long and fitting text crops remained
byte-identical across baseline/candidate and to the first run. The old helper's
candidate Find reveal failure remains expected; zoom and integrated performance
acceptance remain open. No experimental CSS was adopted.

M96's default-off Keychain harness now compiles and passes both unknown-count
observation checks and all 55 IPC contract checks. The retained synthetic process
diagnostic observed successful TERM/KILL followed by transient group EPERM and
then ESRCH within about 40 ms in both cases. EPERM alone is not accepted as proof
of disappearance. Supervisor tests and source ownership review remain open; no
signing or Keychain operation has run.

### Native observation, parent ownership and supervisor checkpoint — 2026-10-24

M99's [ordinary external-body native slice](../../acceptance/2026-10-24-workspace/selected-external-bodies/green/independent-review.md)
passes independent specification and quality review. Its causal native tests now
pass **12 ordinary cases plus the separately run 128 MiB aggregate case**.
The human presentation scan returns exact observed body hashes separately from
canonical metadata authority; strict corpus and checked writers stay strict.
Saving one ordinary page can count unrelated external bodies within the existing
aggregate budget without adopting those bodies. Retained view scope uses canonical
metadata. Frontend/contract checks pass **152 tests**, all three TypeScript targets
and scoped lint pass, and the generated observation contract is verified.
Frontend observation/ack reconciliation, clean **Save this text**, pending-intent
cold-open ordering and actual native UI remain open.

M95's [original native parent-attempt metadata](../../acceptance/2026-10-24-chat/parent-attempt-green/independent-review.md)
passes **15 checks** and independent specification and quality review. Runtime V38
binds one native-minted attempt to the actual finalized attended parent in the
existing transaction, with replay and no legacy backfill. This creates no child
admission or execution authority. Delegation intents, transactional session limits,
claim/Stop/deadline behavior and backend isolation remain open; jobs stay disabled.

Broader native checks pass **144 workspace-service, 61 native-owner and 34
publication cases**. The runtime group records **481 passed, one failed and two
ignored**: its source guard counted a legacy-row test fixture as a production
writer. The narrow repair makes that file compiler-enforced test-only and recognizes
that exact file-level attribute in the guard; it preserves the legacy fixture and
all four production writer assertions. Fresh verification is running. These counts
overlap the focused suites and are not a combined test total.

M96's [supervisor repair](../../acceptance/2026-10-24-connectors/native-keychain/supervisor-review/independent-rereview.md)
passes **15 Python checks** and independent review. It retains child identity until
all nonzero group signals finish, always attempts bounded reap, and requires actual
ESRCH to confirm group absence. Earlier failed diagnostics remain failed. Current
native/static gates, fresh original read/metadata profiles and the disposable
ad-hoc Keychain run remain pending. No signing or Keychain operation has run.

The [supplementary M93 200% CSS zoom comparison](../../acceptance/2026-10-24-reliability/performance-current/integrated-production/text-resting-clip-phase-a/zoom200-collapsed/ROOT-REVIEW.md)
completed all four contexts with confirmed cleanup. Root inspected both engines'
long/fitting crops; each baseline/candidate pair is byte-identical. This uses the
actual Hide sidebar action. The expanded-sidebar case remains unavailable because
the target cannot fit its unfrozen corridor, and native zoom remains unverified.
A separate CSS-only performance attribution is being prepared; no experimental
product styling or helper change is adopted.

### Current native gates and disposable Keychain result — 2026-10-24

The source-guard and strict-scan lint repairs pass independent review. Fresh Rust
formatting, default and feature-enabled strict all-target Clippy pass. The rebuilt
native smoke binary passes all **13 read and 16 Settings metadata observations**
in separate fresh processes, with matching compiled/current source identities.

The first [disposable ad-hoc Keychain run](../../acceptance/2026-10-24-connectors/native-keychain/adhoc-first-attempt/ROOT-REVIEW.md)
**did not pass**. Actual bundle identity and three fresh missing-reference reads
succeeded, but the first put returned unavailable. Its outcome is uncertain:
zero confirmed-owned references, one uncertain put, four preserved receipts and
**cleanup pending**. One random noncredential test value may remain. The exact
original package/receipts are retained for a separately reviewed recovery step;
no retry or entitlement change followed. The process itself exited and was reaped,
with group absence confirmed. This does not establish production credential or
signing readiness, and managed credential activation remains disabled.

M99's next frontend observation tests reproduce **six failures with eight passing
controls**: three version/observed-hash inconsistencies and three missing persistent
external-change notices. Implementation follows those causal failures. The M95
intent/allocation tests are compiling; no child admission or execution is enabled.

## Explicit selected save and native credential metadata — 2026-10-24

The [clean explicit save acceptance packet](../../acceptance/2026-10-24-workspace/selected-external-bodies/clean-explicit-save/ROOT-REVIEW.md)
records 319 current frontend checks, all three TypeScript targets, scoped lint and
independent source review. Exact-byte retries, view changes, blocked choices and
terminal unknown Keep yours are covered. It leaves native UI, remaining consumers,
backup/import and activation open; no current vault was converted.

The default-off authenticated credential metadata harness now passes 15 native
cases, followed by the prior 13 read and 16 Settings metadata cases on the same
binary. Its workers deliberately return unavailable; this proves retained-owner
metadata lifecycle and cancellation, not usable credentials or production Connect.
The original uncertain Keychain put remains preserved with cleanup pending.

The M95 original-origin integration is under native verification. Its first build
found harness type errors, which are being corrected before any causal native RED
claim. Public supervised execution remains disabled. M93 table captures reproduce
a Chromium ellipsis paint regression after Find; that UI change and performance
acceptance remain open. No milestone is complete.

## 2026-10-24 native delegation integration checkpoint

Original native caller integration passed 15 actual desktop cases; same-binary credential 15, read 13 and Settings 16 replays passed. [Source review, exact identities, reports and limits](../../acceptance/2026-10-24-agents/native-delegation-origin/ROOT-CHECKPOINT.md). The build had no warnings and 91 IPC/inventory checks passed. Final combined Rust gates remain pending. These are inert intent/reservation and metadata operations; public supervised execution stays disabled. The preceding sandbox desktop-startup timeout is preserved as unavailable evidence.

M99 inactive staging now excludes legacy connector configuration and abandoned atomic-write temporary files before reading or hashing them. The causal tests first produced three failures and one passing retention control; the reviewed fix passes all 70 migration checks with one intentional ignored test. [Evidence and limits](../../acceptance/2026-10-24-workspace/staging-private-exclusions/ROOT-REVIEW.md). Portable backup/restore and historical-archive handling remain in progress.

M93 table resting-text optimization now preserves actual Find glyphs and restores exact ellipsis paint in both engines. The full original-plus-new browser spec passed all 60 cases, with all TypeScript targets, scoped lint and formatting passing. [Causal pixel RED, final captures, source review and scope](../../acceptance/2026-10-23-reliability/performance-current/integrated-production/text-resting-clip-behavior/ROOT-REVIEW.md). Production performance and native accessibility acceptance remain open.

The bounded M95 native-origin slice now passes its 21-case delegation/migration replay, combined native regressions and strict all-target Clippy in default and native-credential-smoke configurations. Its original-caller integration is accepted for inert metadata only. The next slice freezes actual readonly grants; public child execution remains disabled.

## 2026-10-24 production performance campaign

The fresh production table campaign completed five cases and stopped at the 5,000-row,24-column filter/reset timeout. Both1,000-row shapes measured inputp95 below100ms in this first browser round;5,000x12 completed its20samples, while5,000x24 retained only8filter samples. Eightremainingcases androunds2/3 were notrun under the declaredfirst-failurestop. The natural runnerexit, witnessedchildcleanup and all before/after source-runner/bundle/dependency checks were observed. Sharedhostload and observeroverhead remain explicit; this is not native or repeated performance acceptance. [Full evidence and remaining work](../../acceptance/2026-10-23-reliability/performance-current/integrated-production/resting-clip-matrix/ROOT-REVIEW.md).

## 2026-10-24 — Wide-filter trace and immutable child-grant integration

The [fixed wide-filter diagnostic](../../acceptance/2026-10-23-reliability/performance-current/integrated-production/wide-filter-cycle/ROOT-REVIEW.md) completed under root session 62642 with unchanged production resources, exact 5000×24 controls, a complete bounded raw trace and natural witnessed cleanup. One traced apply took 1.605 seconds; clearing to all rows took 5.782 seconds. Source/trace analysis is underway. The original full matrix remains failed and later rounds remain unrun.

M95's immutable local child-grant packet passed independent source review and its 18 guarded targets were registered. Initial compilation found only an undeclared test-fixture dependency; a fixture-only repair reuses the existing temporary-vault helper with Drop cleanup and changes no assertions. Repaired compilation and the deliberate policy digest writer are running. No executed GREEN result, child execution, backend isolation or M95 completion is claimed.

## 2026-10-24 — Immutable child grants pass native validation

The [M95 grant-freeze checkpoint](../../acceptance/2026-10-24-agents/native-child-grant-freeze/root-native-green/ROOT-CHECKPOINT.md) records the unchanged 22-case native profile passing, followed by original delegation 15, credential metadata 15, read 13 and Settings metadata 16 on the same freshly built binary. Independent source review, 1541 scoped Rust tests, 348 frontend policy checks, policy digest regeneration and both strict Clippy configurations are recorded with the two small compile/quality repairs and preserved earlier failures. Supervised child execution and backend isolation remain closed; this is one verified M95.6 layer, not milestone completion.

## 2026-10-24 M96 owned import-worker bridge

The original native owner/worker now calls the existing import coordinator after its Pending commit. The unchanged eight-case desktop profile passes after a preserved causal RED; same-binary credential15/read13/Settings16/delegation15/frozen-grant22 regressions pass. Kernel119 (one intentional ignored child), IPC55, both strict Rust configurations, inventory and native build pass. [Evidence and limits](../../acceptance/2026-10-24-connectors/native-import-worker/root-native-green/ROOT-CHECKPOINT.md). The fixed adapter stops before secret construction. Production commands, real adapters and Keychain acceptance remain open; no milestone is complete.

## 2026-10-24 M93 grouped field-store subscription

The trace-supported FieldEditor subscription grouping passed independent source review, 20 baseline behavior checks, 283 candidate/adjacent checks, all TypeScript targets and scoped lint/format. A pre-existing literal twin-registry header mismatch was separately repaired and its three tests pass. [Evidence](../../acceptance/2026-10-23-reliability/performance-current/integrated-production/grouped-field-editor/ROOT-CHECKPOINT.md). Controlled A/B timing and the 60-case browser rerun are pending; the prior scale matrix remains failed.

## 2026-10-24 M99 first portable execution

The reviewed v7 inactive backup/restore implementation was registered; three compiler integration errors were repaired without changing assertions or dependencies. The resulting binary ran all 41 portable cases: **4 passed, 37 failed**. The live export guard incorrectly compared the macOS descriptor alias filesystem device number with the backing file device. A disposable OS probe confirms the mismatch; descriptor-based repair is pending. The watchdog completed and reaped the process; later regression phases were not run. [Preserved evidence](../../acceptance/2026-10-24-workspace/portable-backup/first-execution/ROOT-CHECKPOINT.md). No current vault was converted or activated.

## 2026-10-24 portable repair execution and child reservation lifetime

The reviewed M99 descriptor repair compiled without warnings. The unchanged 41-case portable group then produced **38 passes and 3 failures**, with no ignored cases or watchdog failure. The remaining failures concern deliberately forged receipt setup, the concurrent SQLite writer's path and admission after an inactive restore. Later regression phases stopped at this failed gate. Exact source, compiler and runtime evidence is preserved in [the descriptor repair checkpoint](../../acceptance/2026-10-24-workspace/portable-backup/alias-repair-execution/ROOT-CHECKPOINT.md). No complete backup/import or activation claim follows.

M95's next lifecycle slice now has an actual causal failure: after a parent durably finishes, its inert child reservations still occupy concurrency slots. The primary assertion fails with `Concurrency`; all 13 new cases produce **8 expected failures and 5 controls passing**. The bounded repair is being prepared; production code is unchanged for this slice. [The RED checkpoint](../../acceptance/2026-10-24-agents/child-reservation-lifetime/root-red/ROOT-CHECKPOINT.md) retains source and actual execution evidence. Child execution remains disabled pending backend isolation.

## 2026-10-24 grouped table selector — browser acceptance and diagnostic pair

The grouped subscription candidate passed **60 Chromium/WebKit cases** and **20 unchanged pixel comparisons**. Two fresh production builds share one complete 2,459-file input snapshot and differ only in FieldEditor. Their bounded 5,000 × 24 diagnostic cycles preserve all 120,000 real text controls, complete values, 5,000 open controls and zero writes. The candidate's single clear cycle still takes **5,324.970 ms** through two frames, versus **5,630.204 ms** for the baseline. Fixed order, different garbage-collection stages and shared machine load prevent a trend or retained-memory claim. The original full matrix remains failed; no broad performance acceptance is claimed.

[The complete controlled-pair checkpoint](../../acceptance/2026-10-23-reliability/performance-current/integrated-production/grouped-field-editor/controlled-pair/ROOT-CHECKPOINT.md) preserves source identities, both builds, browser evidence, both traces and the disjoint interval analysis. The next diagnostic is bounded JavaScript attribution on the frozen candidate, before choosing another source change.

## 2026-10-24 next verification checkpoint

The terminal/deadline reservation repair passes all **13 new lifecycle cases** and the adjacent delegation, frozen-grant and migration checks: **56 distinct passing tests**. It preserves the lifetime count and uses the existing original-owner transaction; child execution remains disabled. Strict Rust and refreshed native profile verification are pending.

The three remaining portable failures were independently confirmed as fixture defects. Corrections preserve every original assertion and add the real native admission/opening checks for inactive restores. Each corrected case passed, followed by all **41 portable cases**, the **2 media cases** and **24 selected-workspace cases**. The remainder of the planned regression run is still active. Both changes compiled together without warnings on an unchanged 895-file native input inventory. These are interim results, not M95/M99 completion or current-vault conversion authorization.

## 2026-10-24 reservation lifetime and portable library verification

The [reservation lifetime checkpoint](../../acceptance/2026-10-24-agents/child-reservation-lifetime/root-green/ROOT-CHECKPOINT.md) records 13 new lifecycle cases and 56 distinct passing focused tests. Terminal/deadline retirement preserves the eight-child lifetime count and original native owner; supervised execution and backend isolation remain disabled. The original causal failures and two setup/inventory corrections are preserved.

The [portable library checkpoint](../../acceptance/2026-10-24-workspace/portable-backup/library-verification/ROOT-CHECKPOINT.md) records the completed **611-pass, one-ignored** regression sequence. Six later Clippy diagnostics were repaired with equivalent sorting and test-only type aliases after independent review. Both strict Rust configurations and fresh builds pass; the unchanged 41 portable and two media tests pass again on the fresh binary. Six desktop profiles pass **89 cases** on its matching native binary, with unchanged producer inventories and bounded cleanup evidence. This is not a current whole-branch gate.

Independent review of the next backup UI found two prerequisites: inactive restored content can be reached through an unmarked legacy ancestor, and output admission needs coordination with legacy vault switches. Direct restored-root refusal does not cover those routes. A deny-only nested boundary test packet and the output/opening design are in progress; no backup product door or current-vault conversion is enabled.

The separate M93 CPU attribution attempt remains **failed** because its validator rejected signed sample deltas. Independently checked posthoc arithmetic preserves the original records and correlates the selection-read initialization with a long layout event; it establishes neither call count, CPU self time nor a promised saving. The full scale matrix remains failed. A reusable-decoder missing-count correction and a narrowly scoped source design are being prepared before another experiment.

## 2026-10-24 inactive-copy ancestor regression reproduced

The [new restore boundary checkpoint](../../acceptance/2026-10-24-workspace/portable-backup/nested-format-boundary/root-red/ROOT-CHECKPOINT.md) records **28 causal failures and 10 passing controls** after a clean compile. Real restored body/original reads, writes, recursive reads, metadata export and ancestor opening demonstrate the gap; direct-root and unrelated sibling controls still pass. All existing 41 portable scenario bodies are unchanged. This is failure evidence, not a completed repair; bounded scope guards and a lasting metadata boundary are next.

The [separate reviewed CPU interpretation](../../acceptance/2026-10-23-reliability/performance-current/integrated-production/grouped-field-editor/cpu-posthoc-analysis/ROOT-CHECKPOINT.md) preserves the failed capture and resolves the reusable decoder's missing-count issue without altering actual observations. The next candidate changes only the selection helper's collapse predicate and preserves effect lifetime; behavioral and fresh same-source diagnostic evidence remain pending.


## 2026-10-24 selection-preservation checks and supervised-job claim design

The table selection sidecar now collects exactly two scenarios in each browser engine. All three TypeScript targets and scoped lint/format pass; the existing selection helper is unchanged while baseline browser behavior is checked. The full scale matrix remains failed, and no timing improvement is claimed.

The [owned child claim and recovery design](../specs/2026-10-24-m95-owned-child-claims-and-recovery-design.md) passed independent review after correcting mixed reservation accounting and restart recovery. It specifies actual run/claim lineage, one consuming owner and historical terminalization. Its next tests must exercise the real native parent/reservation/freeze path. Public supervised execution remains disabled until backend isolation is proved.


## 2026-10-24 browser failure preserved and native child-claim failure verified

The selection candidate passed 115 TableView tests and all static checks. Its baseline browser run passed four cases, but the candidate run produced **three passes and one failure**: Chromium lost the evaluation context during the dynamic store import/replacement step. The [first-execution checkpoint](../../acceptance/2026-10-23-reliability/performance-current/integrated-production/selection-range-first-execution/ROOT-CHECKPOINT.md) preserves source identity, successful prerequisites, failure and cleanup. Cause remains unresolved; the wider 60-case suite and performance comparison have not run. A single instrumented diagnostic is being prepared.

The [owned child-claim checkpoint](../../acceptance/2026-10-24-agents/owned-child-claim/root-red/ROOT-CHECKPOINT.md) records a clean compile, **six successful native prerequisites followed by the intended missing-claim failure**, and **22 unchanged frozen-grant checks passing** on the same binary. Implementation now targets actual claim/run lineage, one consuming owner, lifecycle accounting and historical recovery. Backend isolation and public execution remain unproved/disabled.

Independent storage review found three issues in the still-unregistered boundary candidate: lexical aliases can pass through a protected namespace, contained leaf aliases are incorrectly refused, and multi-target writer checks reset their aggregate budget. The author is correcting these before registration. Durable body/metadata seals passed source review; runtime and broader native acceptance remain open. No milestone is complete.


## 2026-10-24 single browser diagnostic narrows the failure

The [instrumented diagnostic](../../acceptance/2026-10-23-reliability/performance-current/integrated-production/selection-range-context-diagnostic/ROOT-CHECKPOINT.md) reproduced the Chromium evaluation error. Its complete bounded log shows the module import resolved and the store update returned; the remaining final read/result/protocol interval is still unresolved. Only the initial navigation and Vite connected message were received, and the page remained open. No reload cause is established. The original failure remains failed, with no wider suite or timing run.

The [first storage candidate review](../../acceptance/2026-10-24-workspace/portable-backup/nested-format-boundary/green-v1-source-review/ROOT-CHECKPOINT.md) is now retained with the rejected source and exact findings. Its corrected successor and the actual child-claim implementation remain offsource pending independent review and execution.

## 2026-10-24 latest bounded review and diagnostic

The M93 raw-protocol diagnostic passed its single instrumented Chromium case and captured a successful original evaluation reply. This is a non-reproduction, not a repair or clearance of the two previous failures. [Exact evidence](../../acceptance/2026-10-23-reliability/performance-current/integrated-production/selection-range-raw-protocol-diagnostic/ROOT-CHECKPOINT.md) preserves both preflight outcomes, the captures and process cleanup. Source, dependencies, runtime and caches remained unchanged; no wider suite or timing test followed.

M95’s final deadline check passed scoped source review. Its optional causal regression needs a safe pre-assertion outcome record before execution. M99’s second boundary candidate fixes ordinary leaf aliases and aggregate writer budgets, but review still found a deeper intermediate-alias ancestry gap and a marker recheck gap at the reader handoff. These candidates remain unregistered while their narrow successors are prepared. No milestone is complete.

M99’s third nested-boundary candidate passed scoped source and formatting review, including the deeper alias route and the held-reader marker check. Integration with M95 is being reviewed against exact overlapping file changes. No boundary runtime acceptance is claimed yet.

M95’s reviewed lifecycle source is registered for native verification. The first compilation stopped at unsupported unsigned SQL conversions; no native regression was executed from that build. A narrow checked-conversion repair is in progress. The native regression subsequently reproduced the expired-owner handoff with the final check omitted. Root restored the exact reviewed check and rebuilt; all 41 native deadline, claim-lifecycle and unchanged freeze cases passed. [Retained evidence](../../acceptance/2026-10-24-agents/owned-child-claim/deadline-and-lifecycle-root/ROOT-CHECKPOINT.md) records both variants and the failed first compilation. Public supervised execution remains disabled; actual restart, wider failure coverage and final gates remain open.

The first combined M95/M99 Rust build passed and all 166 focused cases passed. Broader integration returned 883 passed, 10 failed and 3 intentionally ignored across 896 additional cases. The ten failures concern ordinary root-path and refusal compatibility in scan/corpus, batch/source reads and MCP demo queries; they remain open and no golden/assertion was relaxed. [Exact integrated evidence](../../acceptance/2026-10-24-workspace/portable-backup/nested-format-boundary/root-integrated-first-execution/ROOT-CHECKPOINT.md) records source identity, all selected/excluded names and the failed gates. The new source-reader handoff slice is paused while those regressions are repaired.


## 2026-10-24 ordinary compatibility restored; new fixture checks still open

The four-target storage correction passed independent source/format review and compiled on the combined M95/M99 source. All ten original compatibility failures now pass without changing their assertions or golden files. Of eleven additional boundary tests, seven pass and four fail on the expected refusal type/message; those failures remain open while a fresh reviewer/implementer diagnoses marker fixtures and the actual command route. The broader affected checks are running. This is not a completed storage gate.

The revised UI selection fixture is prepared for independent review. It captures the mounted store before native Find and performs the selected-state update synchronously, retaining physical selection, content and zero-write assertions. That changes the test setup and does not explain or erase the historical asynchronous evaluation failures. No new browser acceptance or performance result is claimed.

Supervised-job restart verification remains in preparation. The design now requires retaining the actual unreaped child identity until the owning process ends; a separate OS characterization must establish that behavior before the two-process application recovery test. Public supervised execution remains disabled.


The [legacy compatibility correction checkpoint](../../acceptance/2026-10-24-workspace/portable-backup/nested-format-boundary/root-legacy-compatibility-correction/ROOT-CHECKPOINT.md) now records the passing original ten cases, unchanged 98 boundary and 41 portable cases, and the broader legacy/MCP/workspace results. Ten sandbox socket setup failures passed unchanged with loopback access. The four new failures were corrected by a reviewed one-byte test-fixture version change; all eleven additional cases now pass with every assertion preserved. Earlier failed attempts remain recorded. Source-reader descriptor handoff and native/output-opening acceptance remain open.

The revised UI sidecar is registered and passes all three TypeScript targets, scoped lint/format and exact collection of four Chromium/WebKit cases. Fresh browser behavior remains pending; no historical failure is relabeled as passing. The standalone supervised-job process probe needs a known-exited-but-unreaped positive control before its absence checks can be accepted; that narrow review correction is underway.


Both default and native-feature all-target Clippy checks now pass with warnings denied on the corrected storage producer. These are compilation/lint results, not a fresh native application run. The next source-reader regression packet passed source review and remains unregistered while the browser comparison holds a stable source snapshot.

The [first standalone process-characterization checkpoint](../../acceptance/2026-10-24-agents/owned-child-claim/retention-characterization-first-execution/ROOT-CHECKPOINT.md) records a successful offline build and five synthetic validator tests, followed by an actual OS failure at the post-exit identity check. The first profile stopped before the known-exited-child visibility gate; the other six did not start. The raw failure and cleanup observations are retained, and diagnosis must precede any changed check or retry. This does not establish application restart recovery.


## 2026-10-25 source handoff reproduced; browser comparison held

The [source-reader regression checkpoint](../../acceptance/2026-10-25-workspace/source-reader-handoff/root-red/ROOT-CHECKPOINT.md) records the intended failure: a replaced pathname caused the reader to return the replacement file's content after validation. Six new controls and both unchanged source tests passed. A narrow descriptor-based repair is being prepared; no completed repair or native transport acceptance is claimed.

The new browser comparison captured fresh source, dependencies and tools, but neither arm launched. Cross-review of the OS investigation found that its inherited live-process lookup can report an exited-but-unreaped identity as gone. Direct runner reaping remains meaningful; exact descendant absence requires a corrected observer and host proof. The old capture is retained and cannot be silently reused for the changed observer. The global source hold was released to continue independent Rust work; the UI helper remains the reviewed candidate.

The standalone process probe's proposed successor preserves every identity comparison and adds raw observations while selecting the published zombie-inclusive query for its exited phase. It remains under source review. The earlier failed run does not establish its exact syscall result or errno.

## 2026-10-25 process-retention and source-reader checks

The [standalone process-retention checkpoint](../../acceptance/2026-10-25-agents/owned-child-claim/retention-characterization-v3/ROOT-CHECKPOINT.md) records seven passing macOS lifecycle profiles, an offline build, eight synthetic test methods and independent source/execution review. Known exited-but-unreaped children remained visible to the observer before final process/group absence. Cancellation, panic and watchdog profiles reached their specified rejected endpoints. The earlier failed attempt and outer capture signal errors remain preserved. This verifies the standalone prerequisite; application restart recovery, actual application Stop/shutdown and public supervised-job isolation remain open. The next R0 fixture is being implemented against the real application opening path.

The source-reader handoff now reads and hashes the same qualified file descriptor. The unchanged causal test that previously returned replacement content now passes, together with six other handoff cases, two original controls, 109 boundary cases, 41 portable-backup cases and 143 ordinary read/write cases. These groups overlap by two tests. Both default and native-feature all-target Clippy checks pass with warnings denied. The current Rust source identity is `d5079c195fffef14862bf518cc6274cc9da811e98e6674c072f4f56eebba78c7`; no native UI execution is inferred from these Rust tests.

The first boundary selection was labeled109 but actually selected63; its inventory and result correctly recorded63. The remaining46 exact names were run separately, completing the intended109-case union without changing assertions or repeating those63. The prior causal failure remains recorded. Late workspace publication/refusal propagation and the other native P1/P2 acceptance requirements remain open before backup UI and migration activation.

The M93 browser pair remains held. Its old cleanup observer could mistake an exited but unreaped process for absence. The narrow corrected design keeps live adoption/signaling separate from cleanup, requires spaced observations, and closes all toy signal authority before a consuming reap in its control fixture. The revised design is under review; no new browser arm, helper transition or accepted performance measurement has occurred.

M94 composition, M95 archive retention and M98 platform/retention choices remain pending. The original uncertain disposable Keychain put remains cleanup-pending. No milestone is complete, no current vault was converted and no public connector or supervised-job execution was enabled by these checks.


## 2026-10-25 actual restart baseline and prepared selection comparison

M95's bounded two-process restart baseline is independently accepted. Omitting child recovery only in the native test feature produced the intended failure; restoring it settled the interrupted child before the ordinary parent sweep. A second opening in the same process made no additional settlements. All 41 preserved native controls and 85 focused Rust tests passed, with default and native-feature Clippy also passing. [Retained source, negative and positive runs, review and limitations](../../acceptance/2026-10-25-agents/owned-child-claim/restart-baseline/ROOT-CHECKPOINT.md). R1/R2, actual Stop/shutdown fault schedules and backend isolation remain open; public supervised execution is still disabled.

M93's prepared-store selection comparison passed four baseline and four candidate cases across Chromium and WebKit, with unchanged assertions and no retries. The helper was the only source difference; observed source, dependency, runtime and cache checks passed, and the candidate was restored. The qualified cleanup observer retained exited-but-unreaped identities correctly before recording absence. [Exact browser evidence and independent review](../../acceptance/2026-10-25-reliability/selection-range-prepared-store-pair/ROOT-CHECKPOINT.md). This prepared fixture does not explain the older asynchronous-import failures. The original 60-case table regression, large-table performance and native quit timing remain open.

M96's explicit connector-ownership denial tests are drafted and independently reviewed, but have not been registered or executed. The source trace and compatibility controls do not establish runtime failure or complete managed routing. The existing uncertain disposable Keychain put remains cleanup-pending. No milestone is complete, no current vault was converted, and the outstanding owner choices remain unchanged.


## 2026-10-25 original browser regression accepted; connector ownership reproduced

All 60 original data-display checks passed once on the recorded candidate: 30 Chromium and 30 WebKit, with no retries, skips or errors. Independent review accepted the exact behavior results and qualified cleanup. [Retained evidence and limitations](../../acceptance/2026-10-25-reliability/selection-original60/ROOT-CHECKPOINT.md) includes the fresh source/runtime capture and the subsequent four-file M96 test registration. This is a completed bounded browser regression; historical selection failures, large-table performance, native quit timing and wider UI composition acceptance remain separate open gates.

M96's four additive ownership test files are now registered. Typechecking and Rust compilation passed. The selected tests reproduced the predicted legacy-route admission gap: eight Rust and twelve frontend assertions failed, while two Rust and three frontend compatibility controls passed. The frontend's 62 unselected tests were filtered out, not executed. Independent causal review is underway; no managed connector fix or routing acceptance is claimed yet. This test-only registration happened after the browser run's finite source hold ended.

Native quit fixture review found two source blockers before launch: its Python guard rejected the qualified launcher/interpreter distinction, and its Vite entry did not preserve the export needed by the loader. The original author is correcting those fixture issues. Production quit timing remains unchanged. The supervised-job R1 restart proposal passed source review; a disposable SQLite last-connection-close preflight is being prepared before any actual R1 attempt.

No milestone is complete. Public supervised jobs remain disabled, the uncertain disposable Keychain attempt remains cleanup-pending, and no current vault has been converted. The outstanding owner choices remain unchanged.


The [connector ownership causal checkpoint](../../acceptance/2026-10-25-connectors/ownership-root-red/ROOT-CHECKPOINT.md) is independently accepted: 20 observed causal failures and five passing compatibility controls. Two row failures are nullable-output matcher TypeErrors; later loop variants are not credited. The shared ownership repair is being authored.

The [disposable SQLite close prerequisite](../../acceptance/2026-10-25-agents/owned-child-claim/restart-sqlite-preflight/ROOT-CHECKPOINT.md) passed eight validator tests and both actual profiles. The preserving case retained the original DB/WAL/shared-memory identities through last close and read-only reopen; the separate normal-close control removed its sidecars. This enables preparation of the actual R1 failure-recovery test, which has not yet run.


## 2026-10-25 connector repair behavior passes; native fixture build held

The shared connector-ownership repair is registered. Its first typecheck failed on a raw JSON import in the DOM-free engine; the reviewed two-line correction preserves the parser and shared artifact. Fresh verification then passed full typechecking, 164 selected frontend tests, 24 registry checks and 348 shared-policy frontend tests (six skipped). The Rust connector group passed 51 tests and ownership passed three; the broader affected Rust groups passed as recorded, with the ownership group overlapping the policy group. The digest writer preserved the artifact anchor.

Strict default Clippy stopped on two avoidable clones in the new test controls. A reviewed two-line correction is registered; its final Clippy and affected-test verification remain pending. The original causal failures, failed typecheck and Clippy diagnostics are retained. These results do not establish managed provider routing, production credential commands or native connector acceptance.

The native quit fixture now emits its two locally pinned WASM assets, but the actual frontend build fails because its recorded entry hash differs from the final JavaScript file written by Vite. The emitted files and raw failure are preserved for diagnosis. No native quit timing run has started, and the production deadline is unchanged. The R1 restart failure-recovery fixture is source-ready and under independent review; its actual application run remains pending.

A further M97 audit identifies the missing labeled offline retrieval baseline as separate implementation work, rather than treating a repeated broker capture as additional outcome coverage. No milestone is complete.


## 2026-10-25 connector ownership repair accepted; native fixtures still under verification

The [selected connector ownership GREEN checkpoint](../../acceptance/2026-10-25-connectors/ownership-root-green/ROOT-CHECKPOINT.md) is independently accepted. The repaired shared ownership checks, frontend/registry/policy suites, strict default Clippy and both corrected Rust compatibility controls pass. It retains 271 original records as 208 content-addressed artifacts, including prior failures and the exact reviewed source chain. This closes the bounded ownership repair, not M96's credential/provider/action integration.

The quit fixture's frontend bundle now passes its actual build, final-file hash and export checks. Independent review verified 460 local inputs, five emitted assets and both WASM source joins. A subsequent native compilation exposed duplicate Tauri macro names in fixture wrappers; a reviewed fixture-only rename preserves the production IPC names. Native-feature compilation then passed, as did 87 focused supervised-agent checks and the generated quit wire-name regression.

Strict native Clippy found one equivalent Boolean simplification in the R1 fixture; the one-line correction is registered and its check is running. The existing IPC contract suite passed 53 of 55 tests and exposed an outdated dedicated-fixture audit. Its successor must explicitly audit the closed quit fixture module, two wire aliases and typed probe while preserving production rename/default-feature refusals. No native quit timing or actual R1 recovery run has started.

M97's offline labeled retrieval design and missing-contract test packet passed independent source review; its actual tests and production retrieval capture remain pending. Synthetic relevance labels are still proposed/disputed, and no retrieval or answer-quality score is claimed.


## 2026-10-25 native build passes; quit control needs diagnosis

The combined native fixture now builds, and strict native Clippy passes. Independent review accepted the one-line restart-fixture lint correction as behaviorally equivalent. The earlier 87 supervised-job checks and one quit wire-name check retain their original source identity; fresh application restart acceptance has not run.

The first disposable process-ownership control returned a failure: it did not establish the required child report between TERM and KILL. Its final leader reap and process-absence observations passed. The raw failure is preserved, and independent diagnosis is checking the timestamp comparison before any retry. The second control and app-level quit timing cases have not run. This is a test-prerequisite failure, not evidence that the application's quit deadline is defective. No milestone is complete.


## 2026-10-25 restart execution and next product implementation

The full IPC contract now passes 84 checks, with typechecking, scoped lint and formatting also passing. The same native build passed 41 delegation/deadline/grant controls, a fresh healthy restart, and one deliberately damaged child-history recovery scenario. The latter records a child-recovery refusal, preserved protected child records and successful ordinary-parent recovery. Independent raw review remains pending; this does not prove the other failure profiles, Stop/shutdown races or backend isolation. A root wrapper stopped after the successful 22-case grant run because it expected a field that the existing runner does not emit. That observation is preserved separately; only the unstarted restart checks were continued.

The quit supervisor's clock correction passed 53 pure checks and source review. Its two fresh disposable process controls completed successfully and are awaiting raw acceptance. The earlier rejected control remains rejected. No app-level quit timing acceptance is claimed.

The next connector and retrieval tests are now registered. Typechecking passes; the combined suites retain all 84 existing passes and show 15 expected initial failures: three absent public credential commands and twelve unimplemented retrieval parser/evaluator contracts. Native search controls and actual fixture routing are being compiled next. The retrieval evaluator is under implementation. These development failures are not a passing aggregate gate.

The wider UI composition, conversation retention and workflow format/limits/retention choices remain pending. The recovery journal's approved policy continues to exclude protected mail. No milestone is complete, no public supervised execution has been enabled, and no current vault has been converted.


## Native restart review and quit startup boundary — 2026-10-25

The refreshed M95 native controls and two restart scenarios passed independent raw-evidence review. The [damaged-child checkpoint](../../acceptance/2026-10-25-agents/owned-child-claim/restart-damaged-child/ROOT-CHECKPOINT.md) preserves the 41 controls, healthy R0 and fixed all-markers R1 observations with their original source/build identities. Other protection-marker combinations, the next restart profile, actual Stop/shutdown and backend isolation remain open.

M93's first eight fixed native quit cases all stopped before application bootstrap: the supervisor wrote its audit file into a directory that the native fixture correctly requires to be empty. No quit timing or dialog acceptance follows from those attempts. A separate empty fixture directory inside the outer evidence directory is being prepared and reviewed; the Rust startup guard and production quit deadline remain unchanged. The eight unsuccessful attempts remain recorded.


The M93 startup repair passed 65 focused checks, fresh owned-process controls and independent source/raw review. One rebuilt native failed-owner case started and exercised retained-draft cancellation and survival successfully. Its aggregate result remains rejected because both subsequent cleanup signal requests returned errno 1; later qualified absence does not prove delivery. [Native startup checkpoint](../../acceptance/2026-10-25-reliability/native-quit-startup/ROOT-CHECKPOINT.md). Further native cases remain pending an explicit cleanup/acceptance-contract review; no production deadline change or broader reliability claim follows.


## M94 owner approval — 2026-10-25

The owner selected **“Use the refined treatment”** for the remaining collection and utility surfaces. The [decision record](../specs/2026-10-25-m94-refined-composition-decision.md) clears UX-04’s visual-choice gate. Wider adoption can proceed using the existing shared roles and Pages reference; actual checks and native acceptance are still required.


## M96 public credential bridge — 2026-10-25

The three production credential commands now preserve authenticated ownership through Pending, background execution, cancellation and terminal polling. Independent source and actual-evidence review accepted the bounded bridge: 176 frontend/contract checks, 52 account tests (including eight handoff cases), 17 admission tests and 65 native profile cases. Both default and native-feature strict Clippy passed. The [portable checkpoint](../../acceptance/2026-10-25-connectors/public-credential-bridge/ROOT-CHECKPOINT.md) retains the original identities and raw evidence.

Production work still settles as Failed/Unavailable. Real credential capture, Keychain storage, usable connections, enabled Import, effects and managed MCP routing remain open. No milestone is complete.


## M94 wider adoption and M95 recovery prerequisite — 2026-10-25

The owner-approved composition is now applied to Knowledge, Agents, My work,
Library and Settings. The pre-change baseline passed 20 Chromium/WebKit cases
and retained all 100 expected screenshots across two themes and five host widths.
Independent evidence review verified the exact image identities, stable inputs
and owned-process cleanup. The registered candidate passes typechecking, scoped
lint/formatting and all 138 focused component tests. Its dedicated Settings stage
passes all six browser cases, including drawer focus and draft retention.

The separate utilities stage remains **failed: 16 passed, 8 failed**. All eight
failures occur in WebKit when sequential Tab traversal returns to a native button;
the corresponding Chromium cases, My work and compact Settings cases pass.
The failed checks stop at the first host width, so their later screenshots and
activation assertions are not credited. A reversible observation probe will compare
implicit and explicit tab participation before any correction. Save-port assertions
prove draft retention, not successful persistence. No broader UI acceptance follows.

M95's next chat-recovery prerequisite passed independent design review. It will
inspect one existing native root and its recorded action outcomes through an
authenticated, bounded, read-only snapshot. Account changes suppress sensitive
details; broker inventory, conversation-generation coverage and external effects
remain distinct. Three missing-public-contract assertions have now failed as
expected. An initial isolated test fixture could not load a symlinked demo file;
that setup failure is preserved, and only its two unreached wrapper tests were
replayed with copied fixtures. Implementation is underway; this does not enable
safe resend, Edit question, supervised jobs or conversation-body retention.

M97's first native retrieval capture contains 12 synthetic queries with zero
observed scope leaks, but relevance labels remain 36 proposed and one disputed,
with none accepted. The report is provisional and has no accepted quality
score or model-answer evidence. Two strict Rust integration errors and a missing
required inventory path have reviewed fixes; the changed quit runner passes 72
pure checks and fresh, independently reviewed two-control process qualification.
Application timing and successor compilation/capture evidence remain separate.

## Native restart, retrieval and UI diagnostic checkpoint — 2026-10-25

The [closed-session restart checkpoint](../../acceptance/2026-10-25-reliability/restart-closed-session/ROOT-CHECKPOINT.md)
passes independent source and raw-evidence review. The original process closes its real session before its retained child
exits; a fresh opening recovers that child before the ordinary parent while
preserving the old session. The bounded profile passed 63 independent comparisons.
Resumed CLI admission, normal Stop/quit and public supervised execution remain open.

M97's successor build passes strict default and native-feature Clippy, six native
retrieval controls and the fresh retrieval capture. Independent review accepts
the implementation evidence. The twelve-query report remains provisional: none
of the relevance labels are accepted, and no answer-quality claim follows.

The UI diagnostic collected both browser observations, but its aggregate validator
rejected the My work control because focusing the row changes its roving tab index.
The four affected WebKit actions each record missed Tab focus with the original
attribute, successful focus with explicit `tabindex="0"`, then missed focus again
after restoration. Those individual observations await review; the original
eight browser failures remain unresolved. No browser preference was changed.

Two further native quit cases exercised pending-owner and late-unresolved draft
retention, with failed aggregate cleanup results retained separately. The next
case stopped before frontend readiness: Rust serialized `late-ipc150`, while the
closed frontend contract requires `late-ipc-150`. Further cases are paused for
an exhaustive case-name regression and the smallest fixture correction. This
does not change the production quit deadline. No milestone is complete.

The four measured UI actions now explicitly participate in sequential keyboard
navigation. Independent source review accepted the four call-site additions;
typechecking, scoped lint and formatting pass. The shared Button defaults and
browser assertions are unchanged. Fresh full browser acceptance is still pending.

The native case-name regression executed all six new checks: three passed and
three failed specifically on the two numeric Serde names. The reviewed correction
adds only those two explicit names. Its seven-test verification and fresh fixture
build are underway; the failed application attempt remains failed.

The isolated M95 recovery reader passes production compilation. Review found
that history validation must preserve the existing target-identity limits.
The first regression attempt could not compile because a fixture called a private
runtime helper; this is a test setup failure, not the intended validation failure.
Both the fixture repair and the validation correction remain open.

## UI visual review and recovery validation — 2026-10-25

The corrected utilities stage passes all 24 Chromium/WebKit cases. Independent
review verifies all 104 screenshots: 100 exact baseline pairs across five
surfaces, two themes and five widths, plus four compact Settings results. Source
and dependency snapshots remained stable, and qualified cleanup passed. The
earlier eight focus failures and failed diagnostic aggregate remain preserved.

Rendered-image review found two issues beyond those assertions: Library changes
from three columns to two when the pane grows from 959 to 960 pixels, and the
new Knowledge inset clips primary status text at 360 pixels. These block visual
acceptance of this slice and are being corrected. Existing narrow Agents run
history clipping is also recorded for remaining M94 polish. Passing browser
checks do not establish complete visual or native accessibility acceptance.

The isolated M95 history reader now passes all six target-validation regression
probes, preserving existing identity bounds and rejecting empty/control-bearing
target text before it can become a masked reference. Authoritative Rust schema
and digest export and TypeScript generation pass. The broader actions group
passed 225 tests and exposed one overly strong output-budget test: the approved
design permits a bounded prefix when the complete response budget is exhausted,
while that test required every reference. The correction preserves the separate
guarantee for an individually oversized details object and changes no product
budget. Full integration checks and independent acceptance remain open; no safe
resend, supervised execution or conversation retention has been enabled.

The native quit case-name correction passes seven focused tests, strict native
Clippy and a fresh build. The next actual late-IPC case reached the correct
fixture but failed its timing path: the first phase exceeded its budget before
cleanup-created draft restoration. The result remains failed. A bounded fixture
measurement redesign uses the real native timer and prompt cleanup/restoration
before measuring late cancellation; production deadlines, phase budgets and
quit decisions remain unchanged. No subsequent native timing case has run.

The independently accepted [retrieval baseline checkpoint](../../acceptance/2026-10-25-knowledge/retrieval-baseline/ROOT-CHECKPOINT.md)
now retains the implementation, actual native capture and review as portable
evidence. Its twelve-query report is still provisional, with no accepted relevance
labels or model-answer score. No M93–M99 milestone is complete.

The isolated M95 recovery-reader correction has now passed independent scoped
review. Its final covering run passes 226 actions tests, with four deliberately
ignored cases, strict Rust Clippy and Rust formatting. The accompanying checks
pass 123 frontend contract tests, 18 native-admission tests, three runtime tests,
generated-contract validation and full TypeScript checking. These are isolated
source checks; registration waits for the current UI verification to finish.
Full-repository lint and formatting still report existing failures, retained in
the evidence, and are not treated as passing. This accepts neither safe resend
nor supervised execution, OS behavior or complete M95 delivery.

M93's revised late-cancellation measurement has meaningful failing tests before
implementation: all three frontend cases expose missing restored drafts, and
15 Python validation cases reject missing checks through 51 assertion failures.
The 72 existing Python checks, two positive controls and aggregate control pass.
The native timer-observation interface still requires implementation and review;
no further application timing case has run.

M94's two visual corrections passed independent source review and are now
registered: Library retains two columns across the 959/960 boundary, and the
Knowledge layout reserves room for its primary status label. Those are the
intended behaviors; fresh unit, browser and rendered-image verification remains
the acceptance gate. The original browser passes and visual failures stay
separate in the retained record.
## Narrow-layout correction and native measurement — 2026-10-25

M94's second correction passes typechecking, scoped lint/formatting and 43
component checks. Its fresh browser run remains **failed: 28 passed, four
failed**, with 114 of 120 expected images retained. All original cases and the
Library-focused cases pass. The four Knowledge failures require positive native
horizontal movement without establishing available overflow or focus. Chromium
finishes Concepts and fails Review; WebKit fails Concepts. Independent evidence
review preserves that distinction and verifies stable inputs and owned cleanup.
A two-case observation will establish the actual focus, overflow and row-key
behavior before the test contract changes.

Root inspection supports the Library column correction in the checked light
Chromium and dark WebKit pairs. It also finds a new Knowledge regression: status
labels fit at 360 pixels but ordinary titles fragment across too many lines.
The approved correction keeps the title floor and places status below the title
when the measured side-by-side budget cannot fit. Product implementation and
full rendered acceptance remain open; the failed run is not waived.

M93's measurement frontend and Python validator pass their 3 and 90 checks. A
reviewed counter-ownership adjustment also passes scoped lint. The native
observer prerequisite compiles and executes five probes: two state/isolation
controls pass, and three fail specifically because producer hooks are absent.
The required hooks are next. This does not establish real timer-thread or
application timing acceptance; the changed runner and native bundle still need
fresh qualification.

M96's selected-account capture correction passed independent source review. It
removes the extra account probe, requires `--no-refresh`, and checks provider
identity before reservation or storage. The first actual build found two stale
four-counter expectations in a retained-owner test after the fixture moved to
three stages. That setup failure is retained and is under correction; no GREEN
test result or usable credential connection is claimed. The production worker
remains unavailable.

The focused Knowledge observation collected both browser cases successfully.
Review has no horizontal overflow in either browser, while Down moves focus to
the real first row in both views. The observation also confirms ordinary title
words breaking across multiple lines. It supports correcting the test's
unconditional scrolling assumption and proceeding with stacked status rows;
it does not explain or clear the earlier WebKit failure. Library's 959/960
column correction now has full-size visual support in both browsers and themes.

The M96 compile correction passes independent scoped review and 102 distinct
checks, including all nine new selected-capture probes and eight handoff
controls. An initial zero-match module filter earned no coverage; compiled
discovery selected the remaining tests without repeating completed checks.
The combined native-feature build and strict lint remain separate gates.


### Continued integration checks — 2026-10-25

M93’s native observer hooks pass 16 feature-gated and 10 default shell tests. Default strict Clippy passes. Feature strict Clippy still reports the three observer API items that the native fixture has not consumed yet; the next integration implements that consumer without suppressing these diagnostics. No current native application or actual deadline-arm acceptance is claimed.

The reviewed tooling corrections pass 409 lint-rule checks, 11 existing quit-build contract checks and scoped lint. They leave the captured frontend and six byte-owned JSON contracts unchanged. The deferred build import and three frontend formatting files still prevent a full-gate completion claim.

M94’s third narrow-Knowledge correction has passed independent source review. Only its browser assertion is registered for a focused failure-first check; the reviewed stacked-row product candidate remains pending that observation and fresh browser/visual verification.

M94’s focused failure-first browser run reproduced the cramped-title defect: Onboarding wrapped across three lines, Warehouse across two, and proposal text clipped. Its report decoder separately failed because Playwright serializes its two error fields differently; that aggregate failure is retained. Root and independent raw review accepted only the causal assertion evidence and verified unchanged inputs and owned cleanup. The reviewed stacked-row correction is now registered. Full typechecking, scoped lint/format and 14 existing Concept Table/cursor tests pass. Fresh 32-case browser and visual acceptance remain pending.

M93’s next fixture boundary compiled successfully and produced the intended two wire assertion failures; its Python classifier suite produced the intended two vocabulary failures, with the other 91 checks passing. These are development prerequisites, not native quit acceptance. M96’s private capture transport design is approved for a test-only implementation; actual subprocess, installed CLI, provider and Keychain acceptance remain separate.

M94’s third correction now passes all 32 browser cases. Independent review joins
120 screenshots, 100 original baseline pairs, eight readability bodies and stable
inputs with qualified owned-process cleanup. Root inspected 24 current images,
including all focused Knowledge views and all eight changed non-Knowledge images;
84 other non-Knowledge images match the prior capture byte-for-byte. Primary
title words remain intact at 360 px, and Library retains two columns across
959/960 px. The UI capture hold is released. The narrow Open action, Activity
tab clipping and Agents run-history metadata remain explicit polish work.

The reviewed 26-file M95 historical inspection reader is registered. Its prior
isolated acceptance remains distinct from the current combined integration run.
That run also checks M93’s narrow classifier update and three deliberately failing
native regression probes, plus M96’s inert private-output scaffold and ten
failure-first tests. None launches the actual application, a credential child,
a provider request or a Keychain operation. M96 review requires two additional
cleanup/help-parser test cases before its implementation can be accepted.

The combined feature build passed. M93's three expected decoder/legacy-wire
assertions failed while its other 12 tests passed; M96's ten new contract tests
failed at their intended first assertions against the inert implementation.
The original authors are implementing these bounded contracts. The filtered
native actions group passed 229 tests (four intentionally ignored), admission
passed 18, and the runtime invocation group passed three. A prior zero-match
filter remains recorded and earns no coverage. Generated drift checking and
full app/tools/engine typechecking pass. The frontend group is 122 passed and
one failed: its strict M93 fixture audit requires the exact newly approved wire
shapes, with all adversarial checks retained. The combined gate remains open.

The three frontend files previously held for capture are now formatted and pass
scoped lint/format checks. These changes only wrap existing test source and add
formatter-required punctuation; behavioral tests were not repeated for them.
The native build import remains deferred until the next reviewed bundle build.


## 2026-10-26 implementation continuation

The owner instructed implementation to continue on the shared branch. Root and
three source-only agents resumed disjoint chat, credential, backup and workflow
slices. Generated evidence remains ignored; no staging, commit or current-vault
conversion is part of this continuation.

The workflow format and conservative limits are now implementation defaults for
disabled definitions. This does not select the proposed completed-content
retention period. The corresponding decision packet records that distinction.

Initial causal tests compiled successfully and ran against deliberate missing
behavior: M95 generation admission had 11 failures and one existing transaction
guard pass; M96 selected credential orchestration had seven failures, then ten
with additional guards; M98 definition validation had seven failures and one
negative-control pass. Two separately executed M99 opening/output tests reproduced
the lost prior-scope and reserved-output races. These are RED evidence, not final
quality gates. GREEN implementation and integration review are ongoing. No
milestone has been marked complete.

### Focused integration and independent review

The native credential bundle compiles offline with its existing cached dependencies.
Its fixed HTTPS reader passes six transport checks, including pending-future
cancellation and deadline disposal; four retained-owner checks cover cancellation,
supersession and owner retirement. No installed account, provider or Keychain was
contacted by these checks. The actual late-registration fixture releases its prior
live registration before asserting the cancelled-attempt refusal; duplicate live
registrations still refuse.

Native chat generation checks pass 15 runtime, seven owner-admission and two
interaction-link tests. The added Stop-after-deferral case passes after repairing
the cancellation classification; an already completed response remains complete.
Frontend logical request ownership and the full unresolved-effect integration are
still being connected.

Workflow definitions pass 14 checks, including exact decimal preservation, future
format refusal, control-flow availability and one sealed representation for
semantically identical values. The file store's original 15 checks pass; independent
review then found an interrupted hard-link installation and a future publication
pointer decoding defect. Both now have regression candidates; earlier passing
counts do not close those findings. The pure mapping interpreter is in its
failure-first implementation phase.

The backup opening review reproduced three worker-lifetime failures and three
opening/alias/binding failures, while 15 other opening cases passed. Corrections
must join actual workers and preserve original opening identity. A further
client-session settlement review is required before any Backups UI is enabled.
Three initially mis-scoped Rust test filters matched zero tests; compiled inventory
identified the correct scopes, and those zero-match runs earn no coverage.


### Accepted focused corrections — 2026-10-26

M94 missing embedded-database repair now passes 35 component checks and four
browser journeys (Chromium/WebKit, light/dark). All eight captured images were
inspected. Keyboard cancellation returns focus and writes nothing; choosing the
replacement saves once, preserves the original editor, and survives Back. The
separate native-control theme defect is under failure-first browser validation.

M95 logical-generation UI handles observed acknowledgements without fabricating
a process, keeps transient observations out of saved transcripts, and preserves
the accepted request key. Review reproduced same-tick vault-retirement and stale
start ownership races. Both corrections pass the 173-test hook/job group. Six
affected IPC/mock fixture files pass 819 tests after explicitly narrowing the new
result variant. Full app/tools/engine typechecking, scoped lint and formatting
pass. This does not establish live CLI isolation or close the public-job gate.

M98 definition validation now passes 15 tests, the file store 17 and the mapping
interpreter seven. Independent optional-output review found no blocking issue.
The V43 durable workflow kernel's initial run is one transaction-guard pass and
21 expected failures at unimplemented admission; implementation continues. That
RED run is not counted as functioning workflow persistence.

M99 opening/alias/native-binding corrections pass 20 opening tests; actual
watcher, ambient, reader and failed-join controls also pass. All five new client
settlement checks pass, covering closed in-flight sessions, pending settlement,
worker panic and lock contention. The checked-input/admitted-restore boundary
is the next prerequisite to the native backup coordinator. No current vault was
converted and no Backups feature has been declared complete.


## Action and backup integration — 2026-10-26

The fixed GitHub issue adapter now preserves the complete supported preview and
request body, binds every compiled definition field, validates exact numeric
identities, and accepts success only for the expected issue/repository and output
schema. Its 17 checks pass after 16 causal failures against the inert boundary.
The earlier nine-case run remains eight failures and one negative control pass.
Normal production `cargo check --offline --lib` passes; two warnings were then
corrected and await their next production replay. Actual HTTP dispatch and native
account/grant authority are separate integration gates; these checks did not
contact GitHub, use credentials or invoke Keychain.

Native restore consumes the held original backup input and output reservation.
It refuses an otherwise valid replacement input root and same-byte replacement
manifest. All six admitted-restore tests and both checked-input tests pass,
including the check-time replacement race reproduced before the fix. The shared
policy anchor passes, as do 41 existing portable-backup regression cases. Partial
output retains its preparing boundary on error, and successful restore remains
inactive. The native workflow book, commands and UI are still being integrated;
these results do not authorize converting the current vault.

The native-control theme journey passes in Chromium and WebKit after correcting
BlockNote's inherited native control color scheme. The editor and source remain
stable across light/dark/light changes. Root inspection of the selected and mixed
captures confirmed legible controls but found a separate unchecked keyboard-focus
opacity defect; its browser regression and minimal focus treatment are underway.
The two passing theme cases are not a claim of complete keyboard acceptance.

The runtime review reproduced two actual workflow defects: unresolved values in
an earlier store incarnation were omitted from the same vault's capacity budget,
and a newly issued ACT approval could remain behind an expired continuation.
The corrections are registered and are being verified with the 24-case runtime
suite. Shared ACT transaction tests and native backup workflow tests are also
registered. Their first combined compile attempt failed before tests ran because
of an opaque-type reexport and a nested visibility scope; those compile defects
were corrected without making capability constructors public. No behavioral pass
or causal failure is inferred from that failed compile.


The follow-up keyboard journey now passes in both browsers. Its first combined
run was Chromium pass/WebKit failure because plain Tab did not traverse the
button in the macOS WebKit configuration. The corrected test uses macOS WebKit's
[documented Option-Tab traversal](https://support.apple.com/guide/safari/keyboard-shortcuts-and-gestures-cpsh003/mac),
retains the same focus/visibility assertions, and passes both engines. Root
inspected the new row/header focus captures in both themes. Scoped lint and the
complete app/tools/engine TypeScript check also pass. The product correction is
only focus visibility for the existing unchecked row and header controls.

The 24-case workflow runtime suite passes after both capacity/approval fixes.
The shared ACT prepare/answer kernel passes all five new transaction/shared-path
checks, 30 existing approval checks, 13 bounded recovery checks, and 44 contract
checks (two explicit regeneration cases remain ignored). Process-stop and live
child-process recovery cases were excluded from this focused replay and are not
covered by that count. The production compile then exposed a remaining test gate
on the row-storage module; the repair promotes only connection-borrowing row
helpers and keeps path/submission-owner constructors test-only. Its production
replay passes in both v19 and v20 without warnings.

The GitHub semantic/request/framing/future suite passes 30 checks. Independent
review nevertheless found that an outer reqwest future's disposal does not prove
its HTTP driver or blocking DNS task has ended. Actual Tokio child-work tests
first reproduced both lifecycle failures. The correction gives each retained
native worker its own current-thread runtime and drops that runtime, including
real blocking work, before releasing its lease. All 32 focused checks now pass;
request timeout and physical cleanup remain distinct. Normal production checking
also passes. Native dispatch integration remains unfinished.

The native backup book passes its first 18 lifecycle cases. An additional root
review test reproduced a chooser opening after its registration retired between
scheduling and callback entry; the pre-callback liveness correction is registered
and all 19 cases pass in v19. Actual output publication facts and the native
command/UI composition remain separate from those lifecycle tests.

The v23 replay passes all 26 real ACT/FLOW linkage cases, including the 14 output
receipt cases. Normalized output is retained only for an explicitly registered
workflow consumer, charged against its existing reservation, then transferred or
discarded in the same transaction as acknowledgement and cursor/budget changes.
Missing output can be recovered at the actual unchanged ACT revision only with
the authenticated receipt. Ordinary chat success creates no output archive.
The shared claim and observation paths preserve the existing 30 approval and 13
bounded recovery cases; all 25 native account/grant binding fixtures also pass
after sharing their checked-binding calculation with production code. The 44
action contract cases pass, with two deliberate regeneration cases ignored.

All 15 new backup output-fact cases pass, including creation before a later
failure, original-directory replacement, publication followed by unwind, and a
poisoned location observer. The native worker/command/UI integration remains open.
The normal production build passes. The v23 test build still reports unused
integration/test-seam warnings; this is not a clean full lint/clippy gate.

The 32-case workflow core replay at v23 is **29 pass / 3 fail**: the older test
fixture installed only V43 and omitted the V44 table now required by terminal
cleanup. Its setup now uses the actual migration chain; that replay is pending.
The new sequential runner/request tests reproduced **27 causal failures and two
passing controls** before implementation. Five shared cancellation tests likewise
reproduced four causal failures and one passing transaction guard; their shared
implementation is registered for the next replay. None of these focused results
closes a milestone or substitutes for the remaining native and consumer journeys.

The v24 replay closes the fixture and shared-cancellation follow-ups: all 32
workflow core cases and all 16 shared prepare/answer/claim/cancel cases pass,
alongside 13 bounded recovery cases. The existing portable-backup suite also
passes all 41 cases against the v23 build. Six new retained-native transaction
and physical-lease tests reproduced their expected failures before implementation;
their implementation is now registered for verification. Production checking at
v24 succeeds with one unused import from that temporary native test boundary;
native action dispatch and the remaining user journeys are still unfinished.

The v25 retained-native replay passes all six transaction and physical-lease
cases, four original-runtime controls and two commit-outcome controls. The three
action-storage migration checks, 30 approval checks and 13 bounded recovery
checks also pass; normal production checking is clean. These checks cover the
retained storage bridge. They do not yet cover native action dispatch, account
cancellation hooks or the lock-directory replacement case under review.

The v26 sequential runner passes all 25 cases and the original ACT request
codec passes all four. The 32 workflow core cases, 26 ACT/FLOW linkage cases and
six retained-native owner cases also pass. Four new control-registration tests
reproduce the missing action cancellation behavior. Production checking passes;
the recovery review has separately added five original-attempt identity cases,
and the physical owner review adds a real lock-directory replacement case. Those
new cases are registered for the next replay, not included in the passing counts.

The [M97.7 retrieval label review](../specs/2026-10-26-m97-retrieval-label-review.md)
accepts 37 synthetic judgments for source relevance, with explicit ambiguity and
reliability limits. This is independent agent review, not human approval or a
quality score. A fresh native capture and scored offline baseline remain next.

That [reviewed baseline](../specs/2026-10-26-m97-reviewed-retrieval-baseline.md) is
now recorded at v28: 12 actual native queries, six passing native controls and
115 passing harness tests. Scope leakage is zero. Paraphrase, accent and
beyond-cap queries miss their eligible source; the cutoff query returns 20 of
25 relevant sources. No model quality or overall release threshold is inferred.

The v28 integration tests reproduce the specific remaining repairs: workflow
runner 25 pass / 5 identity-recovery failures; cancellation controls 4 pass / 2
failures (poisoned raw flags and reusable Stop-all); retained owner 6 pass / 3
failures (directory replacement, lock-file replacement and nested transaction);
account hooks 2 controls pass / 3 missing commit notifications; fixed backup
copy 1 conservative control pass / 14 summary/disposition failures. The existing
19 backup lifecycle cases pass. Production checking succeeds with seven
integration warnings; these results do not constitute a clean full gate.


The v30 replay closes those specific repairs: retained-owner 9/9, cancellation
6/6, committed-account hooks 5/5, sequential runner 30/30 and fixed backup copy
15/15 pass. The broader account-import fixture passes 52/52; workflow core
32/32, ACT/FLOW linkage 26/26, shared effect kernel 16/16, approval 30/30,
bounded recovery 13/13, output progress 15/15 and portable backup 41/41 also
pass. Normal production checking is clean. The preceding v29 compile exposed
an unqualified injected Tauri type; the root fixed that compiler error and
removed one confirmed unused import before v30.

Two new native-workflow integration slices remain intentionally red at v30:
the same-transaction ACT bridge has two passing controls and five causal
missing-implementation failures; durable workflow-origin rows have three
passing controls and 17 causal failures. Both use the actual migration chain.
The V46 physical namespace/file pins are preserved beside the new V47 tables;
no current vault or live account was converted or exercised. The ACT bridge
implementation is now registered for its first green replay. Native dispatch,
workflow activation, backup commands and their user journeys remain open.


The v34 search replay passes all 53 search cases, including seven conservative
Latin-accent cases, plus four source-location cases. The direct RED had one
passing control and five missing accent-match failures. Three native captures
of the unchanged baseline are retained; the complete labeled comparison and
post-change timing acceptance remain pending. This is not a semantic-search or
paraphrase-quality claim.

The backup DTO work exposed two real schema generation incompatibilities and an
enum-field naming mismatch. The corrected Rust declarations now export through
the unchanged shared generator: v35 passes three actual wire/schema parity cases
covering eight affected variants. The Settings backup controller, presentation
host and component are integrated with the eight IPC wrappers. Its save barrier
first reproduced ten causal failures and two passing controls; the completed
frontend slice now passes 55 focused controller, Settings and App checks, the
full TypeScript check and scoped lint. Native picker/command acceptance remains
separate; browser preview reports that it cannot create files.

The v36 native replay passes all 47 original/current workflow-admission and
physical-ownership cases, eight original-action settlement cases, nine retained
native-owner cases, 16 shared effect cases, 32 workflow-core cases and seven
ACT bridge cases. The new terminal bookkeeping cases correctly reproduce three
missing native terminal outcomes. Six producer/revocation cases instead failed
in fixture setup: their temporary directory was not canonical, which the actual
RuntimeOwner correctly refuses. The fixture spelling is corrected without
weakening that guard; their causal replay remains next. Four immutable-definition
facade cases reproduce its missing implementation. Production checking succeeds
with unfinished integration warnings; this is not a clean full release gate.

The genuinely held chat-action frontend reproduces 14 new causal failures while
all 171 existing cases and its new late-answer control pass. The repairs must
acknowledge the original waiting call, preserve its stream and task, stop the
original process, and keep missing tool correlation explicit. A resumed CLI run
cannot stand in for acknowledgement. Native book/transport, workflow producer,
backup native commands and complete consumer journeys are still in progress.

## Integrated checks and remaining causal repairs — 2026-10-26

The v41 native build and normal production check pass. Native backup coordinator
26/26 and borrowed original selection ticket 2/2 pass. Its frontend preview
passes two browser journeys, each exercising both themes, in Chromium and
WebKit; all four keyboard-focus captures were inspected. The isolated test
server used demo content and wrote no native backup. Earlier browser-start
failures were local-port sandbox restrictions, retained separately. Actual
packaged chooser and output acceptance remain open.

Workflow immutable-definition 7/7, existing file store 17/17, core 32/32, runner
30/30 and ACT linkage 26/26 pass. The native producer/terminal group passes its
original 56 cases, while two new known-created status cases reproduce loss of a
committed run identity after later admission failure. The v42 repair passes all
59 cases; four new actual ACT receipt cases reach the intentionally unavailable
historical projection and fail there. Their fixture successfully prepares,
approves, claims and records the original effect before that missing seam.

The held-native book passes its original twelve cases and reproduces four new
lifecycle/Answering failures. The original interaction suite remains 74 pass /
one source-ownership audit failure; it is not reported as green. The frontend
v4 replay passes 448 of 449 cases: only native in-flight answer restoration
fails. Both unexpected-resume regressions and all 117 IPC contract checks pass.
The accompanying TypeScript check exposes a new union-narrowing defect, now
corrected together with restoration for its next replay.

Selected-storage search reproduces eight causal failures with five passing
controls: complete body source evidence, YAML-looking body handling, exact
tagged metadata, relocation and unpaired-body refusal. Its replacement read
projection is in progress. These failures do not authorize migration or claim
that all consumers can use the selected authority.

The [Latin-accent experiment](../specs/2026-10-26-m97-latin-accent-retrieval-experiment.md)
now passes its measured gate: one recovered eligible source, unchanged previous
result order, zero scope leaks and 3.17% median local query-time increase.
Six current native controls and 115 harness checks also pass. No live answer
quality or whole-milestone completion is inferred.

The v38–v40 attempts failed compilation before behavior ran (test-probe
visibility, private error import and root's incomplete qualification). Those
failures remain recorded; v41 uses the corrected qualified owner paths without
widening native authority constructors.


## Original-run access and selected reads — 2026-10-26

The v44 native replay closes the held-book lifecycle repairs: 16 managed-book
and 75 original interaction cases pass. Historical workflow receipts pass all
63 origin cases and 26 ACT/FLOW linkage cases. Selected search and source reads
pass 14 cases, including a legacy parent trying to read a selected workspace
nested beneath it; 38 baseline selected-reader cases also pass. The unrelated
broader paired-write/recovery run hit its 120-second deadline and remains
incomplete. The source-location inventory was corrected to exclude its explicit
regeneration test; the same-binary follow-up passes its four behavior cases.

The credential import UI passes 396 focused controller, Settings, IPC and lab
checks, full TypeScript checking and scoped lint. A browser review found a
narrow Cancel-button overflow despite the first journey passing. The added
bounds assertion fails in both engines before the repair and passes afterward:
two Chromium/WebKit journeys cover five states and both themes, with no native
credential access. The changed narrow and unavailable captures were inspected
in both engines. Native Keychain/chooser/provider acceptance remains separate.

Rust now exports the per-run action-access and workflow command contracts
through the existing TypeScript generator. Both contract parity checks, three
additional workflow transport cases and generation checking pass. The new
access controller reproduces ten missing-behavior failures before its repair;
all ten then pass alongside 13 credential checks and full TypeScript checking.
It retains exact-input grants, binds decisions to the original run/request and
requires explicit reload and review after an uncertain response. Mounted access
sheet and genuine held-request integration are still being verified.

The v46 native check reaches the new seams without fixture failures: workflow
origin 72 has 64 pass/eight causal driver failures; native grant ten has one
control pass/nine causal failures; selected semantic 31 has one control
pass/30 causal failures; catalog 23 has its original 17 pass/six causal failures.
Production checking succeeds with unfinished integration warnings. Their
implementations are being integrated. Review additionally found a cross-run
prepared-step substitution gap; two real two-run regressions are registered
before accepting that driver. The v45 and v47 builds stop at compiler errors,
so neither supplies behavioral evidence.


## Workflow controls, chat access and selected checklists - 2026-10-26

The v54 native replay passes workflow origin/control/timer 80, worker lifecycle
5, document publication 8, managed waiting-call ownership 26, original
interactions 75, event ownership 3, native grants 10, effect settlement 12,
shared effect kernel 16, workflow linkage 26, core 32 and wire 5. Normal
production checking also passes. These repairs preserve the original held
approval through edits, keep active cancellation tied to its recorded effect,
select the current timer attempt, and reject publication overflow before writing.
They do not establish packaged native or provider acceptance.

Selected semantic readers pass 37 focused cases. The checklist native CAS
passes five cases plus two general-editor winner/external-body controls. The
frontend v5 replay passes 482 of 484 cases, including selected task reads and
writes, full-version expectations, retained recovery choices, legacy task
controls, and the mounted chat access sheet. The two remaining failures are
the eight new workflow command facades without production UI consumers; that
Library integration is in progress. Full TypeScript checking passes. Closing
and reopening access during a save retains one original pending request;
unknown acknowledgements require explicit reload and review.

The v55 replay reaches the next missing integrations with real fixtures:
workflow file-command results have three controls passing and two known-write
acknowledgement failures; workflow views have one transaction control passing
and six missing-reader failures; exact MCP call cancellation has two negative
controls passing and six missing-registration failures. Its eight MCP cases use
owned temporary scripted children with the existing reap path, no credentials
or provider calls. Existing native grants 10 and document 8 still pass, and
production checking succeeds. These causal failures remain open until their
successor implementations pass.

All M93-M99 milestones remain open. Native quit/performance and accessibility
acceptance, full supervised CLI execution, managed connector dispatch, workflow
editor/runtime scheduling, broader selected-storage write consumers and
activation still need completion. No current vault has been converted. Raw
verification output remains ignored; this record is the portable summary.

## Managed access and workflow integration — 2026-10-26

Native v56 passes shared effect kernel 16, managed waiting-call ownership 26,
workflow file commands 5, scoped workflow views 7, exact MCP cancellation 8,
native grants 10 and workflow documents 8, plus production checking. The file
command repair preserves a known successful write even when a later source read
is unavailable. The scoped views distinguish missing active values from terminal
details that were deliberately not retained.

The per-run access preview passes once in Chromium and once in WebKit, with no
skips or retries. It checks all five states, both themes, narrow controls, focus,
explicit selection, reload and close/reopen retention. Twelve captures were
produced; representative ready, partial and unavailable states were inspected in
both engines. These use isolated preview data and make no native/provider claim.

Native v57 establishes the next route gaps: existing grant controls pass eleven
of twelve cases, with the per-action account-binding test failing at the inert
reader. The early tool-list test fails because managed names are not registered;
the actual original-run admission control correctly refuses before native
installation. All nine workflow document cases pass, including exact JSON
whitespace/token behavior, and production checking passes.

Frontend selected checklist/error feedback passes all fifteen checks, and full
TypeScript checking passes. The title regressions reach the missing selected
reader/writer; the owner comparison tests have sixteen controls passing and one
missing transition. Workflow editor checks pass seven with one acknowledgement
failure for outer JSON whitespace. The successor preserves local text and exact
numeric tokens; its replay is pending. Four retained-editor tests expose three
capacity/clean-release failures, with dirty remount retention passing. Library
authoring remains under integration, not an accepted workflow journey.


## Draft recovery, title editing and original request ownership — 2026-10-26

The combined title/editor/Library group passes 151 tests. This closes the selected
inline-title branch, unfinished-title retention, IME Enter and grid focus, exact
workflow JSON acknowledgement, bounded draft owners, clean release and reopening
an unsaved workflow without requiring a native file. Five targeted workflow lab
presets also pass; this was a filtered run, not the complete lab suite. Full
TypeScript checking passes at this checkpoint.

The workflow authoring preview passes in Chromium and WebKit with no retries or
skips. It exercises all five read states, both themes, a measured 360-pixel content
pane, explicit Save/Validate/Publish, exact numeric JSON text and local draft
resume. Preview calls do not write the mock vault or run a native workflow. The
first browser attempts incorrectly left a 46-pixel pane beside lab navigation;
the corrected fixture reserves the lab frame and asserts the actual content width.
Representative captures were inspected. They also exposed a clipped selected tab
at narrow width; a separate visibility regression is now being repaired.

Native v59 and v60 compile and pass production checking. Both pass shared effect
kernel 16, managed waiting-call ownership 26, exact MCP cancellation 8, current
grants 12, workflow file commands 5, scoped views 7 and workflow documents 9.
The four original-prepare ownership checks now pass: an existing awaiting, ready
or submitted request is observation only and cannot acquire another cancellation
or dispatch owner. Public route response ownership is still being checked.

The native Continue regression reproduces a stale revision between the initial
read and physical admission; its exact-revision control passes. The repair repeats
the revision check inside the retained admission transaction. The next integration
build, v61, stops at two compiler errors (an unavailable UUID dependency and an
incorrect existing DTO path); neither supplies behavioral evidence. Precise fixes
reuse the repository's existing UUID mint and action type.

The combined managed-editor/runtime frontend run passes 78 of 88 checks. All 42
managed approval/form checks pass, including eight newly authored numeric cases
that previously rounded or discarded text. The opt-in guard refuses unsupported
numbers before conversion and preserves them for correction. The ten remaining
failures are intentional runtime integration regressions: six missing panel
behaviors, two definite input-refusal states and two lost-uncertainty retention
cases. Their repairs remain under verification. TypeScript checking passes for
that source checkpoint.

The real quit coordinator also now distinguishes an observed departure from an
expired wait: unconfirmed ordinary quit stays in the app; the explicit Quit anyway
choice remains. Its 17 tests pass inside the 244-test integration group. This
separate repair does not waive the outstanding native quit timing result.

The selected metadata request kernel and explicit schema4 staging are in progress.
The original 22 native metadata cases establish the missing behavior, including
no-op receipts, lost responses and old pending evidence; additional declaration
body and bounded-history probes are registered. No current vault was converted.
All M93–M99 milestones remain open; these bounded results do not substitute for
native/provider, scheduling, migration, accessibility or aggregate acceptance.
