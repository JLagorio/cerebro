/** 4px work-progress bar with optional mono % label. */
export interface ProgressBarProps {
  /** 0–100 */
  value: number;
  /** track width px, default 120 */
  width?: number;
  /** "default" cortex | "success" | "warn" | "danger" */
  tone?: "default" | "success" | "warn" | "danger";
  showLabel?: boolean;
  style?: React.CSSProperties;
  className?: string;
}
export declare function ProgressBar(props: ProgressBarProps): JSX.Element;
