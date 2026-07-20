/** Objective/KR health pill: on / risk / off / none. */
export interface HealthChipProps {
  /** "on" | "risk" | "off" | "none" (default) */
  health?: "on" | "risk" | "off" | "none";
  /** override the default label */
  label?: string;
  /** "sm" 20 | "md" 24 (default) */
  size?: "sm" | "md";
  style?: React.CSSProperties;
  className?: string;
}
export declare function HealthChip(props: HealthChipProps): JSX.Element;
