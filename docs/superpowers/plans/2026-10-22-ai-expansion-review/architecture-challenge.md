# Independent challenge: make the expansion smaller at entry and stricter at its boundaries

Reviewed 2026-10-22 against the expansion plan, the AppFlowy/n8n/Plane dossiers,
the M91 audit, the Rust/storage study, connector architecture and current source.
This is an independent source review, not runtime verification. No application
code or test changed. The working tree is moving while Claude completes M91;
source findings require reconciliation at implementation handoff.

The proposed Rust service direction is credible, but its architectural diagram
must not become the first release's scope. The largest risks are an unfinished
producer/consumer contract, multiple routes to the same external effect, an
overstated metadata cutover guarantee, and treating recorded definitions as
control over remote implementations. The recommendations below narrow those
risks without using today's files-first or CLI decisions to veto the owner's new
direction.

## Corrections identified during review

These corrections were sent to the main-plan author before this report was
completed. They are incorporated into the final roadmap or explicitly called out
there as implementation decisions; they are not additional duplicate work items.

| Review correction                                       | Why it matters                                                                                                     | Resolution in the plan                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Normalize migration estimates                           | The original main table allowed 6–12 engineer-weeks while the storage study estimated 8–14 weeks for two engineers | Use comparable engineer-week ranges and separate a prototype from production migration                 |
| Separate a narrow beta from three integration journeys  | “Minimal AX01–05” still implies several new subsystems before any task completes                                   | Start one provider and one reviewed mutation; expand into the three-slice release train                |
| Qualify existing approval persistence                   | `runtime.db` has durable operational records, but the CLI permission book is memory-only                           | Name durable pending-write/governance state separately from live permission approvals                  |
| Do not call an app lock exclusive external-file control | External editors and unrestricted CLI processes do not participate in Cerebro's lock                               | Prefer migration into a new workspace; require controlled writers or detected conflicts before cutover |
| Define title authority in the hybrid store              | Ordinary page titles currently share the body editor; a SQL title can accidentally become another writer           | Preserve first-H1 projection for ordinary pages and separately define guarded concept-title migration  |
| Separate wire retry from business retry                 | A new MCP request ID says nothing about whether an earlier mutation happened                                       | Persist a logical invocation/idempotency identity and test SDK automatic retry behavior                |
| Label mail send as later opt-in scope                   | The connector dossier originally placed send beside first slices while the main release stayed drafts-only         | Keep the initial correspondence journey draft-only; send requires its explicit later policy amendment  |

## 1. Finish M91 through its consumers, with a dated handoff

The M91 audit's most consequential claim survives direct inspection.
[The frontend reducer](../../../../src/agent/transcript.ts) handles `Text`,
`ToolStart`, `ToolDone` and `Error` without selecting a parent child; its default
branch returns the message unchanged for newer event kinds. The current
[subagent policy](../../../../shared/policy/subagents.v1.json) contains four
environment limits and a CLI version, rather than the planned researcher
definition. The [interaction book](../../../../src-tauri/src/agent/interaction.rs)
also explicitly describes live CLI acceptance still owed for some permission
behaviors.

This supports “integration incomplete at inspection,” not a conclusion that
every delegated session is visibly broken or insecure. No live reproduction was
performed. Claude may complete these seams before this document is read. The
handoff should therefore list commit/source fingerprints, completed consumers,
retained CLI recordings and outstanding native checks. Do not turn a dated audit
into a second backlog that competes with work already landing.

The smallest meaningful integration proof is a parent answer following a failed
child, with one approval, detach/re-attach and restored history. The answer, child
result and effect must remain distinct. Component count and Rust fold coverage
cannot substitute for that journey. Existing failed-save and history defects
remain independent release risks; the new transcript should not conceal them.

## 2. One broker is useful only when alternative execution routes are explicit

The connector proposal correctly introduces `execution_owner: cli | cerebro`.
Make that enforceable, not descriptive. When Cerebro owns a connection, handing
the same raw server or credentials to the CLI would permit calls outside the
invocation/approval system. A brokered tool and a directly forwarded tool with
similar names are not equivalent paths.

The same problem applies locally. [CliWrites](../../../../src-tauri/src/agent/cli_writes.rs)
documents observation of Claude Code writes that bypass Cerebro's writer doors.
Observing a changed path does not mint the missing authorization or receipt.
Moving metadata into SQLite reduces what editing a Markdown header can change;
it does not protect a database from an unrestricted same-user subprocess.

The first managed action should prove that the chosen adapter receives only its
bound account and capability. Preserve the old path as a visibly weaker
compatibility mode if needed. A future claim that every autonomous change is
guarded requires a demonstrated process/filesystem boundary, including shell
tools and children. It cannot follow from disabling only `Write` and `Edit` or
asking the model to respect a prompt.

Do not solve this by forcing all human editor commands through an agent-style
permission conversation. The shared core should unify durable domain operations;
caret movement, navigation and transient UI commands remain local presentation
behavior. Plane's command registry is evidence for contextual UI, not a reason to
persist every keypress as an action.

## 3. A frozen action definition is not a frozen external implementation

The proposed manifest should preserve what Cerebro approved: account identity,
target, normalized inputs, action schema, policy and the visible preview.
However, a third-party MCP server can change behavior without exposing an
immutable implementation version. Persisting its schema hash does not pin its
code. Published workflows therefore need two different promises: reproducible
local interpretation, and explicit compatibility checks for external execution.

Before dispatch, resolve the current catalog/account revision and reject or
re-preview material drift. Native adapters can pin their own implementation
version; arbitrary remote services may offer weaker evidence. Treat provider
annotations as claims to classify locally, never as proof that a tool is harmless
or idempotent. A custom “test connection” action cannot be called harmless merely
because the server marks it read-only.

The official [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
also changes broken-stream recovery to a new wire request. That does not establish
safe business retries. Keep the logical invocation stable across transport
attempts, verify SDK retry defaults, and test response loss after remote success.
Do not let an HTTP client or protocol adapter silently defeat the action core's
`outcome_unknown` policy.

An unresolved external effect must outlive ordinary transcript cleanup. Retain
the minimum target, operation identity, approved-input fingerprint and
reconciliation evidence needed to explain it. Deleting verbose tool output can
be reasonable; deleting the only record distinguishing an uncertain send from a
failed send changes behavior. Retention rules belong in the action contract, not
only the conversation archive settings.

## 4. Durable approval must preserve authority, not merely the card

[interaction.rs](../../../../src-tauri/src/agent/interaction.rs) describes both
one-use write approvals and an in-memory book discarded on quit. Existing
[runtime storage](../../../../src-tauri/src/runtime/mod.rs) is non-reconstructible
operational state, but it is not evidence that every current permission wait can
resume after restart. The expansion needs a deliberate new continuation contract.

Persist the approved semantic payload and target, then recheck revocation, scope,
expiry and account identity at dispatch. Distinguish token rotation from account
replacement: a routine refresh for the same validated account need not force a
new human decision, while a different account or broader target must not inherit
the old one. Define those revision semantics before building the approval UI.

One local dispatch claim prevents duplicate local ownership. It cannot prove one
remote effect. Cancellation after dispatch is intent until the provider supplies
evidence. Restoring a backup must not automatically reactivate pending authority,
old leases or scheduled sends. Keep history readable while restoring workflows
paused and requiring explicit recovery under the recorded outcome.

Independent children add another boundary. Parent grants, Agent-page maximum
grants and current account permission must intersect at execution. The child
needs its own enforceable identity if it can act independently; a nested card
and an `agent_id` field alone do not create that isolation. First prove one
foreground child with cancellation and an approval it can actually await. A
general background team is a later product.

## 5. The hybrid storage choice needs an authority table before a schema

The recommendation for SQLite metadata plus Markdown is a defensible product
bet, not a consequence of choosing Rust. It trades the completeness of a copied
folder for typed transactions, identity and application-managed recovery. The
sidecar option remains a valid competitor if independent files and Git merges
matter more. Compare both against the same real corpus rather than comparing a
finished database prototype with an abstract sidecar design.

Define authority field by field. [Page-title projection](../../../../src/editor/pageTitleProjection.ts)
keeps an ordinary first H1 in the body editor; SQL should initially project that
title rather than independently overwrite it. Guarded concept titles and
verification require their own mapping. Agent instruction bodies and versioned
grants have different update semantics. A record version must describe the
metadata/body combination actually reviewed, not whichever half was saved last.

[The parser](../../../../src-tauri/src/vault/parse.rs) already warns that some
BOM/CRLF/fence inputs do not round-trip byte-for-byte. Preserve original bytes
outside normalized conversion, and report unsupported values. Silent cleanup
during migration makes a later loss report impossible. Keep source identities and
historical verification immutable; changed serialization is not a fresh human
verification.

A migration lock coordinates Cerebro, not arbitrary editors. Prefer building a
new registered workspace from an immutable snapshot while preserving the old
one. If an in-place cutover is eventually supported, its specification must show
how writers are controlled or how races produce a conflict without overwriting
new bytes. Checking hashes once and publishing a marker later leaves a race.
Recovery also needs to cover app death between database commit and file rename;
two successful APIs do not form one transaction.

After new-format writes, rollback is a reverse migration or preservation of those
writes, not restoration of a stale snapshot. Backups must cover metadata, bodies,
attachments, ledger and necessary operational records at a coherent boundary.
A body-only Git commit cannot honestly remain a complete workspace checkpoint.
These costs should be demonstrated before production migration is scheduled.

## 6. Keep the first delivery narrower than the target architecture

A credible beta is one brokered provider, one bounded read, and one reviewed
external work-item creation from the existing chat. Use a purpose-built form,
current CLI compatibility and current transcript retention. Persist its approval,
invocation and result; prove account change, app restart, duplicate approval and
lost response. This validates the architecture's hardest boundary without
requiring a marketplace, generalized workflow editor or metadata migration.

Next, invoke that same action from one saved step with an immutable definition.
Only then expand resources/prompts, reusable mappings, durable threads and
additional providers. The three integration journeys are a release train, not a
single small increment. Mail send, MCP Apps, background workers and an additional
model backend each deserve a separately reviewable capability slice.

Use the normalized effort ranges as uncertainty bounds, not additive calendar
dates. AX00's remaining M91 work needs a fresh handoff before estimation. The
storage prototype should have an explicit stop condition: reject the selected
authority model if it cannot preserve identity, permissions, recovery and
understandable export. A justified decision to keep file authority would still be
a successful outcome of that research.

The expansion is ready to become implementation specifications when the first
provider's action contract, authority boundaries and interruption behavior are
concrete. It does not need every future subsystem to be designed or shipped
before the user can complete one useful connected task.
