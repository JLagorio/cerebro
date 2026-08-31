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
tabs:
  - { id: overview, name: Overview, content: overview }
  - { id: work-items, name: Work items, icon: square-check, content: view, source: { type: Work item }, scope: related }
---

# Epic

A body of work large enough to plan but small enough to finish: a handful of work items that only make sense shipped together.

An epic points at the key result it moves, so progress rolls up from delivery to measurement without anyone maintaining a second spreadsheet.

Every epic's record page carries a Work items tab — a view of the Work item database scoped through the `epic` relation — so the delivery list lives where the epic is read instead of in a saved search someone has to remember (M45.4).
