/** Kanban column card: 3px swatch edge, entity glyph, timeframe, owner. */
export interface KanbanCardTag { label: string; icon?: string; color?: string }
export interface KanbanCardProps {
  title: string;
  /** entity type, default "feature" */
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
export declare function KanbanCard(props: KanbanCardProps): JSX.Element;
