---
type: Reference
title: The offline guarantee
description: What the product promises when a crew loses connectivity, and where that number comes from.
tags: [offline-sync, product]
lifecycle: stable
generated: { by: claude-code, at: 2026-07-26T11:20:00Z }
verified: { by: human:tom-keller, at: 2026-07-27T09:10:00Z }
stale_after: 2026-10-01
sources:
  - id: dec-window
    resource: /records/decisions/dec-offline-window-72h.md
    title: "Decision: offline window is 72 hours"
    author: human:tom-keller
    last_modified: 2026-06-28
  - id: syn-9
    resource: /projects/offline-sync-hardening/items/syn-9.md
    title: Warn past the 72-hour offline window
---

# The guarantee

The app guarantees **72 hours** of offline operation with a clean merge on reconnect.[^dec-window]

| Window | Behaviour |
|--------|-----------|
| 0–72h | Clean merge guaranteed |
| Past 72h | Work still accepted; merge may need a person |

# Where it is stated

Only one document is authoritative: the decision.[^dec-window] The in-app warning implements it,[^syn-9] and at least one sales asset currently contradicts it by promising a week.

# Why bounded

An unbounded window means unbounded local state and a conflict probability that climbs with the age of the divergence. 72 hours covers a long weekend plus a day, which is the real field pattern.

[^dec-window]: Decision — offline window is 72 hours
[^syn-9]: Warn past the 72-hour offline window
