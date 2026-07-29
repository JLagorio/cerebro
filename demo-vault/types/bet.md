---
type: Type
icon: dice-5
color: '#F59E0B'
statuses:
  - { id: open, group: active, color: '#DE8F0A' }
  - { id: won, group: done, color: '#1F9D61' }
  - { id: lost, group: closed, color: '#DE3B4E' }
  - { id: void, group: closed, color: '#A8AFC2', hollow: true }
fields:
  status: { kind: status }
  confidence:
    kind: select
    options:
      - { id: low, color: '#DE3B4E' }
      - { id: medium, color: '#DE8F0A' }
      - { id: high, color: '#1F9D61' }
  horizon:
    kind: select
    options:
      - { id: this-quarter, color: '#3D8BE8' }
      - { id: next-quarter, color: '#6580EC' }
      - { id: this-year, color: '#A8AFC2' }
  stake: { kind: text }
  supports: { kind: relation, target: Objective }
  settles_by: { kind: date }
---

# Bet

Something we are choosing to believe before we have the evidence, written down with what would settle it.

A bet is not a task and not a goal. It is a claim with a stake and a date, so that being wrong is cheap to notice.
