---
type: Epic
status: building
owner: "[[tom-keller]]"
target: 2026-09-12
delivers:
  - "[[kr-sync-error-rate]]"
---

# A conflict model crews can understand

Sync currently resolves conflicts last-write-wins and tells nobody. Crews discover it when a job they closed reopens.

The epic replaces silent resolution with a model that has a vocabulary: a conflict is detected, surfaced on the job, and resolved by a person with both versions in front of them. Shipping half of this is worse than shipping none — detection without a resolution UI just moves the confusion earlier.
