---
type: Type
icon: folder-kanban
color: '#14B8A6'
fields:
  key: { kind: text }
  progress: { kind: rollup, from: { type: Work item, field: project }, property: status, calculate: percent_done, format: progress, precision: 0 }
  state:
    kind: select
    options:
      - { id: draft, color: '#A8AFC2', hollow: true }
      - { id: planning, color: '#6580EC' }
      - { id: execution, color: '#DE8F0A' }
      - { id: monitoring, color: '#38BDF8' }
      - { id: completed, color: '#1F9D61' }
  agents: { kind: relation, target: Agent }
tabs:
  - { id: overview, name: Overview, content: overview }
  - { id: tasks, name: Tasks, icon: square-check, content: view, source: { type: Work item }, scope: related }
  - { id: docs, name: Docs, icon: file-text, content: view, source: { type: Spec }, scope: related }
  - { id: agents, name: Agents, icon: bot, content: agents }
  - { id: runs, name: Runs, icon: history, content: runs }
---

# Project

A project is a page. Its Tasks and Docs tabs list the work items and specs that
name it through their `project:` relation. New work created from Tasks is filed
under this project, takes the next key from its prefix, and lives in the Work
item database's home folder.

A cycle is a saved view over the work items' `window` date range. Choose a date
range for that view and keep its related scope to see this project's cycle.

Listing an agent here assigns it the work filed here from now on, through that
work's agent field. Work already here keeps its own agents. Listing an agent
wakes nothing.
