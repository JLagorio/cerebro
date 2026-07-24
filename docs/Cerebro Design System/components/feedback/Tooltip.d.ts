/** Hover tooltip: ink bubble, optional kbd hint. */
export interface TooltipProps {
  content: React.ReactNode;
  /** keyboard hint, e.g. "⌘K" */
  kbd?: string;
  /** "top" (default) | "bottom" */
  side?: "top" | "bottom";
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Tooltip(props: TooltipProps): JSX.Element;
