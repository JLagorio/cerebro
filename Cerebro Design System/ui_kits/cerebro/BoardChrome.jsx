import React from "react";
import { Icon } from "../../components/core/Icon.jsx";
import { IconButton } from "../../components/core/IconButton.jsx";
import { Button } from "../../components/core/Button.jsx";
import { FilterChip } from "../../components/navigation/FilterChip.jsx";
import { EntityIcon } from "../../components/display/EntityIcon.jsx";
const css = `
.cb-view{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.cb-viewhd{padding:14px 20px 0;flex:none}
.cb-viewhd-t{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.cb-viewhd-t h1{margin:0;font-size:var(--text-xl);line-height:var(--leading-xl);font-weight:600;letter-spacing:var(--track-tight)}
.cb-viewhd-t .cb-crumb{color:var(--n-500);font-size:var(--text-sm);display:flex;align-items:center;gap:6px}
.cb-toolbar{display:flex;align-items:center;gap:8px;padding-bottom:12px}
.cb-body{flex:1;overflow:auto;min-height:0}
.cb-grid-head{display:flex;align-items:center;height:var(--row-head-h);border-top:1px solid var(--n-200);border-bottom:1px solid var(--n-200);background:var(--n-25);font-size:var(--text-xs);font-weight:500;color:var(--n-600);position:sticky;top:0;z-index:2}
.cb-grid-head>div{display:flex;align-items:center;gap:6px;padding:0 12px;border-right:1px solid var(--n-100);height:100%}
.cb-grid-head>div:last-child{border-right:none}
.cb-row{display:flex;align-items:center;height:var(--row-h);border-bottom:1px solid var(--n-100);cursor:pointer;transition:background var(--dur-fast) var(--ease-out)}
.cb-row:hover{background:var(--n-50)}
.cb-row-on{background:var(--surface-selected)}
.cb-row-on:hover{background:var(--surface-selected)}
.cb-row>div{padding:0 12px;display:flex;align-items:center;gap:8px;min-width:0}
.cb-row>div.cb-cell-name{flex:1;min-width:240px;font-weight:500;color:var(--n-900)}
.cb-cell-name .cb-name-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cb-grp{display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;background:var(--n-25);border-bottom:1px solid var(--n-100);font-weight:600;font-size:var(--text-sm);color:var(--n-800);position:sticky;top:var(--row-head-h);z-index:1}
.cb-chev{color:var(--n-400);transition:transform var(--dur-fast) var(--ease-out);flex:none}
.cb-chev-open{transform:rotate(90deg)}
.cb-addrow{display:flex;align-items:center;gap:8px;height:40px;padding:0 12px;color:var(--n-500);cursor:pointer;font-size:var(--text-sm)}
.cb-addrow:hover{color:var(--n-700);background:var(--n-25)}
.cb-mono{font-family:var(--font-mono);font-size:11px;color:var(--n-600)}`;
if (typeof document !== "undefined" && !document.getElementById("cb-board-css")) { const t = document.createElement("style"); t.id = "cb-board-css"; t.textContent = css; document.head.appendChild(t); }

export function BoardHeader({ icon, entity, crumb, title, onControls, children }) {
  return (
    <div className="cb-viewhd">
      <div className="cb-viewhd-t">
        {crumb ? <span className="cb-crumb"><Icon name="layers" size={14} />{crumb}<Icon name="chevron-right" size={13} /></span> : null}
        {entity ? <EntityIcon type={entity} size={17} /> : icon ? <Icon name={icon} size={17} color="var(--n-600)" /> : null}
        <h1>{title}</h1>
        <IconButton icon="star" label="Favorite" size="sm" />
        <span style={{ flex: 1 }}></span>
        <IconButton icon="search" label="Search this board" />
        <Button variant="ghost" icon="settings-2" onClick={onControls}>Board controls</Button>
        <Button variant="primary" size="sm">Save</Button>
      </div>
      <div className="cb-toolbar">{children}</div>
    </div>
  );
}
export function DefaultChips() {
  const [scope, setScope] = React.useState("my");
  return (
    <>
      <FilterChip label="My items" active={scope === "my"} onClick={() => setScope("my")} />
      <FilterChip label="Team items" active={scope === "team"} onClick={() => setScope("team")} />
      <span style={{ width: 1, height: 18, background: "var(--n-200)", margin: "0 4px" }}></span>
      <FilterChip icon="list-filter" label="Filtered by" value="Owner" dot onRemove={() => {}} />
      <FilterChip icon="plus" label="Add filter" />
    </>
  );
}
