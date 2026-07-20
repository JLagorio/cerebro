/** Inline segmented control (2–5 options). */
export interface SegmentOption { value: string; label: string; icon?: string }
export interface SegmentedControlProps {
  options: SegmentOption[];
  value?: string;
  onChange?: (value: string) => void;
  /** "sm" 28 total (default) | "md" 32 total */
  size?: "sm" | "md";
  style?: React.CSSProperties;
  className?: string;
}
export declare function SegmentedControl(props: SegmentedControlProps): JSX.Element;
