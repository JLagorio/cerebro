---
type: Type
icon: folder-kanban
color: '#14B8A6'
fields:
  key: { kind: text }
  state:
    kind: select
    options:
      - { id: draft, color: '#A8AFC2', hollow: true }
      - { id: planning, color: '#6580EC' }
      - { id: execution, color: '#DE8F0A' }
      - { id: monitoring, color: '#38BDF8' }
      - { id: completed, color: '#1F9D61' }
  space: { kind: relation, target: Space }
---

# Project

Projects belong to a space, carry an uppercase item-key prefix, and collect work items.
