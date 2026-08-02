---
type: Metric
title: Sync error rate
description: Failed sync operations as a share of all sync attempts, per hour.
about:
  - "[[offline-sync-hardening]]"
  - "[[kr-sync-error-rate]]"
tags: [reliability, offline-sync]
lifecycle: stable
stale_after: 2026-07-26
generated: { by: claude-code, at: 2026-07-19T16:40:00Z }
sources:
  - id: syn-project
    resource: /records/projects/offline-sync-hardening.md
    title: Offline sync hardening
    author: human:tom-keller
    last_modified: 2026-07-23
  - id: dec-manual
    resource: /records/decisions/dec-conflict-resolution-is-manual.md
    title: "Decision: conflicts are resolved by a person"
  - id: sync-logs
    resource: all sync telemetry in the eu-west region
    usage_count: 42000
    usage_window: { from: 2026-07-01, to: 2026-07-25 }
---

# Definition

`failed_syncs / total_sync_attempts`, bucketed hourly. A sync counts as failed when it exhausts its retries, not on the first error.[^syn-project]

# This number is about to get worse on purpose

[[epic-offline-conflict-model]] surfaces conflicts that are currently resolved silently and discarded.[^dec-manual] When it ships, measured errors will **rise** while the underlying reliability improves.

Anyone reading this KR through the transition needs that context, or the improvement reads as a regression.

# Known distortion

The nightly batch window inflates the denominator between 02:00 and 04:00, so the hourly rate looks artificially healthy overnight.[^sync-logs] Compare like-for-like hours when reading a trend.

[^syn-project]: Offline sync hardening
[^dec-manual]: Decision — conflicts are resolved by a person
[^sync-logs]: Sync telemetry, eu-west
