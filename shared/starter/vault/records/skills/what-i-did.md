---
type: Skill
slug: what-i-did
description: Reconstruct a day's recorded writing, with times, links and honest gaps.
arguments:
  - { name: day, description: 'The local day to read; defaults to yesterday.' }
allowed-tools: [read_activity, list_notes, get_note]
---

# What I did

This skill only reads. Write nothing and never rank people, pages or priorities.
Using the stated local time and offset, compute the requested day's local
midnight-to-midnight bounds; default to yesterday. State the day and offset.

Read that window with read_activity. Keep your writes and the Assistant's in
turns you started. Use list_notes to resolve a named page and get_note only when
its current text helps explain a recorded change; current text is not proof of
what happened then. Do not attribute someone else's change to you.

Group recorded changes into morning, afternoon and evening, in time order:
one line per change with a local time and a wikilink, then two or three sentences
on the day. Preserve a cut-short answer's warning and any unknown attribution.

Read the answer's open-times line before describing an empty day. If it says
"Cerebro was not open in this window", or open times are not recorded, say
"not recorded", never "nothing". Historical rows may exist without recorded
open times; keep those rows while stating that gap.

## What this can't see

- Edits outside Cerebro.
- Days Cerebro was closed.
- Pages you only read.

You can edit this file or add a schedule: to run it regularly. This copy starts
unscheduled.
