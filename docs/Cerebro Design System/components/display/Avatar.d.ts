/** Initials avatar with deterministic muted background; AvatarGroup overlaps with +N. */
export interface AvatarProps {
  /** full name; initials derived */
  name: string;
  /** px, default 24 (use 20 in table rows, 28 in headers) */
  size?: number;
  /** optional image url */
  src?: string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Avatar(props: AvatarProps): JSX.Element;
export interface AvatarGroupProps {
  names: string[];
  size?: number;
  /** max shown before +N, default 3 */
  max?: number;
  style?: React.CSSProperties;
  className?: string;
}
export declare function AvatarGroup(props: AvatarGroupProps): JSX.Element;
