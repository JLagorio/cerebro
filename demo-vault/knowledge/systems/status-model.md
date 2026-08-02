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

1. `statuses:` on the record's **own Type doc**
2. The built-in defaults

# Why a chain

Each Type owns its vocabulary — no type inherits another's statuses, so a
Type doc either declares its full set or gets the app defaults.

# Groups

Every status belongs to a group, which is what boards and rollups key off:

| Group | Meaning |
|-------|---------|
| `active` | In flight |
| `done` | Finished successfully |
| `closed` | Finished without completing |
