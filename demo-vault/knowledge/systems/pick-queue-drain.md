---
type: Reference
title: Pick queue drain time
description: How long the in-flight pick queue takes to clear, and why it gates the cutover.
about:
  - "[[phoenix-warehouse-rollout]]"
  - "[[risk-rollback-unrehearsed]]"
tags: [operations, phoenix]
lifecycle: stable
generated: { by: claude-code, at: 2026-07-28T09:26:00Z }
stale_after: 2026-08-15
sources:
  - id: standup
    resource: /inbox/phoenix-cutover-standup.md
    title: Phoenix cutover standup, 2026-07-28
    author: human:priya-nair
    last_modified: 2026-07-28
  - id: phx-421
    resource: /sources/issues/phx-421.md
    title: PHX-421 — Rehearse the warehouse rollback end to end
    last_modified: 2026-07-28
---

# The number

Draining the in-flight pick queue took **about 40 minutes in staging**, at roughly a tenth of production volume.[^standup] Plan for at least an hour; anything shorter is a guess.[^standup]

# Why it gates everything

Step 2 of the cutover is the drain. Cutting DNS while work is still in flight strands that work in neither system, and there is no documented recovery for it.[^standup][^phx-421]

That makes drain time the binding constraint on the cutover window — not the scanner hardware, which has a camera fallback and is deliberately off the critical path.[^standup]

# Status

The rehearsal that would confirm any of this is [[risk-rollback-unrehearsed]], tracked as PHX-421, which is **open and unassigned**.[^phx-421]

[^standup]: Phoenix cutover standup, 2026-07-28
[^phx-421]: PHX-421 — Rehearse the warehouse rollback end to end
