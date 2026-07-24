import React from "react";
import { Icon } from "../../components/core/Icon.jsx";
import { IconButton } from "../../components/core/IconButton.jsx";
import { Tabs } from "../../components/navigation/Tabs.jsx";
import { EntityIcon } from "../../components/display/EntityIcon.jsx";
import { StatusFlag } from "../../components/display/StatusFlag.jsx";
import { HealthChip } from "../../components/display/HealthChip.jsx";
import { Avatar } from "../../components/display/Avatar.jsx";
import { Tag } from "../../components/display/Tag.jsx";
import { ProgressBar } from "../../components/display/ProgressBar.jsx";
import { AISummary } from "../../components/ai/AISummary.jsx";
const css = `
.cb-panel{width:var(--panel-w);flex:none;border-left:1px solid var(--n-200);background:var(--n-0);display:flex;flex-direction:column;min-height:0;animation:cbPanelIn var(--dur-med) var(--ease-out)}
@keyframes cbPanelIn{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}
.cb-panel-hd{padding:12px 16px 0}
.cb-panel-top{display:flex;align-items:center;gap:4px}
.cb-panel-name{font-size:var(--text-xl);line-height:var(--leading-xl);font-weight:600;letter-spacing:var(--track-tight);margin:10px 0 12px;display:flex;gap:10px;align-items:flex-start}
.cb-panel-bd{flex:1;overflow-y:auto;padding:16px}
.cb-field{display:flex;align-items:center;gap:8px;min-height:32px;font-size:var(--text-sm)}
.cb-field .cb-field-k{display:flex;align-items:center;gap:8px;width:130px;flex:none;color:var(--n-500)}
.cb-sec{font-size:var(--text-2xs);font-weight:600;letter-spacing:var(--track-caps);text-transform:uppercase;color:var(--n-500);margin:18px 0 8px}`;
if (typeof document !== "undefined" && !document.getElementById("cb-panel-css")) { const t = document.createElement("style"); t.id = "cb-panel-css"; t.textContent = css; document.head.appendChild(t); }

function Field({ icon, k, children }) {
  return <div className="cb-field"><span className="cb-field-k"><Icon name={icon} size={14} />{k}</span><span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>{children}</span></div>;
}
export function DetailPanel({ item, onClose }) {
  const [tab, setTab] = React.useState("details");
  React.useEffect(() => { setTab("details"); }, [item && item.id]);
  if (!item) return null;
  const isObjective = item.kind === "objective";
  return (
    <aside className="cb-panel">
      <div className="cb-panel-hd">
        <div className="cb-panel-top">
          {item.status ? <StatusFlag status={item.status} size="sm" /> : <HealthChip health={item.health} size="sm" />}
          <span style={{ flex: 1 }}></span>
          <IconButton icon="maximize-2" label="Open full page" size="sm" />
          <IconButton icon="ellipsis" label="More" size="sm" />
          <IconButton icon="x" label="Close" size="sm" onClick={onClose} />
        </div>
        <div className="cb-panel-name"><EntityIcon type={item.kind} swatch={item.swatch} size={20} style={{ marginTop: 4 }} />{item.name}</div>
        <Tabs active={tab} onChange={setTab} items={[{ id: "details", label: "Details" }, { id: "spec", label: "Spec" }, { id: "insights", label: "Insights", count: item.insights || 0 }, { id: "health", label: "Health" }]} />
      </div>
      <div className="cb-panel-bd">
        {tab === "details" ? (
          <div>
            {item.summary ? <AISummary sources={item.sources || "From linked signals"} onRegenerate={() => {}} style={{ marginBottom: 16 }}>{item.summary}</AISummary> : null}
            {item.description ? <p style={{ margin: "0 0 16px", color: "var(--n-700)", lineHeight: "20px" }}>{item.description}</p> : null}
            <div className="cb-sec">Fields</div>
            {item.status ? <Field icon="bookmark" k="Status"><StatusFlag status={item.status} size="sm" /></Field> : null}
            {item.health ? <Field icon="activity" k="Health"><HealthChip health={item.health} size="sm" /></Field> : null}
            <Field icon="briefcase" k="Owner"><Avatar name={item.owner} size={20} /><span>{item.owner}</span></Field>
            {item.team ? <Field icon="users" k="Team">{item.team}</Field> : null}
            <Field icon="calendar" k="Timeframe"><span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{item.timeframe}</span></Field>
            {item.progress != null ? <Field icon="percent" k="Work progress"><ProgressBar value={item.progress} showLabel /></Field> : null}
            {item.objective ? <Field icon="target" k="Objectives"><Tag icon="target">{item.objective}</Tag></Field> : null}
            {item.release ? <Field icon="flag" k="Releases"><Tag icon="flag">{item.release}</Tag></Field> : null}
            {item.krs ? <>
              <div className="cb-sec">Key results</div>
              {item.krs.map((kr) => (
                <div key={kr.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBottom: "1px solid var(--n-100)" }}>
                  <EntityIcon type="keyResult" size={15} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{kr.name}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--n-500)" }}>{kr.current}</span>
                  <HealthChip health={kr.health} size="sm" />
                </div>
              ))}
            </> : null}
          </div>
        ) : tab === "spec" ? (
          <div style={{ color: "var(--n-700)", lineHeight: "20px" }}>
            <div style={{ border: "1px dashed var(--n-300)", borderRadius: "var(--r-lg)", padding: "14px 16px", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}><Icon name="sparkles" size={14} color="var(--synapse-500)" />Draft a spec</div>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginTop: 4 }}>Cerebro writes a delivery-ready spec from the linked signals and strategy context.</div>
            </div>
            <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>Start writing, or type "/" for commands and "@" for mentions.</p>
          </div>
        ) : tab === "insights" ? (
          <div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{item.insights || 0} linked signals inform this item. Newest first.</div>
        ) : (
          <div>{isObjective ? <HealthChip health={item.health} /> : <HealthChip health="none" />}<p style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>Health is reported weekly by the owner.</p></div>
        )}
      </div>
    </aside>
  );
}
