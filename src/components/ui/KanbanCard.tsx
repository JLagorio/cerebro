import React from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Tag } from '@/components/ui/Tag';
import { Icon } from '@/components/ui/Icon';

const css = `
.cb-kcard{position:relative;background:var(--n-0);border:1px solid var(--n-200);border-radius:var(--r-lg);box-shadow:var(--shadow-xs);padding:10px 12px 10px 15px;cursor:pointer;transition:box-shadow var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out);overflow:hidden}
.cb-kcard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--kc,var(--ent-feature))}
.cb-kcard:hover{box-shadow:var(--shadow-md);border-color:var(--n-300)}
.cb-kcard-title{display:flex;align-items:flex-start;gap:7px;font-size:var(--text-sm);font-weight:500;color:var(--n-900);line-height:18px}
.cb-kcard-meta{display:flex;align-items:center;gap:6px;margin-top:10px;font-size:var(--text-xs);color:var(--text-muted)}
.cb-kcard-tags{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}`;
if (typeof document !== 'undefined' && !document.getElementById('cb-kcard-css')) {
  const t = document.createElement('style');
  t.id = 'cb-kcard-css';
  t.textContent = css;
  document.head.appendChild(t);
}

export interface KanbanCardTag { label: string; icon?: string; color?: string }

/** Kanban column card: 3px swatch edge, entity glyph, timeframe, owner. */
export interface KanbanCardProps {
  title: string;
  /** entity type, default "feature" (M1: kept for API parity, glyph is always the feature square) */
  entity?: string;
  /** left-edge + glyph color, default feature cyan */
  swatch?: string;
  /** e.g. "Aug 2026 → Oct 2026" */
  timeframe?: string;
  /** owner full name (renders Avatar) */
  owner?: string;
  /** linked entity chips */
  tags?: KanbanCardTag[];
  onClick?: () => void;
  style?: React.CSSProperties;
  className?: string;
}

/** M1 adaptation: EntityIcon is not ported; this is its "feature" branch, inlined. */
function EntityGlyph({ swatch, size = 16, style }: { swatch: string; size?: number; style?: React.CSSProperties }) {
  const s = Math.round(size * 0.7);
  return (
    <span
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        verticalAlign: 'middle',
        ...style,
      }}
    >
      <span style={{ width: s, height: s, borderRadius: Math.max(2, s * 0.28), background: swatch }} />
    </span>
  );
}

export function KanbanCard({
  title,
  swatch = 'var(--ent-feature)',
  timeframe,
  owner,
  tags = [],
  onClick,
  style,
  className = '',
}: KanbanCardProps) {
  return (
    <div
      className={`cb-kcard ${className}`}
      onClick={onClick}
      style={{ '--kc': swatch, ...style } as React.CSSProperties}
    >
      <div className="cb-kcard-title">
        <EntityGlyph swatch={swatch} size={16} style={{ marginTop: 1 }} />
        {title}
      </div>
      {tags.length ? (
        <div className="cb-kcard-tags">
          {tags.map((t, i) => (
            <Tag key={i} icon={t.icon} color={t.color}>
              {t.label}
            </Tag>
          ))}
        </div>
      ) : null}
      <div className="cb-kcard-meta">
        {timeframe ? (
          <>
            <Icon name="calendar" size={12} />
            <span>{timeframe}</span>
          </>
        ) : null}
        {owner ? <Avatar name={owner} size={20} style={{ marginLeft: 'auto' }} /> : null}
      </div>
    </div>
  );
}
