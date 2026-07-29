---
type: Playbook
title: "Warehouse cutover: go-live and rollback"
description: What to run, in what order, on Phoenix warehouse go-live night.
about:
  - "[[phoenix-warehouse-rollout]]"
  - "[[risk-rollback-unrehearsed]]"
tags: [operations, phoenix]
lifecycle: draft
generated: { by: claude-code, at: 2026-07-28T09:05:00Z }
sources:
  - id: ops-project
    resource: /projects/phoenix-warehouse-rollout/project.md
    title: Phoenix warehouse rollout
    author: human:marcus-webb
    last_modified: 2026-07-26
  - id: risk-rollback
    resource: /records/risks/risk-rollback-unrehearsed.md
    title: Warehouse rollback has never been rehearsed
---

# Trigger

Go-live night for the Phoenix warehouse, or any decision to abort mid-cutover.

# Sequence

1. Freeze inbound receiving in the legacy system.
2. Drain the in-flight pick queue and confirm it reads zero.
3. Cut DNS for the warehouse endpoints.
4. Run the smoke set against the new stack.
5. Unfreeze receiving.

# Rollback

Rollback is the same list in reverse, but step 2 is the one that bites: the pick queue does not drain instantly, and cutting DNS with work still in flight strands it in neither system.

> **Nobody has rehearsed this.**[^risk-rollback] Treat the sequence as
> untested until [[ops-9]] is done.

# Scanning

Hardware is deliberately not on the critical path — the camera fallback is the assumed path on night one.

[^ops-project]: Phoenix warehouse rollout
[^risk-rollback]: Warehouse rollback has never been rehearsed
