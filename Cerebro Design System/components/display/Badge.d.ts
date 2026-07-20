/** Small tonal pill for counts and states ("Beta", "8 items"). */
export interface BadgeProps {
  /** "neutral" (default) | "info" | "success" | "warn" | "danger" | "ai" */
  tone?: "neutral" | "info" | "success" | "warn" | "danger" | "ai";
  /** "tint" (default) | "outline" */
  variant?: "tint" | "outline";
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Badge(props: BadgeProps): JSX.Element;
