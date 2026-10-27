# M96.1 bounded action contract

This document freezes the prototype DTO and validation decisions omitted by the
M96 plan. It implements the quoted action contract in the M96.1 execution brief.
It does not register tools, grant authority, start providers, persist invocations,
produce receipts, or implement ActionService. The Rust module is test/tool-only
until a guarded service consumer adopts it. Catalog insertion describes schema
support, not account authentication, grants, or permission to call a provider.

## Authority and transport

IDs are opaque strings. ActionSubject and PersonActionDecision remain private
Rust authority types without Deserialize, public constructors or a generated UI
type. ActionSubjectView is an inspection-only projection with vaultId, runId,
actorId, nullable childJobId/clientId. Future attended/authenticated boundaries
must derive ownership and grants as one relationship. No provider/model DTO can
mint the internal person decision. Dispatch is internal and remains absent from
public routing. Service signatures are frozen below without stub implementations.

All fields use camelCase; enums use the spec's snake_case literals. Inspection
nulls are required nullable properties, never omitted or replaced by another
account. Revision and attempt ordinal numbers use a checked u64 SafeCounter with
maximum 9007199254740991, including deserialization and increment; this retains
exact JavaScript number transport. Service expected_revision parameters remain
u64 and must be checked at the future boundary. Counters above this cap refuse;
no saturation, rollover, or float conversion is permitted.

SafeEffectPreview contains summary, ordered fields ({label, value}, both safe
strings), and redactedFields (safe field names). Adapter construction must bound
and redact these before exposure; types alone do not certify safe content.
ActionAttemptSummary contains attemptId, ordinal, state, nullable dispatchedAt,
observedAt, receiptId, remoteEffectReference and outcomeSummary. ActionEffectDetails
uses the exact spec field names; its account, target and approval objects and
all unavailable members remain explicitly nullable. Attempts are a bounded first
page; future pagination is a separately scoped read, never unscoped cursor reuse.

PrepareAction names actionId, definitionDigest, connectionId, accountId,
snapshotDigest, input and requestKey. input carries raw JSON text so decimal
precision and duplicate-key evidence survive transport until Rust validates it.
PreparedAction contains effect, preview and nullable approvalId. Catalog pages
contain descriptors, snapshotDigest and nullable nextCursor. Each descriptor has
actionId, definitionDigest and a tagged status: callable,
unsupported with reason, or unavailable with reason. No prototype method produces
a callable descriptor. The future scoped service must return callable status
only after fresh account/grant checks. Definition
views carry schema JSON text, schema digests, adapter revision, effect class,
required capabilities and retry/cancel/reconcile declarations. These are data,
not authority. Safe explanations never echo rejected input or secrets.

ActionError carries code, retryDisposition (never, refresh, reconcile), message.
ActionReadError distinguishes not_found, denied, unavailable. These prototype
codes are reserved in actions.v1.json, not registered operational ledger codes.
M96.3 must register actual emitted codes and their operational destinies before
exposing service routes. Existing closed-world/mail/send guards remain active.

## Canonical input and schema subset

The parser checks total source bytes before parsing, then depth, total nodes,
per-object key count, array length, encoded string bytes and number token bytes
before materializing each value. Decoded duplicate keys are rejected before
parsing their values. Strings use strict JSON escaping and preserve exact Unicode
scalar sequences; no NFC normalization occurs. Object keys sort by UTF-8 bytes
(equivalently Unicode scalar order); array order and omitted versus null remain
significant. JSON numbers are finite exact decimal values, never f64. Leading
coefficient zeros, trailing coefficient zeros and negative zero normalize away;
a nonzero exponent is encoded as lower-case e with a signed decimal exponent
(no plus sign). Thus 1, 1.0 and 1e0 hash identically; 1000 is 1e3. Precision is
preserved beyond JavaScript's safe integer range. Exponent magnitude and token
length are bounded. SHA-256 hashes canonical UTF-8 bytes, no implicit defaults.

The shared subset permits only type, properties, required,
additionalProperties (boolean), items, enum, const, minimum, maximum,
exclusiveMinimum, exclusiveMaximum, minLength, maxLength, minItems, maxItems,
description, title and the exact JSON Schema 2020-12 $schema URI. type is one
primitive type string. Enum and const constrain that declared type; they do not
add null to another primitive type. Nullable unions require a future subset
extension; composition and type arrays are unsupported. Unknown keywords,
all references, executable annotations, writeOnly/secret fields and malformed
keyword values are explicitly unsupported and non-callable. Secret inputs must
be transformed to approved opaque references by a future reviewed adapter;
this prototype has no secret-resolution facility. Trusted material must declare
secretInputFields; any nonempty declaration is unsupported. This does not claim
to detect arbitrary undeclared secret content. Future adapters must be reviewed
for accurate declarations and opaque reference handling. Object input permits unknown
properties only when additionalProperties is absent/true. Bounds use exact
decimal comparison and Unicode scalar string lengths.

Local effect classification is fixed in immutable definition material. Provider
annotations are ignored for classification and cannot downgrade it. All seven
effect literals are held by the shared policy artifact. No TS interpreter of
schema/classification is introduced; TS tests replay transport evidence and
check generated shape. Rust alone validates bounded input and output.

## Immutable definitions and future durable adoption

A DefinitionMaterial contains actionId, exact input/output schema bytes, adapter
revision, local effectClass, requiredCapabilities, retry, cancel, reconcile and
secretInputFields (which must be empty for this subset).
Its canonical JSON hash is definitionDigest; each schema also has a canonical
semantic digest. Changing schema bytes changes the definition digest even when
the schema's semantic digest is unchanged. Catalog keys are (actionId,digest).
Existing entries cannot be replaced. Before insertion, the complete escaped
envelope must fit its byte cap and all import parsing limits; refusal leaves the
catalog unchanged. An exported definition envelope contains
material and the complete derived definition. Import revalidates bounded schema,
recomputes all digests/derived fields, and rejects mismatches before insertion.
Tests reconstruct a fresh catalog from exported bytes. This is an import/export
contract for future durable storage, not a persistence store or restart acceptance
for real invocations.

## Service integration signatures

No implementation is provided. The eventual service must implement these exact
internal method relationships and the spec's requestKey deduplication, approval
revision checks, unresolved-effect fencing and scoped reads:

```rust
catalog(subject: ActionSubject, cursor: Option<CatalogCursor>) -> Result<ActionCatalogPage, ActionReadError>
definition(subject: ActionSubject, action_id: ActionId, definition_digest: DefinitionDigest) -> Result<ActionDefinitionView, ActionReadError>
prepare(subject: ActionSubject, request: PrepareAction) -> Result<PreparedAction, ActionError>
answer(person: PersonActionDecision) -> Result<ActionEffectRef, ActionError>
dispatch(invocation_id: InvocationId) -> Result<ActionEffectRef, ActionError>
reconcile(subject: ActionSubject, invocation_id: InvocationId, expected_revision: u64) -> Result<ActionEffectRef, ActionError>
retry(subject: ActionSubject, invocation_id: InvocationId, expected_revision: u64, decision: PersonRetryDecision) -> Result<ActionEffectRef, ActionError>
effect_ref(subject: ActionSubject, invocation_id: InvocationId) -> Result<ActionEffectRef, ActionReadError>
effect_details(subject: ActionSubject, invocation_id: InvocationId) -> Result<ActionEffectDetails, ActionReadError>
request_cancel(subject: ActionSubject, invocation_id: InvocationId, expected_revision: u64) -> Result<ActionEffectRef, ActionError>
```
