import React from "react";
import { Icon } from "../../components/core/Icon.jsx";
import { IconButton } from "../../components/core/IconButton.jsx";
import { Avatar } from "../../components/display/Avatar.jsx";
import { Badge } from "../../components/display/Badge.jsx";
import { AskBar } from "../../components/ai/AskBar.jsx";
const css = `
.cb-app{display:flex;height:100vh;min-height:560px;min-width:1180px;background:var(--surface-app);font-family:var(--font-ui);font-size:var(--text-sm);line-height:var(--leading-sm);color:var(--text-primary);overflow:hidden}
.cb-rail{width:var(--rail-w);flex:none;border-right:1px solid var(--n-100);display:flex;flex-direction:column;align-items:center;padding:12px 0;gap:4px;background:var(--n-0)}
.cb-rail-mark{width:32px;height:32px;border-radius:var(--r-md);background:var(--cortex-500);color:#fff;font-weight:700;font-size:17px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;letter-spacing:-0.02em;user-select:none}
.cb-rail-it{width:44px;padding:6px 0 5px;border:none;background:none;border-radius:var(--r-md);display:flex;flex-direction:column;align-items:center;gap:3px;color:var(--n-500);font-family:var(--font-ui);font-size:10px;font-weight:500;cursor:pointer;transition:background var(--dur-fast) var(--ease-out)}
.cb-rail-it:hover{background:var(--n-50);color:var(--n-700)}
.cb-rail-it-on{color:var(--cortex-600)}
.cb-rail-it-on:hover{background:var(--cortex-50);color:var(--cortex-600)}
.cb-side{width:var(--sidebar-w);flex:none;background:var(--surface-sunken);border-right:1px solid var(--n-200);display:flex;flex-direction:column;overflow:hidden}
.cb-side-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 12px 8px 16px}
.cb-side-hd h1{margin:0;font-size:var(--text-md);font-weight:600;color:var(--n-900)}
.cb-side-scroll{flex:1;overflow-y:auto;padding:0 8px 16px}
.cb-side-sec{font-size:var(--text-2xs);font-weight:600;letter-spacing:var(--track-caps);text-transform:uppercase;color:var(--n-500);padding:14px 8px 4px}
.cb-nav-it{display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;border-radius:var(--r-sm);color:var(--n-700);cursor:pointer;user-select:none;border:none;background:none;width:100%;font-family:var(--font-ui);font-size:var(--text-sm);text-align:left;transition:background var(--dur-fast) var(--ease-out)}
.cb-nav-it:hover{background:var(--n-100)}
.cb-nav-it-on{background:var(--surface-selected);color:var(--cortex-700);font-weight:500}
.cb-nav-it-on:hover{background:var(--cortex-100)}
.cb-nav-it .cb-nav-count{margin-left:auto;font-size:var(--text-2xs);color:var(--n-500)}
.cb-top{height:var(--topbar-h);flex:none;display:flex;align-items:center;gap:12px;padding:0 16px;border-bottom:1px solid var(--n-200);background:var(--n-0)}
.cb-main{flex:1;display:flex;flex-direction:column;min-width:0}
.cb-canvas{flex:1;display:flex;min-height:0;background:var(--n-0)}
.cb-newbtn{width:30px;height:30px;border-radius:var(--r-md);background:var(--accent);color:#fff;border:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background var(--dur-fast) var(--ease-out)}
.cb-newbtn:hover{background:var(--accent-hover)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-shell-css")) { const t = document.createElement("style"); t.id = "cb-shell-css"; t.textContent = css; document.head.appendChild(t); }

const RAIL = [
  { id: "home", icon: "house", label: "Home" },
  { id: "agent", icon: "sparkles", label: "Agent" },
  { id: "library", icon: "library-big", label: "Library" },
];
export const NAV = [
  { section: "Insights", items: [
    { id: "opportunities", icon: "lightbulb", label: "Opportunities", beta: true, rail: "agent" },
    { id: "knowledge", icon: "message-square-text", label: "Knowledge", count: 5, rail: "library" },
  ] },
  { section: "Product", items: [
    { id: "objectives", icon: "target", label: "Objectives", rail: "home" },
    { id: "initiatives", icon: "diamond", label: "Initiatives", rail: "home" },
    { id: "features", icon: "square-stack", label: "Features", rail: "home" },
  ] },
  { section: "Boards", items: [
    { id: "okr", icon: "table-2", label: "Strategic OKR planning", rail: "home" },
    { id: "roadmap", icon: "calendar-range", label: "Initiatives roadmap", rail: "home" },
    { id: "delivery", icon: "kanban", label: "Delivery board", rail: "home" },
  ] },
  { section: "Agent", items: [
    { id: "agenthome", icon: "sparkles", label: "Cerebro overview", rail: "agent" },
  ] },
];
export function AppShell({ active, onNavigate, children, onAsk }) {
  const activeRail = (NAV.flatMap((s) => s.items).find((i) => i.id === active) || {}).rail || "home";
  return (
    <div className="cb-app">
      <div className="cb-rail">
        <div className="cb-rail-mark" title="Cerebro">c.</div>
        {RAIL.map((r) => (
          <button key={r.id} className={`cb-rail-it ${r.id === activeRail ? "cb-rail-it-on" : ""}`}
            onClick={() => onNavigate && onNavigate(r.id === "agent" ? "agenthome" : r.id === "library" ? "knowledge" : "okr")}>
            <Icon name={r.icon} size={18} strokeWidth={r.id === activeRail ? 2 : 1.75} />{r.label}
          </button>
        ))}
        <div style={{ flex: 1 }}></div>
        <button className="cb-rail-it"><Icon name="settings" size={18} />Settings</button>
      </div>
      <div className="cb-side">
        <div className="cb-side-hd"><h1>Workspace</h1><IconButton icon="panel-left" label="Collapse" size="sm" /></div>
        <div className="cb-side-scroll">
          {NAV.map((sec) => (
            <div key={sec.section}>
              <div className="cb-side-sec">{sec.section}</div>
              {sec.items.map((it) => (
                <button key={it.id} className={`cb-nav-it ${active === it.id ? "cb-nav-it-on" : ""}`} onClick={() => onNavigate && onNavigate(it.id)}>
                  <Icon name={it.icon} size={15} color={active === it.id ? "var(--cortex-600)" : "var(--n-500)"} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.label}</span>
                  {it.beta ? <Badge style={{ marginLeft: "auto" }}>Beta</Badge> : it.count != null ? <span className="cb-nav-count">{it.count}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="cb-main">
        <div className="cb-top">
          <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: "-0.02em" }}>cerebro<span style={{ color: "var(--synapse-500)" }}>.</span></span>
          <div style={{ flex: 1, display: "flex", justifyContent: "center" }}><AskBar width={480} onSubmit={onAsk} /></div>
          <button className="cb-newbtn" title="Create"><Icon name="plus" size={16} /></button>
          <IconButton icon="bell" label="Notifications" />
          <Avatar name="Maya Chen" size={28} />
        </div>
        <div className="cb-canvas">{children}</div>
      </div>
    </div>
  );
}
