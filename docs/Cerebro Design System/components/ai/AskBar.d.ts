/** Global "Search or ask Cerebro" bar — the app's single AI entry point. */
export interface AskBarProps {
  /** default "Search or ask Cerebro" */
  placeholder?: string;
  value?: string;
  onChange?: (e: any) => void;
  onSubmit?: (value: string) => void;
  /** default 520 */
  width?: number | string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function AskBar(props: AskBarProps): JSX.Element;
