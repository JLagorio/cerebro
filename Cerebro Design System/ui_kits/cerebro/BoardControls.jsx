import React from "react";
import { Icon } from "../../components/core/Icon.jsx";
import { IconButton } from "../../components/core/IconButton.jsx";
import { SegmentedControl } from "../../components/core/SegmentedControl.jsx";
import { Checkbox } from "../../components/core/Checkbox.jsx";
import { Select } from "../../components/core/Select.jsx";
import { Button } from "../../components/core/Button.jsx";
const css = `
.cb-ctrl{width:var(--controls-w);flex:none;border-left:1px solid var(--n-200);background:var(--n-0);display:flex;flex-direction:column;min-height:0;animation:cbPanelIn var(--dur-med) var(--ease-out)}
.cb-ctrl-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px}
.cb-ctrl-hd h2{margin:0;font-size:var(--text-lg);font-weight:600;letter-spacing:var(--track-tight)}
.cb-ctrl-bd{flex:1;overflow-y:auto;padding:0 16px 16px;display:flex;flex-direction:column;gap:18px}
.cb-ctrl-sec{display:flex;flex-direction:column;gap:10px}
.cb-ctrl-sec .cb-ctrl-t{display:flex;align-items:center;justify-content:space-between;font-size:var(--text-md);font-weight:600}
.cb-ctrl-t a{font-size:var(--text-xs);font-weight:500}
.cb-where{border:1px solid var(--n-200);border-radius:var(--r-md);padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--n-25)}
.cb-where .cb-where-r{display:flex;align-items:center;gap:8px;font-size:var(--text-xs);color:var(--n-600)}
.cb-ctrl-ft{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-top:1px solid var(--n-100)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-ctrl-css")) { const t = document.createElement("style"); t.id = "cb-ctrl-css"; t.textContent = css; document.head.appendChild(t); }
export function BoardControls({ layout, onLayout, onClose }) {
  const [hideLinked, setHideLinked] = React.useState(false);
  const [archived, setArchived] = React.useState(false);
  const [hideEmpty, setHideEmpty] = React.useState(true);
  return (
    <aside className="cb-ctrl">
      <div className="cb-ctrl-hd"><h2>Board controls</h2><IconButton icon="x" label="Close" size="sm" onClick={onClose} /></div>
      <div className="cb-ctrl-bd">
        <div className="cb-ctrl-sec">
          <div className="cb-ctrl-t">Layout</div>
          <SegmentedControl size="md" value={layout} onChange={onLayout} options={[{ value: "grid", label: "Grid", icon: "table-2" }, { value: "timeline", label: "Timeline", icon: "calendar-range" }, { value: "columns", label: "Columns", icon: "kanban" }]} />
          <Checkbox checked={hideLinked} onChange={setHideLinked} label="Hide indirectly linked items" />
          <Checkbox checked={archived} onChange={setArchived} label="Include archived items" />
        </div>
        <div className="cb-ctrl-sec">
          <div className="cb-ctrl-t">Filters<a href="#" onClick={(e) => e.preventDefault()}>Clear all</a></div>
          <Checkbox checked={hideEmpty} onChange={setHideEmpty} label="Hide empty items" />
          <div className="cb-where">
            <div className="cb-where-r"><Icon name="diamond" size={13} /><span style={{ fontWeight: 500, color: "var(--n-800)" }}>Initiatives, Features</span><span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 11 }}>where</span></div>
            <div style={{ display: "flex", gap: 6 }}>
              <Select size="sm" width="50%" options={[{ value: "owner", label: "Owner" }, { value: "team", label: "Team" }]} />
              <Select size="sm" width="50%" options={[{ value: "any", label: "is any of" }, { value: "none", label: "is none of" }]} />
            </div>
            <Select size="sm" width="100%" options={[{ value: "me", label: "Me (Maya Chen)" }, { value: "team", label: "Field Platform" }]} />
          </div>
          <Button variant="ghost" icon="plus" size="sm" style={{ alignSelf: "flex-start" }}>Add filter</Button>
        </div>
        <div className="cb-ctrl-sec">
          <div className="cb-ctrl-t">Groups<a href="#" onClick={(e) => e.preventDefault()}>Clear all</a></div>
          <Select width="100%" options={[{ value: "status", label: "Initiative status" }, { value: "objective", label: "Objective" }, { value: "owner", label: "Owner" }]} />
          <Button variant="ghost" icon="plus" size="sm" style={{ alignSelf: "flex-start" }}>Add grouping</Button>
        </div>
      </div>
      <div className="cb-ctrl-ft">
        <Button variant="ghost" icon="rotate-ccw" size="sm">Reset changes</Button>
        <Button variant="primary" size="sm">Apply</Button>
      </div>
    </aside>
  );
}
