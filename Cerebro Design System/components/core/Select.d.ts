/** Native select styled to system controls. */
export interface SelectOption { value: string; label: string }
export interface SelectProps {
  options: SelectOption[];
  value?: string;
  onChange?: (e: any) => void;
  /** "sm" 28 | "md" 32 (default) */
  size?: "sm" | "md";
  disabled?: boolean;
  width?: number | string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Select(props: SelectProps): JSX.Element;
