import React from "react";
import { Icon } from "../../components/core/Icon.jsx";
import { EntityIcon } from "../../components/display/EntityIcon.jsx";
import { HealthChip } from "../../components/display/HealthChip.jsx";
import { Avatar } from "../../components/display/Avatar.jsx";
import { ProgressBar } from "../../components/display/ProgressBar.jsx";
import { BoardHeader, DefaultChips } from "./BoardChrome.jsx";
import { OBJECTIVES } from "./data.js";

const W = { tf: 180, owner: 150, health: 120, prog: 170 };
function Head() {
  return (
    <div className="cb-grid-head">
      <div style={{ flex: 1 }}><Icon name="target" size={13} />Objectives, Key results</div>
      <div style={{ width: W.tf, flex: "none" }}><Icon name="calendar" size={13} />Timeframe</div>
      <div style={{ width: W.owner, flex: "none" }}><Icon name="briefcase" size={13} />Owner</div>
      <div style={{ width: W.health, flex: "none" }}><Icon name="activity" size={13} />Health</div>
      <div style={{ width: W.prog, flex: "none" }}><Icon name="percent" size={13} />Work progress</div>
    </div>
  );
}
export function OkrBoard({ onSelect, selectedId, onControls }) {
  const [open, setOpen] = React.useState({ "obj-1": true, "obj-2": true, "obj-3": false });
  return (
    <div className="cb-view">
      <BoardHeader crumb="Organization" icon="table-2" title="Strategic OKR planning" onControls={onControls}><DefaultChips /></BoardHeader>
      <div className="cb-body">
        <Head />
        {OBJECTIVES.map((o) => (
          <React.Fragment key={o.id}>
            <div className={`cb-row ${selectedId === o.id ? "cb-row-on" : ""}`} onClick={() => onSelect({ ...o, kind: "objective", insights: 4 })}>
              <div className="cb-cell-name">
                <Icon name="chevron-right" size={14} className={`cb-chev ${open[o.id] ? "cb-chev-open" : ""}`}
                  onClick={(e) => { e.stopPropagation(); setOpen((s) => ({ ...s, [o.id]: !s[o.id] })); }} />
                <EntityIcon type="objective" size={16} />
                <span className="cb-name-txt">{o.name}</span>
              </div>
              <div style={{ width: W.tf, flex: "none" }}><span className="cb-mono">{o.timeframe}</span></div>
              <div style={{ width: W.owner, flex: "none" }}><Avatar name={o.owner} size={20} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.owner}</span></div>
              <div style={{ width: W.health, flex: "none" }}><HealthChip health={o.health} size="sm" /></div>
              <div style={{ width: W.prog, flex: "none" }}><ProgressBar value={o.progress} width={100} showLabel /></div>
            </div>
            {open[o.id] ? o.krs.map((kr) => (
              <div key={kr.id} className={`cb-row ${selectedId === kr.id ? "cb-row-on" : ""}`} onClick={() => onSelect({ ...kr, kind: "keyResult", insights: 1, description: `Current: ${kr.current}.` })}>
                <div className="cb-cell-name" style={{ paddingLeft: 46, fontWeight: 400 }}>
                  <EntityIcon type="keyResult" size={15} />
                  <span className="cb-name-txt">{kr.name}</span>
                  <span className="cb-mono" style={{ color: "var(--n-400)" }}>{kr.current}</span>
                </div>
                <div style={{ width: W.tf, flex: "none" }}><span className="cb-mono">{kr.timeframe}</span></div>
                <div style={{ width: W.owner, flex: "none" }}><Avatar name={kr.owner} size={20} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{kr.owner}</span></div>
                <div style={{ width: W.health, flex: "none" }}><HealthChip health={kr.health} size="sm" /></div>
                <div style={{ width: W.prog, flex: "none" }}><ProgressBar value={kr.progress} width={100} showLabel /></div>
              </div>
            )) : null}
          </React.Fragment>
        ))}
        <div className="cb-addrow"><Icon name="plus" size={15} />Create objective</div>
      </div>
    </div>
  );
}
