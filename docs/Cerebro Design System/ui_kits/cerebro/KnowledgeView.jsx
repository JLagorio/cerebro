import React from "react";
import { Icon } from "../../components/core/Icon.jsx";
import { IconButton } from "../../components/core/IconButton.jsx";
import { Button } from "../../components/core/Button.jsx";
import { Input } from "../../components/core/Input.jsx";
import { FilterChip } from "../../components/navigation/FilterChip.jsx";
import { Badge } from "../../components/display/Badge.jsx";
import { Avatar } from "../../components/display/Avatar.jsx";
import { Tag } from "../../components/display/Tag.jsx";
import { EntityIcon } from "../../components/display/EntityIcon.jsx";
import { AISummary } from "../../components/ai/AISummary.jsx";
import { BoardHeader } from "./BoardChrome.jsx";
import { SIGNALS } from "./data.js";
const css = `
.cb-kn{flex:1;display:flex;min-width:0;min-height:0}
.cb-kn-list{flex:1;min-width:0;overflow-y:auto;border-top:1px solid var(--n-200)}
.cb-sig{display:flex;flex-direction:column;gap:4px;padding:12px 20px;border-bottom:1px solid var(--n-100);cursor:pointer;transition:background var(--dur-fast) var(--ease-out)}
.cb-sig:hover{background:var(--n-50)}
.cb-sig-on{background:var(--surface-selected)}
.cb-sig-on:hover{background:var(--surface-selected)}
.cb-sig-hd{display:flex;align-items:center;gap:8px}
.cb-sig-hd .cb-sig-team{font-weight:600;color:var(--n-900)}
.cb-sig-hd .cb-sig-meta{color:var(--n-500);font-size:var(--text-xs)}
.cb-sig-txt{color:var(--n-600);font-size:var(--text-xs);line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cb-sig-dot{width:7px;height:7px;border-radius:50%;background:var(--cortex-500);flex:none}
.cb-kn-detail{width:420px;flex:none;border-left:1px solid var(--n-200);border-top:1px solid var(--n-200);display:flex;flex-direction:column;min-height:0;background:var(--n-0)}
.cb-kn-detail-bd{flex:1;overflow-y:auto;padding:16px 20px}
.cb-kn-f{display:flex;gap:8px;min-height:30px;align-items:center;font-size:var(--text-sm)}
.cb-kn-f .k{display:flex;align-items:center;gap:8px;width:110px;flex:none;color:var(--n-500)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-kn-css")) { const t = document.createElement("style"); t.id = "cb-kn-css"; t.textContent = css; document.head.appendChild(t); }
export function KnowledgeView({ onControls }) {
  const [sel, setSel] = React.useState(SIGNALS[0].id);
  const s = SIGNALS.find((x) => x.id === sel);
  return (
    <div className="cb-view">
      <BoardHeader crumb="Library" icon="message-square-text" title="Knowledge" onControls={onControls}>
        <FilterChip label="All signals" active />
        <FilterChip label="Unprocessed" />
        <FilterChip icon="list-filter" label="Filtered by" value="Any time" onRemove={() => {}} />
        <span style={{ flex: 1 }}></span>
        <Input icon="search" placeholder="Search knowledge…" width={220} size="sm" />
      </BoardHeader>
      <div className="cb-kn">
        <div className="cb-kn-list">
          <div style={{ padding: "10px 20px", fontSize: "var(--text-xs)", color: "var(--n-500)", borderBottom: "1px solid var(--n-100)", display: "flex", alignItems: "center", gap: 6 }}>
            {SIGNALS.length} signals<span style={{ flex: 1 }}></span><Icon name="arrow-down-up" size={12} />Updated (newest)
          </div>
          {SIGNALS.map((sg) => (
            <div key={sg.id} className={`cb-sig ${sel === sg.id ? "cb-sig-on" : ""}`} onClick={() => setSel(sg.id)}>
              <div className="cb-sig-hd">
                <EntityIcon type="company" size={15} />
                <span className="cb-sig-team">{sg.team}</span>
                <span className="cb-sig-meta">{sg.author}</span>
                <Badge>{sg.kind}</Badge>
                <span style={{ flex: 1 }}></span>
                <span className="cb-sig-meta">{sg.time}</span>
                {sg.unread ? <span className="cb-sig-dot"></span> : null}
              </div>
              <div className="cb-sig-txt">{sg.text}</div>
            </div>
          ))}
        </div>
        <div className="cb-kn-detail">
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "10px 12px 0" }}>
            <Badge>{s.kind}</Badge><span style={{ flex: 1 }}></span>
            <IconButton icon="maximize-2" label="Expand" size="sm" /><IconButton icon="ellipsis" label="More" size="sm" />
          </div>
          <div style={{ padding: "8px 20px 12px", fontSize: "var(--text-lg)", fontWeight: 600, letterSpacing: "var(--track-tight)" }}>{s.kind} — {s.team}</div>
          <div className="cb-kn-detail-bd">
            <AISummary sources={s.sources} onRegenerate={() => {}}>{s.summary}</AISummary>
            <div style={{ margin: "16px 0 0" }}>
              <div className="cb-kn-f"><span className="k"><Icon name="building-2" size={14} />Team</span><EntityIcon type="company" size={14} /><span>{s.team}</span></div>
              <div className="cb-kn-f"><span className="k"><Icon name="circle-user" size={14} />From</span><Avatar name={s.author} size={20} /><span>{s.author}</span></div>
              <div className="cb-kn-f"><span className="k"><Icon name="link" size={14} />Links</span>{s.linked ? <Tag icon={s.linked.type === "feature" ? undefined : s.linked.type === "initiative" ? "diamond" : "lightbulb"} color={s.linked.swatch}>{s.linked.label}</Tag> : <span style={{ color: "var(--n-400)" }}>None</span>}</div>
            </div>
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--n-100)", color: "var(--n-700)", lineHeight: "20px", fontSize: "var(--text-sm)" }}>
              <span style={{ fontWeight: 600, color: "var(--n-900)" }}>{s.author}:</span> {s.text}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--n-100)" }}>
            <Avatar name="Maya Chen" size={22} /><span style={{ fontSize: "var(--text-xs)", color: "var(--n-500)" }}>Following</span>
            <span style={{ flex: 1 }}></span>
            <Button size="sm" icon="check">Mark processed</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
