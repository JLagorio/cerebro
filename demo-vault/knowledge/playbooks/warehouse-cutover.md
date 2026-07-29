---
type: Playbook
title: "Warehouse cutover: go-live and rollback"
description: What to run, in what order, on Phoenix warehouse go-live night.
tags: [operations, phoenix]
lifecycle: draft
generated: { by: claude-code/2.0, at: 2026-07-28T09:05:00Z }
sources:
  - id: ops-project
    resource: /projects/phoenix-warehouse-rollout/project.md
    title: Phoenix warehouse rollout
    author: human:tom-keller
    last_modified: 2026-07-26
  - id: kickoff
    resource: /projects/phoenix-warehouse-rollout/meetings/kickoff.md
    title: Phoenix warehouse rollout kickoff
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

Rollback is the same list in reverse, but step 2 is the one that bites: the
pick queue does not drain instantly, and cutting DNS with work still in
flight strands it in neither system.[^kickoff]

> **Nobody has rehearsed this rollback.** It was raised after standup and is
> not yet a work item on the project.[^ops-project] Treat the sequence below
> as untested until someone runs it in staging.

[^ops-project]: Phoenix warehouse rollout
[^kickoff]: Phoenix warehouse rollout kickoff
