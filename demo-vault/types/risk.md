---
type: Type
icon: triangle-alert
color: '#DE3B4E'
statuses:
  - id: open
    group: active
    color: '#DE3B4E'
  - id: mitigating
    group: active
    color: '#DE8F0A'
  - id: accepted
    group: done
    color: '#7E8699'
  - id: retired
    group: closed
    color: '#A8AFC2'
    hollow: true
fields:
  status: { kind: status }
  severity:
    kind: select
    options:
      - { id: low, color: '#A8AFC2' }
      - { id: medium, color: '#3D8BE8' }
      - { id: high, color: '#DE8F0A' }
      - { id: critical, color: '#DE3B4E' }
  owner: { kind: person }
  affects:
    kind: relation
    target: Objective
  mitigation: { kind: text }
---

# Risk

Something that could stop an objective landing. A risk earns its own type
because it has its own fields and lifecycle; a *blocker*, by contrast, is just
a relation between two work items — not a type.
