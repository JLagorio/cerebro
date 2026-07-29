---
type: Reference
title: How status works in this vault
description: The resolution order cerebro uses to decide a record's status set.
tags: [cerebro, schema]
lifecycle: stable
generated: { by: claude-code/2.0, at: 2026-07-25T14:20:00Z }
verified:
  - { by: human:josef, at: 2026-07-25T15:00:00Z }
---

# Resolution order

A record's available statuses are resolved by walking a chain and taking the
first set that exists:

1. `statuses:` on the owning **project.md**
2. `statuses:` on the record's **own Type doc**
3. `statuses:` on the **Work item** Type doc
4. The built-in defaults

# Why a chain

A team wants one vocabulary most of the time and a different one for a
specific project — the chain gives both without forcing every project to
redeclare the whole set.

# Groups

Every status belongs to a group, which is what boards and rollups key off:

| Group | Meaning |
|-------|---------|
| `active` | In flight |
| `done` | Finished successfully |
| `closed` | Finished without completing |
