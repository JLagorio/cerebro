/** Fixed glyph + color per Cerebro entity type. */
export type EntityType = "product" | "component" | "feature" | "subfeature" | "initiative" | "objective" | "keyResult" | "release" | "releaseGroup" | "company" | "user" | "signal" | "finding" | "opportunity" | "ai";
export interface EntityIconProps {
  type: EntityType;
  /** px box, default 16 */
  size?: number;
  /** override color — used for user-assigned feature/subfeature swatches */
  swatch?: string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function EntityIcon(props: EntityIconProps): JSX.Element;
