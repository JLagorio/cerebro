import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MessageText } from './MessageMarkdown';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

/**
 * Assistant replies as markdown (M51.5).
 *
 * The panel used to know two things, `[[wikilinks]]` and `**bold**`, and the
 * second swallowed the first — so a bold label naming a note showed its
 * brackets, and every list, heading and backticked value arrived raw.
 */

function show(text: string) {
  const onOpen = vi.fn();
  return { onOpen, ...render(<MessageText text={text} onOpen={onOpen} />) };
}

describe('MessageText', () => {
  beforeEach(() => {
    useVaultStore.setState({
      entries: [
        makeEntry({
          path: 'notes/conflict-model-ships-whole.md',
          filename: 'conflict-model-ships-whole.md',
          folder: 'notes',
          title: 'Conflict model ships whole',
        }),
      ],
    });
  });

  it('opens a wikilink that sits inside bold — the reply that looked raw', () => {
    const { onOpen, container } = show('**New — [[conflict-model-ships-whole]]**');
    const link = screen.getByRole('button', { name: 'Conflict model ships whole' });
    expect(link.closest('strong')).not.toBeNull();
    expect(container.textContent).toBe('New — Conflict model ships whole');
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('conflict-model-ships-whole');
  });

  it('labels an aliased wikilink with its alias and opens its target', () => {
    const { onOpen } = show('See [[risk-scanner-delivery|the scanner risk]] and [[nowhere]].');
    fireEvent.click(screen.getByRole('button', { name: 'the scanner risk' }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('risk-scanner-delivery');
    // Unresolved and unaliased, a link still says what it points at.
    expect(screen.getByRole('button', { name: 'nowhere' })).toBeTruthy();
  });

  it('renders a bullet list, nested by indentation', () => {
    const { container } = show('Open:\n- one\n- two\n  - two a\n- three');
    expect(container.querySelector('p')?.textContent).toBe('Open:');
    const items = [...(container.querySelector('ul')?.children ?? [])];
    expect(items.map((li) => li.firstElementChild?.textContent)).toEqual(['one', 'two', 'three']);
    expect(items[1].querySelector('ul > li')?.textContent).toBe('two a');
  });

  it('renders an ordered list, keeps its start, and nests what models indent', () => {
    const { container } = show('3. three\n4. four\n\n5. five');
    const list = container.querySelector('ol');
    expect(list?.getAttribute('start')).toBe('3');
    // A blank line between items is still one list, still counting.
    expect([...(list?.children ?? [])].map((li) => li.textContent)).toEqual([
      'three',
      'four',
      'five',
    ]);
    cleanup();

    // Two spaces under `1.` — short of CommonMark's content column, and how
    // models indent anyway.
    const nested = show('1. First\n  - detail\n2. Second').container;
    const items = nested.querySelectorAll('ol > li');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('ul')?.textContent).toBe('detail');
  });

  it('renders inline code, markers and all', () => {
    const { container } = show('Set `progress: 5` and `**not bold**`.');
    const code = [...container.querySelectorAll('code')].map((c) => c.textContent);
    expect(code).toEqual(['progress: 5', '**not bold**']);
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).not.toContain('`');
  });

  it('renders a heading at its level', () => {
    show('## Next steps\nShip it.');
    expect(screen.getByRole('heading', { level: 2, name: 'Next steps' })).toBeTruthy();
    expect(screen.getByText('Ship it.').tagName).toBe('P');
  });

  it('renders a fenced block verbatim, without its language', () => {
    const { container } = show('Run:\n```ts\nconst a = **1**;\n  indented();\n```\nDone.');
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe('const a = **1**;\n  indented();');
    expect(pre?.querySelector('strong')).toBeNull();
    expect(screen.getByText('Done.').tagName).toBe('P');
  });

  it('renders an unclosed fence as code to the end, while it streams', () => {
    const { container } = show('Here:\n```\nline one\n**still code');
    expect(container.querySelector('pre')?.textContent).toBe('line one\n**still code');
    expect(container.querySelector('strong')).toBeNull();
  });

  it('leaves an unclosed marker as the characters typed so far', () => {
    const { container, rerender } = show('**foo [[conflict-model');
    expect(container.textContent).toBe('**foo [[conflict-model');
    expect(container.querySelector('strong')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<MessageText text="**foo [[conflict-model-ships-whole]]**" onOpen={vi.fn()} />);
    expect(container.querySelector('strong')?.textContent).toBe('foo Conflict model ships whole');
  });

  it('keeps snake_case names literal', () => {
    const { container } = show('Set stale_after, due_date and __init__, or _really_ do not.');
    expect([...container.querySelectorAll('em')].map((e) => e.textContent)).toEqual(['really']);
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('stale_after, due_date and __init__');
  });

  it('renders a markdown link as an external link', () => {
    show('See [the docs](https://example.com/a_(b)) for more.');
    const link = screen.getByRole('link', { name: 'the docs' });
    expect(link.getAttribute('href')).toBe('https://example.com/a_(b)');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('never links a scheme it would not open', () => {
    const { container } = show('[click me](javascript:alert(1))');
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toBe('click me');
  });

  it('nests code, links and wikilinks inside emphasis', () => {
    const { container } = show(
      '*see `x` and [docs](https://example.com)* then **[[conflict-model-ships-whole]] and `y`**',
    );
    const em = container.querySelector('em') as HTMLElement;
    expect(em.querySelector('code')?.textContent).toBe('x');
    expect(within(em).getByRole('link', { name: 'docs' })).toBeTruthy();
    const strong = container.querySelector('strong') as HTMLElement;
    expect(within(strong).getByRole('button', { name: 'Conflict model ships whole' })).toBeTruthy();
    expect(strong.querySelector('code')?.textContent).toBe('y');
  });

  it('renders a table, a quote, a rule and strikethrough', () => {
    const { container } = show(
      [
        '| Field | Value |',
        '|:--|--:|',
        '| `status` | [[conflict-model-ships-whole|the model]] |',
        '| a \\| b | `a | b` |',
        '',
        '> quoted',
        '> ~~old~~ new',
        '',
        '---',
        'after',
      ].join('\n'),
    );
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getAllByRole('columnheader')[1].style.textAlign).toBe('right');
    const first = within(rows[1]).getAllByRole('cell');
    expect(first[0].querySelector('code')?.textContent).toBe('status');
    // The alias's pipe is the wikilink's, not a column border.
    expect(within(first[1]).getByRole('button', { name: 'the model' })).toBeTruthy();
    expect(
      within(rows[2])
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['a | b', 'a | b']);
    expect(container.querySelector('blockquote del')?.textContent).toBe('old');
    expect(container.querySelector('hr')).not.toBeNull();
    expect(screen.getByText('after').tagName).toBe('P');
  });

  it('breaks a line where the agent did', () => {
    const { container } = show('one\ntwo\n\nthree');
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].querySelectorAll('br')).toHaveLength(1);
  });

  it('renders every prefix of a streaming reply without throwing', () => {
    const reply = [
      '## Plan',
      '',
      '1. **Ship [[conflict-model-ships-whole|the model]]** — `progress: 5`',
      '   - _check_ stale_after',
      '2. See [docs](https://example.com)',
      '',
      '> quoted ~~old~~',
      '',
      '| a | b |',
      '|:--|--:|',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '---',
      'done',
    ].join('\n');
    const { rerender } = render(<MessageText text="" onOpen={vi.fn()} />);
    for (let end = 1; end <= reply.length; end += 1) {
      rerender(<MessageText text={reply.slice(0, end)} onOpen={vi.fn()} />);
    }
    expect(screen.getByRole('heading', { level: 2, name: 'Plan' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'the model' }).closest('strong')).not.toBeNull();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('const x = 1;').tagName).toBe('CODE');
  });
});
