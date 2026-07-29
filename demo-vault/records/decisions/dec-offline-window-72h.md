---
type: Decision
status: accepted
decided: 2026-06-28
deciders:
  - "[[tom-keller]]"
  - "[[sam-ito]]"
affects:
  - "[[offline-sync-hardening]]"
---

# Offline window is 72 hours, not indefinite

## Context

Crews asked for "works offline" without a bound. An unbounded window means unbounded local state, and conflict probability that climbs with the age of the divergence.

## Decision

Guarantee 72 hours. Past that, the app keeps accepting work but warns that resolution may need a human, and stops promising a clean merge.

## Consequences

Covers a long weekend plus a day, which is the real field pattern. Rural multi-week deployments are explicitly out of scope, and sales needs to stop implying otherwise.
