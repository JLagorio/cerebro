---
type: Decision
status: accepted
decided: 2026-07-21
deciders:
  - "[[marcus-webb]]"
  - "[[elena-vasquez]]"
affects:
  - "[[phoenix-warehouse-rollout]]"
---

# No custom scanner hardware

## Context

The scanner vendor's lead time put [[risk-scanner-delivery]] on the critical path. Building our own sled was floated as a way around it.

## Decision

Use the phone camera as the fallback path and keep the vendor scanners as an optimisation, not a dependency.

## Consequences

Slower scanning per item, which the warehouse team will feel on day one. It takes hardware off the critical path entirely, which is worth more than the seconds.
