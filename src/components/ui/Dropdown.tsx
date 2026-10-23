import { Select } from '@/components/ui/Select';

/**
 * DS dropdown (M2 Task 2): the listbox button that replaced native selects in
 * toolbars. It is `Select` now — one implementation, one look — under the
 * prop names its call sites already use (`label` for the accessible name).
 */
export interface DropdownOption {
  value: string;
  label: string;
  /** optional lucide icon rendered before the label */
  icon?: string;
}

export interface DropdownProps {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  /** accessible name for the trigger button */
  label: string;
  /** "sm" 28 | "md" 32 (default) — mirrors Select */
  size?: 'sm' | 'md';
  width?: number | string;
  disabled?: boolean;
  /**
   * Shown while `value` matches no option. The old Dropdown fell back to its
   * first row, which at several call sites is a prompt ("Pick a property…");
   * those name the prompt here, and the rest show nothing rather than a row
   * that is not the value.
   */
  placeholder?: string;
}

export function Dropdown({ label, ...rest }: DropdownProps) {
  return <Select {...rest} ariaLabel={label} />;
}
