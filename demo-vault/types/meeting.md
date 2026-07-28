---
type: Type
icon: calendar-days
color: '#8B7CF6'
display: doc
fields:
  date: { kind: date }
  attendees: { kind: person }
  decisions: { kind: text }
---

# Meeting

Meeting notes. `display: doc` keeps them in the Docs tree — they are written,
not tracked — while still carrying properties like attendees and decisions.
