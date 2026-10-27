# M95.3 — Conversation retention decision

Status: approved for implementation by the owner on 2026-10-26.
Implementation of M93–M99 is authorized, but this document does not enable an
archive, import a conversation, or change the current vault's settings.

[Plan](../plans/2026-10-23-m95-chat-and-supervised-agents.md) ·
[Design](2026-10-23-m95-chat-and-supervised-agents-design.md) ·
[Implementation record](../plans/2026-10-23-m93-m99-implementation-record.md).

## Proposed product behavior

Add an optional local conversation archive, owned by Rust and stored outside the
vault in the operational database. Offer Off, 30 days, 90 days and Forever per
vault, with **90 days recommended and a 256 MiB content budget**. Existing
installations remain off until the person explicitly selects a duration. A new
vault also needs a choice; merely opening it does not enable retention.

The selection in this decision authorizes building that behavior. It does not
enable an archive for the owner's current vault or import existing conversations.
Those are explicit settings actions in the completed product.

| Choice | Exact behavior |
| --- | --- |
| Content | Keep the human-visible question and ordered answer blocks, bounded tool-state and child summaries, titles, identity/branch references, and source/effect/artifact references. Questions, answers and quoted sources may contain sensitive text. |
| Exclusions | Exclude reasoning, raw tool input/output, full child traces, credentials, assembled system/outgoing prompts and M92's memory-only context-token readings. Existing CLI-owned session files remain separate. |
| Duration | Each completed message expires from its own completion timestamp. Viewing or continuing a thread does not renew its older messages. Forever has no age expiry. |
| Budget | Stop admitting new completed content when the 256 MiB logical content budget is full. Report archive unavailable; retain admitted, unexpired content. Do not silently evict it or report an unsaved answer as archived. |
| Switch to Off | Stop new completed-content admission. Keep existing archived content under the duration recorded when it was admitted; Forever content stays until explicit deletion. Offer a separate, clearly named delete action. |
| Import | Offer an explicit, one-time import of validated browser-cached records associated with the selected registered vault. Keep stable IDs and verify durable readback before clearing imported cached bodies. Unknown-vault records remain cached with an explanation. Do not backfill whole CLI sessions. |
| Delete | Refuse deletion while generation, a child job or a pending approval owns the thread. Offer separate Stop/resolve controls; retry Delete after settlement. Deletion does not itself stop work or cancel an external effect. |
| Expiry/delete transaction | Remove retained content, titles/previews and search rows together. Retain only the minimal independent operational facts needed to explain unresolved effects; do not infer that deleting a chat reverses an action. |
| Export | Offer JSON or Markdown through a native save dialog. Label partial, expired or unavailable portions accurately. A user-owned export has its own lifetime and is not removed by archive expiry. |
| Physical cleanup | Report logical deletion separately from SQLite checkpoint/cleanup. WAL/free pages, snapshots, backups, exports and CLI-owned sessions can outlive logical deletion. No secure-erasure promise. |

Off preserves the active run's existing recovery and approval essentials until
settlement. It does not authorize a new durable copy of completed chat bodies.
Archive content is operational, not knowledge: it does not enter the vault corpus,
distiller or verification ledger merely because it was retained.

## Current behavior and what changes

The current browser cache keeps up to 30 thread records and bounded message
previews. Storage pressure can remove old bodies; it is not a durable archive.
Per-thread unsent composer drafts are stored separately. CLI session files are
the existing reconstruction source when they are available. Current thread
deletion stops a run and removes the cached thread, without deleting CLI-owned
sessions. M95.3 must update CV-30 and its tests when the gated archive deletion
behavior ships.

The archive writer must run from Rust settlement, independent of whether the
conversation panel is mounted. Live attach identities, pending approvals and
unsent drafts retain their existing owners. A resumed held call is part of the
same attempt until terminal settlement; one answer must not be archived twice.

The owner's M99 SQLite workspace choice does not decide chat retention. That
choice's initial workspace backup explicitly excludes chat/run/action history
and the app-private recovery journal. This archive remains separately exportable.

## Acceptance required before enabling the feature

Fake-clock tests cover the exact 30/90-day boundaries, Off during settlement,
Forever at capacity and old completed messages inside an active thread. Tests
must also cover duplicate settlement, deletion racing a live owner, a late write
after a tombstone, partial import, readback failure, unknown-vault cache records,
busy SQLite readers, cleanup failure, and cancelled exports. Browser tests keep
the same assistant draft, approval and scroll through thread/layout changes and
show archive failure as unavailable.

On 2026-10-26 the owner selected **“Implement the opt-in archive”** for this
proposal: per-vault Off/30/90 days/Forever, a 256 MiB cap, explicit delete/export,
and no reasoning or raw tool payloads. The current vault remains Off. This
authorizes implementation; import and a retention duration still require explicit
in-product choices.
