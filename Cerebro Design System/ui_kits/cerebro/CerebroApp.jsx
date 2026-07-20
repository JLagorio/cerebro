import React from "react";
import { AppShell } from "./AppShell.jsx";
import { OkrBoard } from "./OkrBoard.jsx";
import { RoadmapView } from "./RoadmapView.jsx";
import { DeliveryBoard } from "./DeliveryBoard.jsx";
import { KnowledgeView } from "./KnowledgeView.jsx";
import { AgentHome } from "./AgentHome.jsx";
import { DetailPanel } from "./DetailPanel.jsx";
import { BoardControls } from "./BoardControls.jsx";
const ALIAS = { objectives: "okr", initiatives: "roadmap", features: "delivery", opportunities: "agenthome", home: "okr" };
const LAYOUT_VIEW = { grid: "okr", timeline: "roadmap", columns: "delivery" };
const VIEW_LAYOUT = { okr: "grid", roadmap: "timeline", delivery: "columns" };
export function CerebroApp({ initialView = "okr" }) {
  const [view, setView] = React.useState(initialView);
  const [item, setItem] = React.useState(null);
  const [controls, setControls] = React.useState(false);
  const navigate = (id) => { setView(ALIAS[id] || id); setItem(null); setControls(false); };
  const select = (it) => { setControls(false); setItem(it); };
  const openControls = () => { setItem(null); setControls(true); };
  const props = { onSelect: select, selectedId: item && item.id, onControls: openControls };
  return (
    <AppShell active={view} onNavigate={navigate}>
      {view === "okr" ? <OkrBoard {...props} /> :
        view === "roadmap" ? <RoadmapView {...props} /> :
        view === "delivery" ? <DeliveryBoard {...props} /> :
        view === "knowledge" ? <KnowledgeView onControls={openControls} /> :
        <AgentHome />}
      {item ? <DetailPanel item={item} onClose={() => setItem(null)} /> : null}
      {controls ? <BoardControls layout={VIEW_LAYOUT[view] || "grid"} onLayout={(l) => setView(LAYOUT_VIEW[l])} onClose={() => setControls(false)} /> : null}
    </AppShell>
  );
}
