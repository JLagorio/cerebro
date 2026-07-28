---
type: Type
icon: gauge
color: '#38BDF8'
statuses:
  - id: not-started
    group: active
    color: '#A8AFC2'
    hollow: true
  - id: on-track
    group: active
    color: '#1F9D61'
  - id: at-risk
    group: active
    color: '#DE8F0A'
  - id: off-track
    group: active
    color: '#DE3B4E'
  - id: achieved
    group: done
    color: '#1F9D61'
  - id: missed
    group: closed
    color: '#7E8699'
fields:
  status: { kind: status }
  objective:
    kind: relation
    target: Objective
  owner: { kind: person }
  metric: { kind: text }
  baseline: { kind: number }
  target_value: { kind: number }
  current_value: { kind: number }
  attainment: { kind: number, format: progress, precision: 0 }
  deliverables:
    kind: relation
    target: Work item
---

# Key result

A measurable result under an objective. `objective:` points back up (for
navigation and grouping), `deliverables:` points down at the work items that
move the number — so one record links three levels of the tree.
