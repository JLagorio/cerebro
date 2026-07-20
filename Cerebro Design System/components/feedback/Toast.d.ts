/** Notification card (position it fixed bottom-left in app shells). */
export interface ToastProps {
  /** "neutral" (default) | "success" | "warn" | "danger" | "ai" */
  tone?: "neutral" | "success" | "warn" | "danger" | "ai";
  title: string;
  description?: string;
  action?: { label: string; onClick?: () => void };
  onDismiss?: () => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Toast(props: ToastProps): JSX.Element;
