/** 32×18 toggle switch. */
export interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: React.ReactNode;
  disabled?: boolean;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Switch(props: SwitchProps): JSX.Element;
