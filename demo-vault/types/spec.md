---
type: Type
icon: file-text
color: '#0EA5E9'
display: doc
fields:
  status: { kind: select, options: [draft, in review, approved] }
  owner: { kind: person }
  project: { kind: relation, target: Project }
---

# Spec

Written specifications — PRDs, design docs, proposals. `display: doc` because a spec is authored, not tracked: it lives in the Docs tree beside the project it belongs to.
