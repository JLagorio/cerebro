/** Centered empty state: icon well, headline, one helper line, one action. */
export interface EmptyStateProps {
  /** lucide icon, default "inbox" */
  icon?: string;
  title: string;
  description?: string;
  /** action node, typically a <Button> */
  action?: React.ReactNode;
  /** tighter paddings for panels */
  compact?: boolean;
  style?: React.CSSProperties;
  className?: string;
}
export declare function EmptyState(props: EmptyStateProps): JSX.Element;
