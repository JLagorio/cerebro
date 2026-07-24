/** 16px checkbox with optional label; supports indeterminate. */
export interface CheckboxProps {
  checked?: boolean;
  indeterminate?: boolean;
  onChange?: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
