/** Removable chip for linked entities and filters. */
export interface TagProps {
  children?: React.ReactNode;
  /** leading swatch dot color, e.g. "var(--swatch-teal)" */
  color?: string;
  /** or a leading lucide icon */
  icon?: string;
  onRemove?: () => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Tag(props: TagProps): JSX.Element;
