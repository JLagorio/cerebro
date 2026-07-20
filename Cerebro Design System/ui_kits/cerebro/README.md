# Cerebro UI kit

High-fidelity, clickable recreation of the Cerebro internal product system (original identity; workflow genre informed by the Productboard source material — see root readme provenance note).

## Run
Open `index.html` — it loads React UMD + `_ds_bundle.js` and mounts `CerebroApp`.

## Wired interactions
- Rail + sidebar navigation across five views: **Strategic OKR planning** (grid, expandable objectives → key results), **Initiatives roadmap** (timeline, Q3/Q4 2026, today marker), **Delivery board** (kanban), **Knowledge** (signals list + note detail with AI summary), **Cerebro overview** (weekly opportunities, skills toggles, scheduled automations).
- Click any row/card → **DetailPanel** (tabs, fields, key results, AI summary).
- "Board controls" → right panel (layout segmented control actually switches board layout; filters/groups are cosmetic).
- Agent view: "New automation" opens the **Create scheduled automation** dialog.

## Files
`CerebroApp.jsx` (state + routing) · `AppShell.jsx` (rail, sidebar, top bar with AskBar) · `BoardChrome.jsx` (board header + toolbar chips + grid css) · `OkrBoard.jsx` · `RoadmapView.jsx` · `DeliveryBoard.jsx` · `KnowledgeView.jsx` · `AgentHome.jsx` · `DetailPanel.jsx` · `BoardControls.jsx` · `data.js` (sample content).

All primitives come from `components/` — nothing re-implemented here except view-specific layout.
