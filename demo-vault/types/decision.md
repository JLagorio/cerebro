---
type: Type
icon: gavel
color: '#0EA5E9'
statuses:
  - { id: proposed, group: active, color: '#DE8F0A' }
  - { id: accepted, group: done, color: '#1F9D61' }
  - { id: superseded, group: closed, color: '#A8AFC2', hollow: true }
  - { id: rejected, group: closed, color: '#7E8699' }
fields:
  status: { kind: status }
  decided: { kind: date }
  deciders: { kind: person }
  affects: { kind: relation, target: Project }
  supersedes: { kind: relation, target: Decision }
---

# Decision

A choice that was expensive to make and would be expensive to remake.

Decisions are written down because the reasoning decays faster than the
outcome: six months on, everyone remembers what was chosen and nobody
remembers what it was chosen over.
