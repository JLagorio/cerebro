---
type: Metric
title: Sync error rate
description: Failed sync operations as a share of all sync attempts, per hour.
tags: [reliability, offline-sync]
lifecycle: stable
stale_after: 2026-07-26
generated: { by: claude-code/2.0, at: 2026-07-19T16:40:00Z }
sources:
  - id: syn-project
    resource: /projects/offline-sync-hardening/project.md
    title: Offline sync hardening
    author: human:tom-keller
    last_modified: 2026-07-23
  - id: sync-logs
    resource: all sync telemetry in the eu-west region
    usage_count: 42000
    usage_window: { from: 2026-07-01, to: 2026-07-25 }
---

# Definition

`failed_syncs / total_sync_attempts`, bucketed hourly. A sync counts as
failed when it exhausts its retries, not on the first error.[^syn-project]

# Known distortion

The nightly batch window inflates the denominator between 02:00 and 04:00,
so the hourly rate looks artificially healthy overnight.[^sync-logs] Compare
like-for-like hours when reading a trend.

> This concept has not been confirmed by anyone since it was written, and it
> is past its freshness date. Treat the batch-window claim as a hypothesis.
