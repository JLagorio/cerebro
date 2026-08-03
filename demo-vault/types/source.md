---
type: Type
icon: link
color: '#64748B'
display: doc
fields:
  source_url: { kind: url }
  source_id: { kind: text }
  fetched_at: { kind: date }
---

# Source

A local copy of something fetched from another system — a ticket, a wiki page. The assistant writes these with `cache_source` so the same ticket is fetched once rather than on every question about it.
