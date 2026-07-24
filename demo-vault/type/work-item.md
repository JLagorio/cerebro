---
type: Type
icon: check-square
color: '#3D8BE8'
fields:
  status: { kind: status }
  priority:
    kind: select
    options:
      - { id: urgent, color: '#DE3B4E' }
      - { id: high, color: '#DE8F0A' }
      - { id: medium, color: '#3D8BE8' }
      - { id: low, color: '#A8AFC2' }
      - { id: none, color: '#7E8699' }
  assignee: { kind: person }
  due: { kind: date }
  estimate:
    kind: select
    options:
      - { id: XS }
      - { id: S }
      - { id: M }
      - { id: L }
      - { id: XL }
  project: { kind: relation, target: Project }
---

# Work item

Work items are the unit of delivery: tasks, bugs, and milestones tracked on project boards.
