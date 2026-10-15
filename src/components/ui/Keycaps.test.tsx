import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Keycaps, keycapText, keysText } from './Keycaps';

afterEach(cleanup);

describe('Keycaps', () => {
  it('reads a command row and names its original specs', () => {
    const { container } = render(<Keycaps command="palette.open" mac />);
    expect(container.querySelector('[data-keys]')?.getAttribute('data-keys')).toBe('mod+k');
    expect([...container.querySelectorAll('kbd')].map((cap) => cap.textContent)).toEqual([
      '⌘',
      'K',
    ]);
    expect(keycapText('palette.open', true)).toBe('⌘K');
  });

  it('draws chords as two groups and alternatives with or', () => {
    const { container } = render(<Keycaps keys={['g h', 'mod+enter']} mac={false} />);
    expect(container.textContent).toBe('GthenHorCtrlEnter');
    expect(container.querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(
      'G then H or Ctrl+Enter',
    );
    expect(keysText(['g h', 'mod+enter'], false)).toBe('G then H or Ctrl+Enter');
  });

  it('collapses only adjacent ascending digit alternatives with the same modifiers', () => {
    expect(keysText(['mod+1', 'mod+2', 'mod+3', 'mod+shift+4', 'mod+6'], true)).toBe(
      '⌘1–3 or ⇧⌘4 or ⌘6',
    );
    expect(keysText(['2', '1', '3'], false)).toBe('2 or 1 or 3');
    const { container } = render(<Keycaps keys={['1', '2', '3']} />);
    expect(container.querySelector('kbd')?.textContent).toBe('1–3');
  });

  it('uses platform labels for a local dialog shortcut', () => {
    expect(keysText('mod+alt+shift+enter', false)).toBe('Ctrl+Shift+Alt+Enter');
    expect(keysText('mod+enter', true)).toBe('⌘↵');
  });

  it('refuses an unknown command instead of showing a stale hint', () => {
    expect(() => keycapText('not.a.command')).toThrow('unknown command');
  });
});
