// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { isStructured, StructuredValue } from './StructuredValue';

afterEach(cleanup);

/** A frontmatter map drawn as a person reads it — never "[object Object]",
 *  never a JSON string (owner's vault, 2026-10-18). */
describe('StructuredValue', () => {
  it('draws a map as one key and value per line', () => {
    render(<StructuredValue value={{ by: 'claude-code', model: 'opus' }} />);
    const list = screen.getByTestId('structured-value');
    const pairs = [...list.querySelectorAll('dt')].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(pairs).toEqual([
      ['by', 'claude-code'],
      ['model', 'opus'],
    ]);
    expect(list.textContent).not.toContain('[object Object]');
    expect(list.textContent).not.toContain('{');
  });

  it("reads an instant on the reader's clock, and leaves a plain day alone", () => {
    const tz = process.env.TZ;
    process.env.TZ = 'UTC';
    try {
      render(<StructuredValue value={{ at: '2026-07-28T16:42:00Z', day: '2026-07-28' }} />);
      const values = [...screen.getByTestId('structured-value').querySelectorAll('dd')].map(
        (dd) => dd.textContent,
      );
      expect(values).toEqual(['2026-07-28 16:42', '2026-07-28']);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('nests a map under its key, and lists maps one after another', () => {
    render(
      <StructuredValue
        value={[
          { by: 'human:me', at: 'x' },
          { by: 'process:knowledge', scope: { folder: 'notes' } },
        ]}
      />,
    );
    const lists = screen.getAllByTestId('structured-value');
    // The list, its two maps, and the nested one.
    expect(lists).toHaveLength(4);
    expect(lists[0].textContent).toContain('folder');
    expect(lists[0].textContent).toContain('notes');
  });

  it('joins a list of words, and shows a missing value as a dash', () => {
    const { container } = render(<StructuredValue value={['work', 'urgent']} />);
    expect(container.textContent).toBe('work, urgent');
    cleanup();
    render(<StructuredValue value={{ owner: null }} />);
    expect(screen.getByTestId('structured-value').querySelector('dd')?.textContent).toBe('—');
  });

  it('knows which values need it', () => {
    expect(isStructured({ a: 1 })).toBe(true);
    expect(isStructured([{ a: 1 }])).toBe(true);
    expect(isStructured(['a', 'b'])).toBe(false);
    expect(isStructured('text')).toBe(false);
    expect(isStructured(null)).toBe(false);
  });
});
