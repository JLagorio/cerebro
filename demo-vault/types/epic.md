---
type: Type
icon: layers
color: '#8B5CF6'
statuses:
  - { id: shaping, group: active, color: '#A8AFC2', hollow: true }
  - { id: committed, group: active, color: '#6580EC' }
  - { id: building, group: active, color: '#DE8F0A' }
  - { id: shipped, group: done, color: '#1F9D61' }
  - { id: dropped, group: closed, color: '#A8AFC2' }
fields:
  status: { kind: status }
  owner: { kind: person }
  target: { kind: date }
  delivers: { kind: relation, target: Key result }
  progress:
    kind: rollup
    from: { type: Work item, field: epic }
    property: status
    calculate: count
---

# Epic

A body of work large enough to plan but small enough to finish: a handful of work items that only make sense shipped together.

An epic points at the key result it moves, so progress rolls up from delivery to measurement without anyone maintaining a second spreadsheet.
