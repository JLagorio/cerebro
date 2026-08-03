---
title: Phoenix cutover standup
ingested_at: 2026-07-28T09:14:00Z
ingest_format: vtt
source_file: '2026-07-28 Phoenix cutover standup.vtt'
speakers: [Marcus Webb, Priya Nair, Tom Keller]
duration: '00:01:14'
---

# Phoenix cutover standup

`00:00:04` **Marcus Webb:** Right, cutover. We are eleven days out and the thing I keep coming back to is that nobody has actually run the rollback. We have it written down. Written down is not rehearsed.

`00:00:19` **Priya Nair:** The part that worries me is step two. Draining the pick queue is not instant — it took about forty minutes in staging, and that was with a tenth of the volume. If we cut DNS while there is still work in flight it lands in neither system. That is the failure mode nobody has a recovery for.

`00:00:44` **Tom Keller:** Is that PHX-421? I thought we opened a ticket for the rehearsal after the last review.

`00:00:52` **Marcus Webb:** PHX-421 is the rehearsal, yes. It is still open and unassigned, which is the actual problem.

`00:01:03` **Priya Nair:** Forty minutes is the number to plan around. Anything shorter than an hour of drain time and we are guessing.

`00:01:14` **Tom Keller:** Scanners are fine either way — the camera fallback is the assumed path on night one, so hardware is not on the critical path.
