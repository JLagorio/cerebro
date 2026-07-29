---
type: Decision
status: accepted
decided: 2026-07-14
deciders:
  - "[[tom-keller]]"
  - "[[elena-vasquez]]"
affects:
  - "[[offline-sync-hardening]]"
---

# Conflicts are resolved by a person, not a rule

## Context

Two crews editing the same job offline produce two valid histories. We can merge automatically, pick a winner by timestamp, or ask someone.

Automatic merge was attractive until we listed the fields: job status, parts used, and signature capture cannot be merged without inventing facts.

## Decision

Detect the conflict, hold both versions, and put the choice in front of the crew lead with the two versions side by side. No automatic resolution for the three unmergeable fields.

## Consequences

Slower for the user in the rare case, and honest in every case. It also means the sync error rate metric will *rise* when this ships, because conflicts that were silently discarded now surface. Everyone reading that KR needs to know that, or the improvement will look like a regression.
