import React from "react";
import { Icon } from "../../components/core/Icon.jsx";
import { IconButton } from "../../components/core/IconButton.jsx";
import { StatusFlag } from "../../components/display/StatusFlag.jsx";
import { KanbanCard } from "../../components/boards/KanbanCard.jsx";
import { BoardHeader, DefaultChips } from "./BoardChrome.jsx";
import { DELIVERY } from "./data.js";
const css = `
.cb-kb{display:flex;gap:12px;padding:14px 20px 20px;align-items:flex-start;min-height:100%;background:var(--surface-board)}
.cb-kb-col{width:280px;flex:none;display:flex;flex-direction:column;gap:10px}
.cb-kb-colhd{display:flex;align-items:center;gap:8px;font-weight:600;font-size:var(--text-sm);color:var(--n-800);padding:0 2px}
.cb-kb-colhd .cb-kb-n{color:var(--n-400);font-weight:500;font-family:var(--font-mono);font-size:11px}
.cb-kb-add{border:1px dashed var(--n-300);border-radius:var(--r-lg);height:34px;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--n-500);font-size:var(--text-xs);cursor:pointer;transition:background var(--dur-fast) var(--ease-out)}
.cb-kb-add:hover{background:var(--n-50);color:var(--n-700)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-kb-css")) { const t = document.createElement("style"); t.id = "cb-kb-css"; t.textContent = css; document.head.appendChild(t); }
const LABELS = { idea: "New idea", planned: "Planned", progress: "In progress", validation: "Validation", released: "Released" };
export function DeliveryBoard({ onSelect, onControls }) {
  return (
    <div className="cb-view">
      <BoardHeader crumb="Organization" icon="kanban" title="Delivery board" onControls={onControls}><DefaultChips /></BoardHeader>
      <div className="cb-body">
        <div className="cb-kb">
          {DELIVERY.map((col) => (
            <div className="cb-kb-col" key={col.status}>
              <div className="cb-kb-colhd">
                <StatusFlag bare status={col.status} />{LABELS[col.status]}
                <span className="cb-kb-n">{col.cards.length}</span>
                <span style={{ flex: 1 }}></span>
                <IconButton icon="plus" label="Add feature" size="sm" />
              </div>
              {col.cards.map((c) => (
                <KanbanCard key={c.title} title={c.title} swatch={c.swatch} timeframe={c.timeframe} owner={c.owner} tags={c.tags}
                  onClick={() => onSelect({ id: c.title, name: c.title, kind: "feature", status: col.status, owner: c.owner, timeframe: c.timeframe, swatch: c.swatch, insights: 2, release: (c.tags || []).some((t) => t.icon === "flag") ? c.tags.find((t) => t.icon === "flag").label : null })} />
              ))}
              <div className="cb-kb-add"><Icon name="plus" size={14} />Add feature</div>
            </div>
          ))}
          <div className="cb-kb-col" style={{ width: 200 }}>
            <div className="cb-kb-add" style={{ height: 30 }}><Icon name="plus" size={14} />Add column</div>
          </div>
        </div>
      </div>
    </div>
  );
}
