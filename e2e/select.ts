import type { Locator } from '@playwright/test';

/**
 * Picks an option from the design system's `Select` in a spec. No native
 * `<select>` draws anywhere (owner, 2026-10-18), so `locator.selectOption`
 * has nothing to act on: open the trigger, then press the row — named by its
 * label, or `{ value }` for the stored value.
 */
export async function chooseOption(
  trigger: Locator,
  option: string | RegExp | { value: string },
): Promise<void> {
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  const page = trigger.page();
  const listId = await trigger.getAttribute('aria-controls');
  const list = listId === null ? page.getByRole('listbox') : page.locator(`[id="${listId}"]`);
  const row =
    typeof option === 'object' && !(option instanceof RegExp)
      ? list.locator(`[role="option"][data-value="${option.value.replace(/"/g, '\\"')}"]`)
      : list.getByRole('option', { name: option, exact: typeof option === 'string' });
  await row.click();
}
