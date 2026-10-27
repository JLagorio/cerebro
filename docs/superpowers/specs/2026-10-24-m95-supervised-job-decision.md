# M95.6 — Supervised job limits decision

Status: owner approved implementation on 2026-10-24. Not enabled.

The [implementation plan](../plans/2026-10-23-m95-chat-and-supervised-agents.md)
requires: “Owner approves limits and read-only first release; record
desktop-awake scope.” This decision is separate from the existing foreground
researcher and the pending conversation-retention decision.

## Approved first release

| Setting | Approved behavior |
| --- | --- |
| Scope | Read-only work within the parent's current readable scope |
| Delegation depth | One level; a child cannot start another child |
| Concurrency | At most two running children per parent session |
| Admission | At most eight children per parent session; retries cannot reset the allowance |
| Deadline | Ten minutes per child, including time waiting for a decision |
| Result | At most 256 KiB of validated structured output |
| Execution | Desktop awake only; no cloud worker or automatic detached/background continuation |
| Parent Stop | Stop queued work, request cancellation of running children, retain completed results |
| Restart | Mark abandoned claims interrupted; never automatically repeat effects |
| Access | Separate scoped run/session; no parent connector secrets, raw connector route or broader Agent-page grant |

The implementation must prove backend enforcement of scoped MCP credentials,
parent-token noninheritance, raw connector denial, shell/filesystem bypass denial
and required decision suspension. Prompt instructions alone do not satisfy this
boundary. If the installed CLI cannot enforce it, supervised jobs remain
unavailable with a clear explanation; existing foreground researcher behavior
remains governed by its existing policy.

Approving this proposal authorizes implementation and the disposable capability
checks. It does not authorize provider mutations, access outside existing grants,
background execution, real account import or new durable conversation retention.
Raw prompts, reasoning and credential values are not added to the job record.
Result-body retention follows the separately chosen conversation policy; until
that choice exists, durable result-body admission remains closed.

## Alternatives

- **Use the proposed read-only limits:** implement the table and keep execution
  disabled until the independent capability checks pass.
- **Defer supervised jobs:** finish the existing foreground researcher experience
  and leave the Rust-owned child-job mode unavailable for this release.

Owner answer, 2026-10-24: **“Implement these read-only limits (Recommended).”**
This authorizes implementation of the table and disposable capability checks.
It does not establish backend isolation or enable jobs. The conversation-retention
choice remains separate and pending.
