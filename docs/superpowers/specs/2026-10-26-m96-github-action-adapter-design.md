# M96 — GitHub action adapter integration

Continuation of the approved M96.4–M96.6 design, 2026-10-26. The first provider
remains issue read and reviewed issue creation on github.com. This implementation
does not authorize a live mutation or make an imported account a grant.

The existing compiled definitions own input/output schemas and effect classes.
A private Rust adapter accepts only the exact compiled definition, validates raw
JSON through the existing exact-decimal parser, and derives the request and
conflict target from those validated values. Repository names are ASCII path
components, normalized to lowercase for both the URL and the conflict identity.
Caller URLs, query strings, transport headers and business retry keys are absent.
The preview shows repository, title and full supported Markdown body before a
create approval. Editing that input follows the existing approval revision rules.

`shared/actions/github-transport.v1.json` fixes protocol/version, operation mapping,
response bounds and proven rejection statuses. Rust reads it; the UI does not
implement a second interpreter. The native HTTPS adapter must disable redirects,
automatic retries, proxies and decompression, use the retained selected-account
secret only, and keep its request future owned until completion or disposal.

Only a complete bounded response with the expected status, JSON representation,
exact issue identity, matching repository/number and valid output schema proves
success. Duplicate JSON keys, oversized or truncated bodies, target drift, a
redirect, server error or lost response leave an already submitted effect unknown.
Documented rejection statuses prove no creation and never trigger an automatic
retry. Pull-request results from the issue endpoint are unsupported in this beta.
An explicit null issue body means no Markdown body; an absent body is malformed.

GitHub documents issue creation status 201, rejection statuses 400/403/404/410/422,
and status 503; the read endpoint uses 200 and documents redirects. Its issue
endpoint can also return pull requests. These facts were checked against the
[official issue API reference](https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28).
The adapter retains the existing 2022-11-28 API-version pin.

Implementation order:

1. Exercise the actual request/preview/response adapter with fixture bytes,
   including dropped-response and changed-target cases; no real credentials.
2. Extract the existing durable action mutations into transaction-owned kernels,
   shared by their current tests and the native retained RuntimeOwner. A kernel
   cannot open a second connection or commit its caller's transaction.
3. Authenticate original window/run/publication before prepare, person decisions
   and dispatch. Recheck account/grant/definition inside the claim transaction.
   Only a known committed dispatch claim may reach the owned provider worker;
   uncertain commit never submits. Preserve minimal unresolved-effect fences.
4. Register the manifest-derived MCP routes and attended controls on that same
   service, then verify command/chat/workflow journeys and native account setup.

The native owner and broker remain the authority. A successful adapter fixture is
not provider interoperability, a person approval, or permission to enable a route.


## Native HTTPS transport continuation

The semantic adapter now passes its 17 focused cases. Its private native child
will consume only a checked `IssuePlan` and a Rust `SecretValue`. The transport
constructs the fixed API request directly; neither the renderer nor an MCP
caller can supply a URL, proxy, TLS trust root, header, retry policy or backend.
Creation sends the same complete title/body represented by the approval preview.
Authorization is marked sensitive and temporary authorization bytes are cleared.

A single owned request future uses HTTPS, rustls with the existing platform trust
store, TLS 1.2 minimum, HTTP/1, no redirects, proxy, retries, decompression or idle
connection pool. Its bounded timeout and header/body limits are compiled policy.
The dispatcher retains the invocation lease until this future is dropped or
settled. Cancellation or an already elapsed deadline before the first poll sends nothing.
After a request may have started, interruption before a complete validated
observation yields outcome unknown. A complete validated success or documented
not-applied result remains that observed fact when cancellation/deadline races
in its final poll; the identity reader's post-poll cancellation override must not
be copied here. Neither interruption grants retry.
No detached request task is introduced. Exact successful response framing must
be established before the semantic adapter can accept a provider result.

Validation starts with no-I/O tests of the actual request builder, representation
and size boundaries, and future ownership across cancellation/deadline races.
They use fake secret bytes and never call GitHub or Keychain. Normal production
compilation is separate from the test build. Native dispatch remains disabled
until the shared ACT transaction kernel and native owner revalidation are wired.


## Physical request cleanup

Pinned reqwest/hyper source review found that dropping the outer request does not
join its spawned HTTP/1 driver or a started blocking resolver. The shared Tauri
runtime therefore cannot establish this worker's physical completion. The
retained native worker must own a dedicated current-thread Tokio runtime, create
the client inside it, and explicitly drop that runtime before returning or
releasing its submission lease. Its blocking pool is limited to one; no
shutdown timeout or background shutdown is allowed. Cancellation/deadline still
produces the conservative semantic outcome described above, but cleanup remains
pending until actual blocking work ends. Two deterministic regressions use real
Tokio async and blocking children with controlled channels; no DNS or provider
access is needed to verify this distinction. Native worker admission bounds the
number of such runtimes, and no renderer input can select the runtime or limits.


## Retained native mutation bridge

The next production bridge extends the retained action-read owner, not the
path-based fixture service. Main-window authentication happens before authority
locks. The bridge then verifies the original agent/MCP publication, opening
reservation, store identity and runtime lineage under their existing guards.
`RuntimeOwner` owns the one Immediate transaction and its known-committed,
not-committed or uncertain-commit classification. A borrowed mutation context
uses that same connection for current catalog, account, snapshot, grant and
revocation checks. Scope views remain selectors rather than new capabilities.

The current fixture authority's checked-binding calculation should be shared
with this context, preserving exact definition/account/input-scope/snapshot
checks. Its caller must first establish real native lineage. Catalog execution
remains unavailable until the retained dispatcher, secret resolution and outcome
storage are wired together; enabling an enum flag alone is insufficient.

Prepare and answer return their durable identities only after a known commit.
Dispatch must retain the real submission owner, commit the attempt, then invoke
the fixed provider exactly once outside the transaction. A committed refusal
must remain a committed domain result rather than being converted into a
transaction rollback. An uncertain commit never permits submission. Observation
stores a completed external fact without requiring newly valid grants; revocation
cannot erase an effect that already occurred. Cancellation records intent and
keeps the physical worker/lease until its owned runtime cleanup has ended.

The first live implementation scope is the existing attended desktop run.
Children, external MCP clients and workflows require their already specified
origin-bound authority adapters; they cannot borrow the attended run's proof.
The new managed MCP actions must use the shared tool manifest and the same
kernel, previews and approval journal, with generated finite IPC/DTO contracts.
No renderer path, credential value, actor flag or model-supplied approval can
construct any of these authorities.


## Original attended managed call composition

Managed MCP tools now have one shared-manifest schema and the real original-run
producer. Only an actual matched bearer/publication plus the installed retained
native origin may enter a tools/call. Tool names and schemas are inert metadata:
the original attended root may cache them during CLI startup before native origin
installation finishes. An early call still refuses; clients, children and
unattended/internal runs do not inherit this route. Listing names discloses no
account, input, credential or action authority. Every normal tool/scope admission
check still runs before the private native handler.

list_actions may hold its original call while the person chooses access in the
This run sheet. Its finite result is {catalog, bindings}; every binding explicitly
pairs actionId/definitionDigest with a currently eligible granted connectionId,
accountId and label in the same retained snapshot. No ungranted account or hidden
exact-input body is returned, and no action/account cross-product may be inferred.
An explicit empty Done returns the actual empty catalog and approves no effect.

prepare_action retains raw JSON input text and one stable original request key.
A read uses its explicit current run grant. A mutation holds the original call,
shows a full native safe preview and accepts a person decision only through the
injected main-window answer command. A known committed acknowledgement carries
only the exact interaction id; it never resumes, creates or attaches a CLI run.
An edited approval retires the old lease and requires a second explicit approval
of the new complete preview. Card rotation keeps the same original RPC control.
The version1 managed_action card.input view contains accountLabel, preview,
compiled inputSchema text and canonical input text. It uses shared action byte
and preview limits and the existing book input cap. Oversize is unavailable,
never truncated. The existing schema-driven form may edit only values it can
preserve exactly; unchanged canonical text is never converted through JS numbers.

Every managed request, including reads with no approval card, owns one private
bounded cancellation registration for its exact actual receipt and real JSON-RPC
request id. Cancellation notifications use the same matched-source check and
cannot target another publication or request. The original deadline and flag stay
owned through Keychain resolution, the one shared fixed HTTPS worker, physical
runtime cleanup, original-fact settlement and response disposal. No control entry
is reclaimed merely because its deadline passed. No read card, tool id, run
handle, person proof or action capability is fabricated for this control.

A prepared request retains a known-committed original capsule. Stop or lost source
can cancel that exact original request under its retained runtime/store/native
and immutable action binding, without opening a replacement database or granting
new execution authority. A real busy submission lease records intent and proves
no provider outcome. Submitted facts still settle under the existing original
claim capsule after current permissions or the original CLI have ended.

The single observation algorithm returns its already validated canonical output
transiently after the owning known commit. The original held caller gets output
only after a separate fresh original disclosure check. Available output is
{state:available,json:<canonical JSON text>}; missing/lost output is explicitly
unavailable, never a synthesized null or an empty success. Chat creates no durable
body cache; registered FLOW output handoffs keep their existing same-transaction
retention, transfer/discard and acknowledgement contracts. These source/fixture
checks do not claim a live provider mutation or completed native app acceptance.

A repeated logical prepare is observational only. Existing awaiting, ready or
submitted rows never mint another cancellation/dispatch capsule, register another
wait, approve a lease or start provider work. The observed response reloads the
finite current effect and reports output unavailable for that request; only new
known-committed rows acquire the original prepared owner.
