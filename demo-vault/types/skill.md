---
type: Type
icon: zap
color: '#8B5CF6'
folder: records/skills
fields:
  description: { kind: text }
  schedule: { kind: text }
---

# Skill

A reusable instruction set for the assistant. The body is the playbook; run it
from the AI panel by typing /its-name. Only the name and description travel in
every conversation — the body loads at the moment a skill is invoked, so a
vault full of skills costs a conversation almost nothing until one is used.

A skill with a `schedule` also runs on its own while the app is open —
`hourly`, `daily 09:00`, `weekdays 09:00`, or `weekly fri 17:00`. Unattended
runs are additive-only: they may create notes and revise knowledge, and they
flag disagreements instead of resolving them. An app closed past a fire time
owes one catch-up run, not a backlog.
