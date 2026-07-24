/** Toolbar filter/scope pill ("My items", "Filtered by: Owner"). */
export interface FilterChipProps {
  label: string;
  /** bolded value after a colon */
  value?: string;
  icon?: string;
  /** selected state (cortex tint) */
  active?: boolean;
  /** green "modified" dot */
  dot?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function FilterChip(props: FilterChipProps): JSX.Element;
