import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { keyedCommands } from '@/app/commands';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';

afterEach(cleanup);

it('lists exactly the keyed catalog rows, in group and file order', () => {
  render(<KeyboardShortcutsSettings />);
  const rows = screen.getAllByTestId('shortcut-row');
  expect(rows.map((row) => row.getAttribute('data-command'))).toEqual(
    keyedCommands().map((row) => row.id),
  );
  expect(rows.map((row) => row.getAttribute('data-keys'))).toEqual(
    keyedCommands().map((row) => row.keys.join(', ')),
  );
  expect(screen.getByTestId('settings-shortcuts').id).toBe('keyboard-shortcuts');
  expect(screen.getByText(/Letters never fire while you type/)).toBeTruthy();
});

it('labels desktop-only bindings without hiding them in a browser', () => {
  render(<KeyboardShortcutsSettings />);
  expect(screen.getAllByText('Desktop app')).toHaveLength(
    keyedCommands().filter((row) => row.desktopOnly).length,
  );
});
