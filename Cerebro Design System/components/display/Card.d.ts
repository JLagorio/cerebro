/** Surface container: white, hairline, radius 10, shadow-sm. */
export interface CardProps {
  children?: React.ReactNode;
  /** drop the shadow (wells, nested cards) */
  flat?: boolean;
  /** lift on hover + pointer cursor */
  hoverable?: boolean;
  /** css padding, default 16 */
  padding?: number | string;
  onClick?: () => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Card(props: CardProps): JSX.Element;
