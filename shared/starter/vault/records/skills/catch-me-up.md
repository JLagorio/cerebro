---
type: Skill
slug: catch-me-up
description: Read what needs you and what changed, with links and the limits of what is recorded.
arguments:
  - { name: since, description: 'When to start; defaults to the last 24 hours.' }
allowed-tools: [get_vault_context, list_agenda, query_records, list_inbox, read_activity, get_note]
---

# Catch me up

This skill only reads. Write nothing and never rank people, pages or priorities.
Use the stated local time and offset to turn since into a concrete start and end;
if none is supplied, use the last 24 hours. State the window you read. Use
get_vault_context for the databases and get_note only when an item needs context.

Read the Home lanes below in this order. Give one short section per non-empty
lane: counts first, newest first, and a wikilink to each page mentioned. Preserve
a read's truncation and unavailable or not-recorded words; never invent zero.

1. **My work:** list_agenda for deadlines, then query_records on databases with
   a status field for unfinished tasks. Keep dates and status as recorded.
2. **Agents:** read_activity for ended runs in the window. State when their
   outcomes or page changes are not recorded.
3. **Captures:** list_inbox for captures waiting to be filed.
4. **Your recent edits:** use the same read_activity result for your writes
   and the Assistant's work in turns you started. Name who actually wrote.
5. **Coming up:** list_agenda for the next seven days, naming that window
   separately from the catch-up window.

## What this can't see

- Waiting on you: proposals waiting for approval.
- Reminders: reminders due or missed.
- Knowledge changed: what changed since the last convergence run.
- What you marked Done on Home.

These gaps are not empty lanes. Do not claim nothing needs attention because a
lane is unseen. You can edit this file, or add a schedule: to run it regularly;
this copy starts unscheduled.
