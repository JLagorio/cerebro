import React from "react";
import { EntityIcon } from "../display/EntityIcon.jsx";
import { Avatar } from "../display/Avatar.jsx";
import { Tag } from "../display/Tag.jsx";
import { Icon } from "../core/Icon.jsx";
const css = `
.cb-kcard{position:relative;background:var(--n-0);border:1px solid var(--n-200);border-radius:var(--r-lg);box-shadow:var(--shadow-xs);padding:10px 12px 10px 15px;cursor:pointer;transition:box-shadow var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out);overflow:hidden}
.cb-kcard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--kc,var(--ent-feature))}
.cb-kcard:hover{box-shadow:var(--shadow-md);border-color:var(--n-300)}
.cb-kcard-title{display:flex;align-items:flex-start;gap:7px;font-size:var(--text-sm);font-weight:500;color:var(--n-900);line-height:18px}
.cb-kcard-meta{display:flex;align-items:center;gap:6px;margin-top:10px;font-size:var(--text-xs);color:var(--text-muted)}
.cb-kcard-tags{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}`;
if (typeof document !== "undefined" && !document.getElementById("cb-kcard-css")) { const t = document.createElement("style"); t.id = "cb-kcard-css"; t.textContent = css; document.head.appendChild(t); }
export function KanbanCard({ title, entity = "feature", swatch = "var(--ent-feature)", timeframe, owner, tags = [], onClick, style, className = "" }) {
  return (
    <div className={`cb-kcard ${className}`} onClick={onClick} style={{ "--kc": swatch, ...style }}>
      <div className="cb-kcard-title"><EntityIcon type={entity} swatch={swatch} size={16} style={{ marginTop: 1 }} />{title}</div>
      {tags.length ? <div className="cb-kcard-tags">{tags.map((t, i) => <Tag key={i} icon={t.icon} color={t.color}>{t.label}</Tag>)}</div> : null}
      <div className="cb-kcard-meta">
        {timeframe ? <><Icon name="calendar" size={12} /><span>{timeframe}</span></> : null}
        {owner ? <Avatar name={owner} size={20} style={{ marginLeft: "auto" }} /> : null}
      </div>
    </div>
  );
}
