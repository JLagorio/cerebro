/** Modal dialog: flat scrim, radius-14 card, footer actions right-aligned. */
export interface DialogAction { label: string; onClick?: () => void; disabled?: boolean }
export interface DialogProps {
  open: boolean;
  onClose?: () => void;
  title: string;
  children?: React.ReactNode;
  /** max width px, default 560 */
  width?: number;
  primaryAction?: DialogAction;
  secondaryAction?: DialogAction;
  /** muted left-aligned footer text */
  footerNote?: string;
  style?: React.CSSProperties;
}
export declare function Dialog(props: DialogProps): JSX.Element | null;
