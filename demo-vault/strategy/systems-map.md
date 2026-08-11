# Systems map

How the demo product's pieces talk to each other. The flowchart below uses the
default layout; the last one uses ELK, which proves the optional engine loads.

```mermaid
flowchart TD
  Idea[Idea] --> Build[Build]
  Build --> Review{Review}
  Review -->|ship| Done[Done]
  Review -->|rework| Build
```

## Order flow

```mermaid
sequenceDiagram
  participant U as User
  participant A as App
  participant S as Store
  U->>A: place order
  A->>S: reserve stock
  S-->>A: confirmed
  A-->>U: receipt
```

## Rollout

```mermaid
gantt
  title Rollout
  dateFormat YYYY-MM-DD
  section Phase 1
    Pilot     :a1, 2026-08-01, 7d
    Expand    :after a1, 14d
```

## Complex layout (ELK)

```mermaid
---
config:
  layout: elk
---
flowchart LR
  A[Ingest] --> B[Parse]
  A --> C[Index]
  B --> D[Store]
  C --> D
  D --> E[Serve]
```
