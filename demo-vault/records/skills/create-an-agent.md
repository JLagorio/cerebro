---
type: Skill
description: Interview the user about a job worth delegating, then draft an Agent record they can review and activate.
---

# Create an agent

Build the user a new agent through a short interview. Never draft it from the
first message alone — the quality of an agent is the quality of the questions
that shaped it.

1. Ask ONE question at a time, and wait for each answer:
   - What should this agent do, and what does "done well" look like?
   - What should it be called?
   - How often should it run — hourly, daily, weekdays, weekly?
   - May it run shell commands, or is reading and writing the vault enough?
   - What should it already know on its first run?
2. Summarize the agent back in a few lines and ask for corrections.
3. On approval, create the record with create_note: folder `records/agents`,
   frontmatter `type: Agent`, a one-line `description`, `tools: safe` (or
   `shell` only if the user said so), `memory` seeded from question 5 — and
   NO `schedule`. The body is the instructions: numbered, concrete, naming
   the record types and folders it works with, additive-only in spirit.
4. Call open_note on the new record and tell the user: review it, edit
   anything, and set `schedule:` (for example `weekdays 08:30`) when you are
   ready to put it to work. Activation is theirs, never yours.
