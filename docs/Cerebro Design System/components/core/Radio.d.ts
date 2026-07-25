/** 16px radio with optional label. */
export interface RadioProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: React.ReactNode;
  name?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Radio(props: RadioProps): JSX.Element;
