import React from "react";
import { Icon } from "../../components/core/Icon.jsx";
import { EntityIcon } from "../../components/display/EntityIcon.jsx";
import { StatusFlag } from "../../components/display/StatusFlag.jsx";
import { BoardHeader, DefaultChips } from "./BoardChrome.jsx";
import { INITIATIVES, MONTHS } from "./data.js";
const css = `
.cb-tl{display:flex;flex-direction:column;min-width:860px}
.cb-tl-head{display:flex;height:var(--row-head-h);border-top:1px solid var(--n-200);border-bottom:1px solid var(--n-200);background:var(--n-25);position:sticky;top:0;z-index:2;font-size:var(--text-xs);color:var(--n-600)}
.cb-tl-names{width:300px;flex:none;display:flex;align-items:center;padding:0 12px;border-right:1px solid var(--n-200);gap:6px;font-weight:500}
.cb-tl-months{flex:1;display:grid;grid-template-columns:repeat(8,1fr)}
.cb-tl-months>div{display:flex;align-items:center;padding:0 8px;border-right:1px solid var(--n-100);text-transform:uppercase;letter-spacing:.04em;font-size:10px;gap:6px}
.cb-tl-q{color:var(--n-800);font-weight:600}
.cb-tl-row{display:flex;border-bottom:1px solid var(--n-100);cursor:pointer}
.cb-tl-row:hover{background:var(--n-50)}
.cb-tl-row .cb-tl-names{font-weight:500;color:var(--n-900);gap:8px;border-right:1px solid var(--n-200)}
.cb-tl-canvas{flex:1;position:relative;display:grid;grid-template-columns:repeat(8,1fr);align-items:center}
.cb-tl-canvas>i{border-right:1px solid var(--n-100);height:100%;grid-row:1}
.cb-tl-bar{height:8px;border-radius:var(--r-full);grid-row:1;margin:0 6px;position:relative}
.cb-tl-bar-thin{height:6px}
.cb-tl-grp{display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;background:var(--n-25);border-bottom:1px solid var(--n-100);font-weight:600;font-size:var(--text-sm);color:var(--n-800)}
.cb-tl-today{position:absolute;top:0;bottom:0;width:1px;background:var(--cortex-400);z-index:1;pointer-events:none}
.cb-tl-today::after{content:"";position:absolute;top:0;left:-3px;width:7px;height:7px;border-radius:50%;background:var(--cortex-400)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-tl-css")) { const t = document.createElement("style"); t.id = "cb-tl-css"; t.textContent = css; document.head.appendChild(t); }

const M0 = 4; // May
function Row({ item, kind, indent, onClick }) {
  const start = item.start - M0 + 1, end = Math.min(start + item.len, 9);
  return (
    <div className="cb-tl-row" style={{ height: 40 }} onClick={onClick}>
      <div className="cb-tl-names" style={{ paddingLeft: 12 + (indent ? 26 : 0), fontWeight: indent ? 400 : 500 }}>
        <EntityIcon type={kind} swatch={item.swatch} size={15} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
      </div>
      <div className="cb-tl-canvas">
        {Array.from({ length: 8 }).map((_, i) => <i key={i} style={{ gridColumn: i + 1 }}></i>)}
        <span className={`cb-tl-bar ${indent ? "cb-tl-bar-thin" : ""}`} style={{ gridColumn: `${start} / ${end}`, background: item.swatch }}></span>
      </div>
    </div>
  );
}
export function RoadmapView({ onSelect, onControls }) {
  const groups = [
    { label: "In progress", status: "progress", items: INITIATIVES.filter((i) => i.status === "progress") },
    { label: "Planned", status: "planned", items: INITIATIVES.filter((i) => i.status === "planned") },
    { label: "New idea", status: "idea", items: INITIATIVES.filter((i) => i.status === "idea") },
  ];
  return (
    <div className="cb-view">
      <BoardHeader crumb="Organization" icon="calendar-range" title="Initiatives roadmap" onControls={onControls}><DefaultChips /></BoardHeader>
      <div className="cb-body">
        <div className="cb-tl" style={{ position: "relative" }}>
          <div className="cb-tl-head">
            <div className="cb-tl-names"><Icon name="diamond" size={13} />Initiatives, Features</div>
            <div className="cb-tl-months">
              {MONTHS.slice(M0, M0 + 8).map((m, i) => (
                <div key={m}>{m === "Jul" ? <span className="cb-tl-q">Q3 2026</span> : m === "Oct" ? <span className="cb-tl-q">Q4</span> : null}{m}</div>
              ))}
            </div>
          </div>
          <div style={{ position: "absolute", left: `calc(300px + (100% - 300px) * ${(2 + 19 / 31) / 8})`, top: 36, bottom: 0 }} className="cb-tl-today"></div>
          {groups.map((g) => (
            <React.Fragment key={g.label}>
              <div className="cb-tl-grp"><StatusFlag bare status={g.status} />{g.label}</div>
              {g.items.map((init) => (
                <React.Fragment key={init.id}>
                  <Row item={init} kind="initiative" onClick={() => onSelect({ ...init, kind: "initiative", insights: 3, team: "Field Platform" })} />
                  {init.features.map((f) => (
                    <Row key={f.id} item={f} kind="feature" indent onClick={() => onSelect({ ...f, kind: "feature", insights: 2, timeframe: init.timeframe, objective: init.objective })} />
                  ))}
                </React.Fragment>
              ))}
            </React.Fragment>
          ))}
          <div className="cb-addrow"><Icon name="plus" size={15} />Create initiative</div>
        </div>
      </div>
    </div>
  );
}
