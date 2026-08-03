---
type: Risk
status: open
severity: critical
owner: "[[marcus-webb]]"
affects: "[[obj-field-app-readiness]]"
mitigation: "Run the full rollback against the staging warehouse before the go-live date locks."
---

# Warehouse rollback has never been rehearsed

We have a cutover plan and a written rollback. Nobody has executed the rollback end to end.

The step that worries me is draining the pick queue: it does not drain instantly, and cutting DNS with work still in flight strands it in neither system. That is the one failure we could not talk our way out of on the night.
