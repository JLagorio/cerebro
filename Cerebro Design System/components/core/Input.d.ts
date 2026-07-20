/** Text input with optional leading icon and suffix node. */
export interface InputProps {
  /** leading lucide icon, e.g. "search" */
  icon?: string;
  placeholder?: string;
  value?: string;
  onChange?: (e: any) => void;
  onKeyDown?: (e: any) => void;
  /** right-side node, e.g. <kbd>⌘K</kbd> */
  suffix?: React.ReactNode;
  /** "sm" 28 | "md" 32 (default) | "lg" 38 */
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  autoFocus?: boolean;
  /** css width, e.g. 280 or "100%" */
  width?: number | string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Input(props: InputProps): JSX.Element;
