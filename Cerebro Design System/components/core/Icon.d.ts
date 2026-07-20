/** Lucide line icon (CDN-loaded), 1.75 stroke, currentColor. */
export interface IconProps {
  /** lucide icon name, kebab-case, e.g. "target", "layout-grid" */
  name: string;
  /** px, default 16 */
  size?: number;
  /** default 1.75 */
  strokeWidth?: number;
  /** css color; defaults to currentColor */
  color?: string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Icon(props: IconProps): JSX.Element;
