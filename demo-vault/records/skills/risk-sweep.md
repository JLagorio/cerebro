---
type: Skill
slug: risk-sweep
description: Sweep open work for risks nobody has written down, and draft Risk records for the ones that matter.
arguments:
  - name: scope
    description: A project or list to sweep; the whole vault when omitted.
---

# Risk sweep

Find the risks this vault is carrying but not naming.

1. Read the open records — anything with an active status — and the knowledge
   bundle's concepts about the same projects, contradictions first.
2. A candidate risk is a specific, falsifiable statement tied to a record or
   date: a slipped dependency, a contradiction between a plan and a decision,
   a commitment with no owner. Skip vibes.
3. Check the existing Risk records first — a risk already on the books is not
   a finding, though one whose severity the evidence has outgrown is.
4. For each genuine new risk, create a Risk record with create_note: relate
   the objective it threatens via `affects` when there is one, name any other
   implicated records as [[wikilinks]] in the body alongside the evidence
   note, and leave severity for the user to set.
5. Report what you filed and what you considered and rejected, in one line
   each.
