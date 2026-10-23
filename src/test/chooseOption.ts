import { fireEvent, screen, within } from '@testing-library/react';

/**
 * Picks an option from the design system's `Select` (or `Dropdown`, which is
 * one): opens the trigger if it is closed, then presses the row. No native
 * `<select>` exists to `change` any more (owner, 2026-10-18), so this is the
 * one way a test chooses a value — by the option's label, or `{ value }` for
 * the stored value.
 */
export function chooseOption(
  trigger: HTMLElement,
  option: string | RegExp | { value: string },
): void {
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const listId = trigger.getAttribute('aria-controls');
  const list =
    (listId === null ? null : document.getElementById(listId)) ?? screen.getByRole('listbox');
  const row =
    typeof option === 'object' && !(option instanceof RegExp)
      ? (within(list)
          .getAllByRole('option')
          .find((candidate) => candidate.getAttribute('data-value') === option.value) ?? null)
      : within(list).getByRole('option', { name: option });
  if (row === null) throw new Error(`No option with the value ${JSON.stringify(option)}`);
  fireEvent.click(row);
}

/** The labels a `Select` lists, read by opening it and closing it again. */
export function optionLabels(trigger: HTMLElement): string[] {
  const wasOpen = trigger.getAttribute('aria-expanded') === 'true';
  if (!wasOpen) fireEvent.click(trigger);
  const listId = trigger.getAttribute('aria-controls');
  const list =
    (listId === null ? null : document.getElementById(listId)) ?? screen.getByRole('listbox');
  const labels = within(list)
    .getAllByRole('option')
    .map(
      (row) => row.querySelector('.cb-select-option-label')?.textContent ?? row.textContent ?? '',
    );
  if (!wasOpen) fireEvent.click(trigger);
  return labels;
}
