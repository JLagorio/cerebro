# MCP expansion: compatibility before breadth

Research checkpoint: 2026-10-22. This document supplements the local repository
reviews with current official protocol documentation. It proposes work; it changes
neither Cerebro's protocol nor its permissions. The local CLI and example servers
were not exercised. Protocol support must be measured per installed client and
server, not inferred from the date of a specification.

## What Cerebro currently exposes

[mcp.rs](../../../../src-tauri/src/mcp.rs), line 68, declares `2025-06-18`.
Its protocol dispatch around lines 1464–1500 handles `initialize`, `ping`,
`tools/list` and `tools/call`; initialization advertises tools. This is a specific
tools-oriented server contract, not evidence of a general resources/prompts host.
The optional [external-client listener](../../../../src-tauri/src/client_access.rs)
uses personal tokens and distinct client runs. Separately,
[connectors.rs](../../../../src-tauri/src/connectors.rs) configures third-party
MCP servers for Claude Code. Outgoing capability support therefore also depends
on that executable. Changing the in-process server does not upgrade the CLI's
outbound client.

## What changed in the protocol

The official `2026-07-28` revision uses self-contained requests and per-request
capabilities. Its changelog removes the old initialization exchange and
transport-level sessions, adds `server/discover`, and changes results and
subscriptions. This is a compatibility boundary, not a version string to replace
in the current server. See the [specification](https://modelcontextprotocol.io/specification/2026-07-28)
and [official changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog).

The release announcement described Rust SDK support as beta at publication. That
is a dated observation, not a statement about the SDK's exact state at
implementation time. Select a pinned SDK only after checking its protocol and
transport coverage against Cerebro's actual compatibility suite. The same
announcement explains the change from transport sessions to explicit application
handles. Cerebro should preserve its own run identity independently of either
wire model. [Official release announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/).

The Tasks extension supplies durable handles, polling, input requests and
cooperative cancellation. Both ends must support it; an ordinary tool invocation
does not become durable because Cerebro displays a progress row. Store a remote
task handle before depending on it after restart, and preserve uncertainty when a
cancel request cannot establish whether the remote effect stopped.
[Official Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview).

MCP Apps combine tool results with UI resources and a host-mediated communication
channel. The documented web model uses sandboxed iframes, resource CSP, and
capability control. A reusable AI component library is not an MCP Apps host.
[Official MCP Apps overview](https://modelcontextprotocol.io/extensions/apps/overview).

These protocol observations should not become a demand to implement every
extension. The `2026-07-28` changelog also deprecates Roots, Sampling and Logging
for new implementations and moves Tasks out of the experimental core. A roadmap
that simply copies a 2025 feature checklist would already be stale. Retain older
behavior only where tested interoperability requires it, behind an explicit
adapter. [Official changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog).

## Proposed compatibility contract

Keep application authorization, job identity and evidence independent of wire
versions. For each connection, record server identity, supported protocol,
transport, catalog revision, authenticated account, and explicitly supported
features. Present a simple status to the person: ready, sign-in required,
unsupported feature, unavailable, or disabled. Put wire details in diagnostics.

The first expansion should supply a tested Rust outbound client boundary with
tools, resources and prompts. Resources become selectable context with actual
read receipts; prompts become inspectable starting instructions, not a route to
new permissions. A server-provided tool description or effect annotation is input
to local classification, not authorization. Dynamic lists must be scoped to the
same account and grant that will execute the call. Changed schemas invalidate
stale forms and approval previews.

For inbound MCP, retain compatibility with the current CLI while adding a
separately tested modern adapter where useful. Route both through the same domain
operations and guards. Keep personal-token access local unless a separate remote
deployment and authentication design is selected. Do not broaden a loopback token
into a general internet credential as a side effect of adding connectors.

The compatibility matrix is an implementation deliverable, not a claim that these
rows pass today:

| Path                   | First proof required                                                                      | Unsupported behavior                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Current CLI → Cerebro  | Existing recorded tools, approval, cancellation and replay suite on the pinned executable | Explicit protocol/capability error; retain supported old adapter             |
| External app → Cerebro | Per-client token scope, expiry/revocation, catalog and call parity                        | Refuse unsupported methods without representing an empty catalog             |
| Cerebro → stdio MCP    | Child lifecycle, bounded output, catalog revision, credentials and disconnect             | Show disconnected/unavailable; do not silently inherit another configuration |
| Cerebro → HTTP MCP     | Negotiation, account-bound auth, schema validation and reconnection                       | Sign-in/compatibility state; no blind mutation retry                         |
| Remote Tasks           | Durable handle recovery, input continuation, timeout and cancellation uncertainty         | Use synchronous semantics only where the call actually supports them         |
| MCP Apps               | Frame isolation, allowed resource origins, mediated tool calls, focus and navigation      | Show structured/text fallback with a useful explanation                      |

## Rich connector results inside chat

Start with Cerebro-owned renderers for schema-checked tables, files, references and
proposals. They provide a coherent keyboard and accessibility contract while the
runtime is being established. Then prove one MCP App in the packaged Tauri build.
Its frame must not receive Tauri IPC access, vault filesystem access, application
storage, or connector credentials. Every app-triggered action goes through the
same action resolver, grants, approval binding and effect record as a chat call.

Reconcile the frame with Cerebro's existing entry-document navigation guard and
external-link policy; do not weaken the global guard to make an embedded demo
work. Test a keyboard user entering and leaving the frame, an app asking for an
unavailable action, a refreshed resource, a dead connection, and restoration of
the conversation when the UI resource is no longer available. Preserve the
underlying result independently of the transient interactive view.

## Acceptance and sequencing

1. Inventory the current installed CLI and three representative servers: a local
   read-only server, authenticated remote read/write service, and asynchronous
   service. Record actual versions and unsupported features.
2. Pin the adapter and normalize its outputs into Cerebro's application types.
   Add fixtures for catalog changes, errors, malformed results, interruption,
   pagination, auth renewal and cross-account isolation.
3. Demonstrate a resource read and a tool action through the same account,
   context and effect surfaces. A resource denied by scope must not leak through
   catalog caches, completion suggestions or source previews.
4. Add Tasks only after the durable action state machine exists. Add MCP Apps
   only after host mediation and packaged frame isolation are proven.

The product goal is that the person can connect a service, understand its usable
capabilities and complete a recoverable task. Protocol coverage is evidence for
that journey, not a substitute for it.
