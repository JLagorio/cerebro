/** Workflow-status chip with filled flag glyph; also renders bare (glyph only) for group headers. */
export interface StatusFlagProps {
  /** "idea" | "planned" | "progress" | "validation" | "released" | "wontdo" */
  status?: "idea" | "planned" | "progress" | "validation" | "released" | "wontdo";
  /** custom label (for space-specific statuses) */
  label?: string;
  /** custom flag color */
  color?: string;
  /** glyph only, no chip chrome */
  bare?: boolean;
  size?: "sm" | "md";
  style?: React.CSSProperties;
  className?: string;
}
export declare function StatusFlag(props: StatusFlagProps): JSX.Element;
