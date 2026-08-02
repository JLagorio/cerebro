---
type: Type
icon: target
color: '#8B7CF6'
statuses:
  - id: not-started
    group: active
    color: '#A8AFC2'
    hollow: true
  - id: on-track
    group: active
    color: '#1F9D61'
  - id: at-risk
    group: active
    color: '#DE8F0A'
  - id: off-track
    group: active
    color: '#DE3B4E'
  - id: achieved
    group: done
    color: '#1F9D61'
  - id: missed
    group: closed
    color: '#7E8699'
fields:
  status: { kind: status }
  owner: { kind: person }
  quarter:
    kind: select
    options:
      - { id: 2026-q3, label: '2026 Q3', color: '#6580EC' }
      - { id: 2026-q4, label: '2026 Q4', color: '#38BDF8' }
  key_results:
    kind: relation
    target: Key result
  progress:
    kind: rollup
    relation: key_results
    property: attainment
    calculate: avg
    format: progress
    precision: 0
  key_result_count:
    kind: rollup
    relation: key_results
    calculate: count
---

# Objective

A quarterly outcome. The objective OWNS the link to its key results
(`key_results:`) — rollups follow links forward, so the parent lists its
children. `progress` averages each key result's attainment; `key_result_count`
counts them.
