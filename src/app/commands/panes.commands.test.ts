import { describe, expect, it } from 'vitest';
import { commandDef } from './index';
import { commands } from './panes.commands';
describe('pane commands', () => {
  it('are discovered as app commands usable from an editor without taking Cmd-W', () => {
    expect(commands.map((row) => row.id)).toEqual([
      'pane.focusNext',
      'pane.focusPrev',
      'pane.close',
    ]);
    for (const row of commands) {
      expect(commandDef(row.id)).toEqual(row);
      expect(row.scope).toBe('app');
      expect(row.inEditor).toBe(true);
      expect(row.keys).not.toContain('mod+w');
    }
  });
});
