import React from "react";
import { Icon } from "../../components/core/Icon.jsx";
import { Button } from "../../components/core/Button.jsx";
import { Input } from "../../components/core/Input.jsx";
import { Select } from "../../components/core/Select.jsx";
import { Switch } from "../../components/core/Switch.jsx";
import { SegmentedControl } from "../../components/core/SegmentedControl.jsx";
import { Card } from "../../components/display/Card.jsx";
import { Badge } from "../../components/display/Badge.jsx";
import { Tag } from "../../components/display/Tag.jsx";
import { Dialog } from "../../components/feedback/Dialog.jsx";
import { OPPORTUNITIES, SKILLS, AUTOMATIONS } from "./data.js";
const css = `
.cb-ag{flex:1;overflow-y:auto;padding:24px 32px;background:var(--surface-board)}
.cb-ag-hd{max-width:960px;margin:0 auto 20px}
.cb-ag-hd h1{margin:0 0 2px;font-size:var(--text-2xl);line-height:var(--leading-2xl);font-weight:600;letter-spacing:var(--track-display)}
.cb-ag-hd p{margin:0;color:var(--text-muted)}
.cb-ag-sec{max-width:960px;margin:0 auto 24px}
.cb-ag-sec>.t{display:flex;align-items:center;gap:8px;font-size:var(--text-md);font-weight:600;margin-bottom:10px}
.cb-ops{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.cb-op-t{display:flex;align-items:flex-start;gap:8px;font-size:var(--text-md);font-weight:600;line-height:20px;margin:8px 0 6px}
.cb-op-s{font-size:var(--text-xs);color:var(--n-600);line-height:18px;flex:1}
.cb-op-src{font-size:var(--text-2xs);color:var(--synapse-600);margin-top:10px}
.cb-op-ft{display:flex;gap:8px;margin-top:12px}
.cb-li{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--n-100)}
.cb-li:last-child{border-bottom:none}
.cb-li .nm{font-weight:500}
.cb-li .ds{font-size:var(--text-xs);color:var(--text-muted)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-ag-css")) { const t = document.createElement("style"); t.id = "cb-ag-css"; t.textContent = css; document.head.appendChild(t); }
const FieldL = ({ label, req, children }) => (
  <div style={{ marginBottom: 14 }}>
    <div style={{ fontSize: "var(--text-sm)", fontWeight: 500, marginBottom: 6 }}>{label}{req ? <span style={{ color: "var(--danger-500)" }}> *</span> : null}</div>
    {children}
  </div>
);
export function AgentHome() {
  const [skills, setSkills] = React.useState(SKILLS);
  const [dlg, setDlg] = React.useState(false);
  const [freq, setFreq] = React.useState("daily");
  return (
    <div className="cb-view">
      <div className="cb-ag">
        <div className="cb-ag-hd">
          <h1>Good morning, Maya</h1>
          <p>Three opportunities surfaced from last week's signals. Every claim links back to its source.</p>
        </div>
        <div className="cb-ag-sec">
          <div className="t"><Icon name="lightbulb" size={16} color="var(--synapse-600)" />This week's opportunities<Badge tone="ai">Generated</Badge></div>
          <div className="cb-ops">
            {OPPORTUNITIES.map((op) => (
              <Card key={op.id} hoverable padding={16} style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", gap: 6 }}><Badge tone="ai">{op.strength}</Badge><Badge>{op.findings} findings</Badge></div>
                <div className="cb-op-t">{op.title}</div>
                <div className="cb-op-s">{op.statement}</div>
                <div className="cb-op-src">{op.sources}</div>
                <div style={{ marginTop: 8 }}><Tag icon="target">{op.okr}</Tag></div>
                <div className="cb-op-ft"><Button size="sm" variant="primary">Learn more</Button><Button size="sm" variant="ghost">Dismiss</Button></div>
              </Card>
            ))}
          </div>
        </div>
        <div className="cb-ag-sec" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "start" }}>
          <div>
            <div className="t"><Icon name="wand-sparkles" size={16} color="var(--n-600)" />Skills</div>
            <Card padding={0} flat>
              {skills.map((sk, i) => (
                <div className="cb-li" key={sk.name}>
                  <Icon name="scroll-text" size={16} color="var(--n-500)" />
                  <div style={{ flex: 1 }}><div className="nm">{sk.name}</div><div className="ds">{sk.desc}</div></div>
                  <Switch checked={sk.enabled} onChange={(v) => setSkills(skills.map((s, j) => (j === i ? { ...s, enabled: v } : s)))} />
                </div>
              ))}
            </Card>
          </div>
          <div>
            <div className="t"><Icon name="clock" size={16} color="var(--n-600)" />Scheduled<Badge>Beta</Badge>
              <span style={{ flex: 1 }}></span><Button size="sm" icon="plus" onClick={() => setDlg(true)}>New automation</Button></div>
            <Card padding={0} flat>
              {AUTOMATIONS.map((a) => (
                <div className="cb-li" key={a.name}>
                  <Icon name="calendar-clock" size={16} color="var(--n-500)" />
                  <div style={{ flex: 1 }}><div className="nm">{a.name}</div><div className="ds">{a.freq} · {a.skill} → {a.output}</div></div>
                  <Switch checked={a.active} />
                </div>
              ))}
            </Card>
          </div>
        </div>
      </div>
      <Dialog open={dlg} onClose={() => setDlg(false)} title="Create scheduled automation" width={620}
        footerNote="Scheduled automations may run with a small delay."
        secondaryAction={{ label: "Cancel", onClick: () => setDlg(false) }}
        primaryAction={{ label: "Create", onClick: () => setDlg(false) }}>
        <FieldL label="Name" req><Input placeholder="Name your automation" width="100%" /></FieldL>
        <FieldL label="Description" req><Input placeholder="Summary of what this automation does" width="100%" /></FieldL>
        <FieldL label="Instructions" req>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginBottom: 6 }}>Tell Cerebro what to do. Pick a skill below to run a predefined workflow.</div>
          <textarea placeholder="Describe what should happen each time the automation runs" style={{ width: "100%", height: 96, resize: "vertical", fontFamily: "var(--font-ui)", fontSize: "var(--text-sm)", color: "var(--text-primary)", border: "1px solid var(--n-300)", borderRadius: "var(--r-md)", padding: "8px 10px", outline: "none", boxSizing: "border-box" }}></textarea>
        </FieldL>
        <FieldL label="Skill"><Select width="100%" options={[{ value: "", label: "Search skills…" }, ...SKILLS.map((s) => ({ value: s.name, label: s.name }))]} /></FieldL>
        <FieldL label="Default output location" req><Select width="100%" options={[{ value: "personal", label: "Personal section" }, { value: "space", label: "Field Platform space" }]} /></FieldL>
        <FieldL label="Scheduled frequency" req>
          <SegmentedControl size="md" value={freq} onChange={setFreq} options={[{ value: "manual", label: "Manual" }, { value: "hourly", label: "Hourly" }, { value: "daily", label: "Daily" }, { value: "weekdays", label: "Weekdays" }, { value: "weekly", label: "Weekly" }]} />
        </FieldL>
        <FieldL label="Select time" req><Input width={140} value="09:00 AM" suffix={<Icon name="clock" size={14} />} /><div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginTop: 6 }}>Times are shown in America/Los_Angeles.</div></FieldL>
      </Dialog>
    </div>
  );
}
