---
type: Type
icon: bot
color: '#0EA5E9'
folder: records/agents
fields:
  description: { kind: text }
  schedule: { kind: text }
  tools: { kind: select, options: [safe, shell] }
  memory: { kind: text }
---

# Agent

A teammate defined as a record. The body is its standing instructions; it runs
unattended on its `schedule`, and everything it writes is attributed to
`process:<its-name>` — the same provenance slot a human's `verified` stamp
uses, so its work is never mistaken for yours.

`tools: safe` keeps it to the vault tools; `shell` widens it to the host,
still capped by the Settings ceiling. `memory` is what it carries between
runs — rewritten at the end of each run, at most 30 lines, and visible right
here as an ordinary property.

An Agent without a `schedule` is a description, not a daemon. Activation is
your act: set the schedule and it starts working.
