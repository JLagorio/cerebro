/** Action button. */
export interface ButtonProps {
  /** "primary" | "secondary" (default) | "ghost" | "danger" */
  variant?: "primary" | "secondary" | "ghost" | "danger";
  /** "sm" 28px | "md" 32px (default) | "lg" 38px */
  size?: "sm" | "md" | "lg";
  /** optional leading lucide icon name */
  icon?: string;
  children?: React.ReactNode;
  fullWidth?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  style?: React.CSSProperties;
  className?: string;
}
export declare function Button(props: ButtonProps): JSX.Element;
