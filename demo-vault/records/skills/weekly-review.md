---
type: Skill
slug: weekly-review
description: Summarize the week — what moved, what stalled, what is at risk — from the vault's records and knowledge.
allowed-tools: get_vault_context, search_notes, get_note, open_note
---

# Weekly review

Prepare a weekly review of this vault. Work only from what is written down.

1. With get_vault_context and search_notes, find records whose status or dates
   changed in the last seven days, and anything now past its `due`.
2. Read what the knowledge/ bundle holds about the projects those records
   belong to — lead with anything a human has verified.
3. Answer in three short sections: **Moved** (what progressed, one line each),
   **Stalled** (open items untouched all week), **At risk** (records whose
   dates, blockers, or contradicting knowledge say so — cite the note).
4. Filing follow-ups is the user's call. This skill only reads, and that is
   not a request: `allowed-tools:` above hands the run four tools and no
   writer, so a turn invoked through `/weekly-review` cannot change the vault
   even if it decides it should.

Add `schedule: weekly fri 17:00` to the frontmatter and this runs itself every
Friday afternoon while the app is open. The demo vault ships it unscheduled so
the demo's background agent stays predictable.
