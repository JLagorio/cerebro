---
type: Work item
key: SYN-7
status: progress
priority: urgent
assignee: "[[sam-ito]]"
due: 2026-08-04
estimate: L
epic: "[[epic-offline-conflict-model]]"
blocked_by:
  - "[[syn-6]]"
---

# Hold both versions instead of discarding

Storage side of [[dec-conflict-resolution-is-manual]]. Both versions live until someone picks; neither is authoritative in the meantime.

The migration is the awkward part — existing rows have no concept of a losing version, so the schema change has to tolerate a null second side forever.
