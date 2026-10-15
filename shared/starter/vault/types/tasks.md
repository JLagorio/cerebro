---
type: Type
icon: list-checks
folder: tasks
deadline: due
statuses:
  - { id: todo, group: active, color: '#7E8699' }
  - { id: progress, group: active, color: '#DE8F0A' }
  - { id: done, group: done, color: '#1F9D61' }
fields:
  status: { kind: status }
  priority:
    kind: select
    options:
      - { id: high }
      - { id: medium }
      - { id: low }
  due: { kind: date }
  agent: { kind: relation, target: Agent, limit: 1 }
views:
  - id: all
    name: All
    filters: null
    presentation:
      type: table
      sort: [{ field: due, dir: asc }]
      columns: [{ field: status }, { field: priority }, { field: due }, { field: agent }]
  - id: board
    name: Board
    filters: null
    presentation:
      type: board
      group: [{ field: status }]
---

# Tasks

A small place to keep what you want to do. Add fields and views as your work grows.
