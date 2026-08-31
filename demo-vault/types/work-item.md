---
type: Type
icon: square-check
color: '#3D8BE8'
statuses:
  - { id: backlog, group: active, color: '#A8AFC2', hollow: true }
  - { id: todo, group: active, color: '#7E8699' }
  - { id: progress, group: active, color: '#DE8F0A' }
  - { id: review, group: active, color: '#38BDF8' }
  - { id: done, group: done, color: '#1F9D61' }
  - { id: cancelled, group: closed, color: '#A8AFC2' }
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
  window: { kind: daterange }
  estimate:
    kind: select
    options:
      - { id: XS }
      - { id: S }
      - { id: M }
      - { id: L }
      - { id: XL }
  epic: { kind: relation, target: Epic }
  blocked_by: { kind: relation, target: Work item }
layout:
  heading: [status, priority]
  groups:
    - { id: planning, name: Planning, fields: [assignee, due, estimate] }
views:
  # The database's DEFAULT, and deliberately unfiltered (M47.5). A view named
  # by nothing — a `/database` block with no `view:`, a record tab whose
  # source names only the type — takes the first one, so the first one should
  # mean "all of them". Before this the corpus led with At risk, and "show me
  # Work item" quietly meant "show me the urgent ones still moving".
  - id: all
    name: All
    icon: null
    filters: null
    presentation:
      type: table
      group:
        - field: status
      sort:
        - field: due
          dir: asc
      columns:
        - field: status
        - field: priority
        - field: assignee
        - field: due
        - field: estimate
  - id: at-risk-work
    name: At risk
    icon: null
    filters:
      all:
        - field: priority
          op: any_of
          value:
            - urgent
            - high
        - any:
            - field: status
              op: equals
              value: progress
            - field: status
              op: equals
              value: review
    presentation:
      type: table
      group:
        - field: status
        - field: assignee
      sort:
        - field: due
          dir: asc
        - field: priority
          dir: asc
      columns:
        - field: status
        - field: priority
        - field: assignee
        - field: due
          width: 120
        - field: estimate
  - id: this-month
    name: This month
    icon: null
    filters: null
    presentation:
      type: calendar
      group: []
      sort:
        - field: due
          dir: asc
      columns:
        - field: status
        - field: assignee
      dateField: window
  - id: delivery-schedule
    name: Delivery schedule
    icon: null
    filters: null
    presentation:
      type: gantt
      group:
        - field: status
      sort:
        - field: due
          dir: asc
      columns:
        - field: status
        - field: assignee
        - field: due
        - field: estimate
      dateField: window
      zoom: month
      dependencyField: blocked_by
---

# Work item

Work items are the unit of delivery: tasks, bugs, and milestones tracked on project boards.

`blocked_by` is how blocking is modelled — a relation between two items, not a separate Blocker record. A blockage is a fact about a pair of items, and giving it its own note would mean maintaining a third thing that goes stale the moment either end moves.
