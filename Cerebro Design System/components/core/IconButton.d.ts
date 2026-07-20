/** Icon-only button with mandatory accessible label. */
export interface IconButtonProps {
  /** lucide icon name */
  icon: string;
  /** tooltip + aria-label (required) */
  label: string;
  /** "sm" 24 | "md" 28 (default) | "lg" 32 */
  size?: "sm" | "md" | "lg";
  /** "ghost" (default) | "outline" */
  variant?: "ghost" | "outline";
  /** toggled-on state (cortex tint) */
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function IconButton(props: IconButtonProps): JSX.Element;
