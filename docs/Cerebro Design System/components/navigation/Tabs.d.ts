/** Underline tabs for detail panels and page sections. */
export interface TabItem { id: string; label: string; icon?: string; count?: number }
export interface TabsProps {
  items: TabItem[];
  active?: string;
  onChange?: (id: string) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Tabs(props: TabsProps): JSX.Element;
