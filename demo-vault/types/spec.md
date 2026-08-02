---
type: Type
icon: file-text
color: '#0EA5E9'
fields:
  status: { kind: select, options: [draft, in review, approved] }
  owner: { kind: person }
  project: { kind: relation, target: Project }
---

# Spec

Written specifications — PRDs, design docs, proposals. A spec is a record with
a status and an owner; its prose lives in the record's body.
