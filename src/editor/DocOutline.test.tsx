// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef, type RefObject } from 'react';
import { BlockNoteEditor } from '@blocknote/core';
import { buildOutline, DocOutline, outlineOf, type OutlineSourceBlock } from './DocOutline';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import { markdownToBlocks } from './markdown';

const MD = '# Title\n\nIntro.\n\n## Section one\n\nText.\n\n### Detail\n\n## Section two\n';

async function makeEditor(md = MD): Promise<CerebroEditor> {
  const editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
  editor.replaceBlocks(editor.document, await markdownToBlocks(editor, md));
  return editor;
}

/** A heading block, as the outline reads one. */
const heading = (id: string, level: number, text: string): OutlineSourceBlock => ({
  id,
  type: 'heading',
  props: { level },
  content: text === '' ? [] : [{ type: 'text', text, styles: {} }],
});

/** H2s named by their ids, upper-cased. */
const sections = (...ids: string[]) => ids.map((id) => heading(id, 2, id.toUpperCase()));

/** All the outline asks of an editor: its blocks and a caret to move. No
 * change feed, as `onChange` is optional to it. */
const stubEditor = (document: OutlineSourceBlock[]) =>
  ({ document, setTextCursorPosition: vi.fn() }) as unknown as CerebroEditor;

const rect = (top: number) =>
  ({ top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: top }) as DOMRect;

/** A scroll container whose top is at 100px, holding a block per id at the
 * viewport top `at` gives it (a block it leaves out is far below). `move` is
 * what a scroll does: it changes the tops the blocks report. */
function page(ids: string[], at: Record<string, number> = {}) {
  const tops = new Map(Object.entries(at));
  const container = document.createElement('div');
  container.getBoundingClientRect = () => rect(100);
  for (const id of ids) {
    const block = document.createElement('div');
    block.setAttribute('data-id', id);
    block.getBoundingClientRect = () => rect(tops.get(id) ?? 10_000);
    container.append(block);
  }
  document.body.append(container);
  const scrollTo = vi.fn();
  container.scrollTo = scrollTo;
  const ref: RefObject<HTMLElement | null> = { current: container };
  const move = (to: Record<string, number>) => {
    for (const [id, top] of Object.entries(to)) tops.set(id, top);
  };
  return { container, ref, scrollTo, move };
}

const show = (
  editor: CerebroEditor,
  { scrollRef = createRef<HTMLElement>(), skipTitle = false } = {},
) => render(<DocOutline editor={editor} scrollRef={scrollRef} skipTitle={skipTitle} />);

const rows = () => screen.getAllByRole('button');
/** The rows marked as the reader's current section. */
const current = () => rows().filter((row) => row.getAttribute('aria-current') === 'location');
const currentNames = () => current().map((row) => row.textContent);
const marks = () => [...screen.getByTestId('doc-outline-rail').children];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('buildOutline', () => {
  it('collects H1-H3 with level and text, skipping deeper and empty headings', async () => {
    const editor = await makeEditor(`${MD}\n#### Too deep\n`);
    const items = buildOutline(editor.document);
    expect(items.map((i) => [i.level, i.text])).toEqual([
      [1, 'Title'],
      [2, 'Section one'],
      [3, 'Detail'],
      [2, 'Section two'],
    ]);
    expect(items.every((i) => i.id.length > 0)).toBe(true);
  });
});

describe('outlineOf', () => {
  it('leaves out the projected title by its id, so a blank title takes no later H1', () => {
    const doc = [
      { id: 'intro', type: 'paragraph', props: {}, content: [] },
      heading('title', 1, ''),
      heading('context', 2, 'Context'),
      heading('appendix', 1, 'Appendix'),
    ];
    expect(outlineOf(doc, { skipTitle: true }).map((i) => i.id)).toEqual(['context', 'appendix']);
  });

  it('drops the first top-level H1 only when the page shows it as its title', async () => {
    const editor = await makeEditor(`## Lead\n\n${MD}\n# Later\n`);
    const texts = (skipTitle: boolean) =>
      outlineOf(editor.document, { skipTitle }).map((i) => i.text);
    expect(texts(true)).toEqual(['Lead', 'Section one', 'Detail', 'Section two', 'Later']);
    expect(texts(false)).toEqual(['Lead', 'Title', ...texts(true).slice(1)]);
  });
});

describe('DocOutline', () => {
  it('draws nothing for fewer than two headings', () => {
    show(stubEditor([heading('title', 1, 'Title'), heading('only', 2, 'Only')]), {
      skipTitle: true,
    });
    expect(screen.queryByTestId('doc-outline')).toBeNull();
    cleanup();
    show(stubEditor([]));
    expect(screen.queryByTestId('doc-outline')).toBeNull();
  });

  it('draws a mark per heading and lists every heading', async () => {
    show(await makeEditor());
    const nav = screen.getByRole('navigation', { name: 'Outline' });
    expect(nav.dataset.testid).toBe('doc-outline');
    expect(screen.getByTestId('doc-outline-rail').getAttribute('aria-hidden')).toBe('true');
    expect(marks().map((mark) => mark.getAttribute('data-level'))).toEqual(['1', '2', '3', '2']);
    const card = within(screen.getByTestId('doc-outline-card'));
    expect(card.getAllByRole('button').map((row) => row.textContent)).toEqual([
      'Title',
      'Section one',
      'Detail',
      'Section two',
    ]);
  });

  it('leaves the page title out of the marks and the list', async () => {
    show(await makeEditor(), { skipTitle: true });
    expect(rows().map((row) => row.textContent)).toEqual(['Section one', 'Detail', 'Section two']);
    expect(marks()).toHaveLength(3);
  });

  it('draws 24 marks at most, and still lists every heading', () => {
    show(stubEditor(Array.from({ length: 30 }, (_, i) => heading(`h${i}`, 2, `Part ${i + 1}`))));
    expect(marks()).toHaveLength(24);
    expect(rows()).toHaveLength(30);
  });

  it('indents the list by level', async () => {
    show(await makeEditor());
    expect(rows().map((row) => [row.dataset.level, row.style.paddingLeft])).toEqual([
      ['1', '10px'],
      ['2', '22px'],
      ['3', '34px'],
      ['2', '22px'],
    ]);
  });

  it('a click moves the caret there, unfocused, marks it current and scrolls it under the top', async () => {
    const editor = await makeEditor();
    const items = buildOutline(editor.document);
    const target = items.find((i) => i.text === 'Section two')!;
    const { container, ref, scrollTo } = page(
      items.map((i) => i.id),
      { [target.id]: 700 },
    );
    container.scrollTop = 500;
    const focus = vi.spyOn(editor, 'focus');
    show(editor, { scrollRef: ref });
    const two = screen.getByRole('button', { name: 'Section two' });
    fireEvent.click(two);
    expect(editor.getTextCursorPosition().block.id).toBe(target.id);
    expect(focus).not.toHaveBeenCalled();
    expect(current()).toEqual([two]);
    expect(marks().map((mark) => mark.hasAttribute('data-active'))).toEqual([
      false,
      false,
      false,
      true,
    ]);
    // 500 already scrolled, 600 under the top, less 24 of air above it.
    expect(scrollTo).toHaveBeenCalledWith({ top: 1076, behavior: 'smooth' });
  });

  it('jumps without the glide for a reader who asked for less motion', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query) =>
        ({ matches: query === '(prefers-reduced-motion: reduce)', media: query }) as MediaQueryList,
    );
    const { ref, scrollTo } = page(['a', 'b'], { b: 400 });
    show(stubEditor(sections('a', 'b')), { scrollRef: ref });
    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 276, behavior: 'auto' });
  });

  it('still scrolls to a heading the editor no longer has, and nothing throws', () => {
    const editor = stubEditor(sections('a', 'b'));
    vi.mocked(editor.setTextCursorPosition).mockImplementation(() => {
      throw new Error('Block with ID b not found');
    });
    const { ref, scrollTo } = page(['a', 'b'], { b: 400 });
    show(editor, { scrollRef: ref });
    const b = screen.getByRole('button', { name: 'B' });
    expect(() => fireEvent.click(b)).not.toThrow();
    expect(editor.setTextCursorPosition).toHaveBeenCalledWith('b', 'start');
    expect(current()).toEqual([b]);
    expect(scrollTo).toHaveBeenCalledWith({ top: 276, behavior: 'smooth' });
  });

  it('a pointer click leaves no focus in the list; a key press keeps it', () => {
    show(stubEditor(sections('a', 'b')));
    const a = screen.getByRole('button', { name: 'A' });
    a.focus();
    fireEvent.click(a, { detail: 0 }); // Enter or Space
    expect(document.activeElement).toBe(a);
    fireEvent.click(a, { detail: 1 }); // the pointer
    expect(document.activeElement).not.toBe(a);
  });

  it('picks up a heading added to the document once typing settles', async () => {
    const editor = await makeEditor();
    vi.useFakeTimers();
    show(editor);
    const last = editor.document[editor.document.length - 1];
    editor.insertBlocks(
      [{ type: 'heading', props: { level: 2 }, content: 'Appendix' }],
      last,
      'after',
    );
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(screen.queryByRole('button', { name: 'Appendix' })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('button', { name: 'Appendix' })).toBeTruthy();
    expect(marks()).toHaveLength(5);
  });

  it('marks the last heading within 90px of the top as the page scrolls', async () => {
    // The container's top is at 100: A is above it, B 50 under it, C exactly 90.
    const { container, ref, move } = page(['a', 'b', 'c', 'd'], { a: 40, b: 150, c: 190, d: 400 });
    show(stubEditor(sections('a', 'b', 'c', 'd')), { scrollRef: ref });
    expect(currentNames()).toEqual(['C']);
    expect(marks().map((mark) => mark.hasAttribute('data-active'))).toEqual([
      false,
      false,
      true,
      false,
    ]);

    move({ a: -400, b: -300, c: -200, d: 150 });
    fireEvent.scroll(container);
    await waitFor(() => expect(currentNames()).toEqual(['D']));

    // Back at the top, where no heading has reached the line: the first.
    move({ a: 300, b: 500, c: 700, d: 900 });
    fireEvent.scroll(container);
    await waitFor(() => expect(currentNames()).toEqual(['A']));
  });

  it('keeps a jumped-to heading current while the page glides there, and after', () => {
    vi.useFakeTimers();
    const { container, ref, move } = page(['a', 'b', 'c', 'd'], {
      a: 100,
      b: 400,
      c: 700,
      d: 1000,
    });
    show(stubEditor(sections('a', 'b', 'c', 'd')), { scrollRef: ref });
    expect(currentNames()).toEqual(['A']);

    // A scroll just before the click (a trackpad's momentum) left a measure
    // waiting for the next frame: it does not undo the click.
    fireEvent.scroll(container);
    fireEvent.click(screen.getByRole('button', { name: 'D' }));
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(currentNames()).toEqual(['D']);

    // On the way there, B passes the line: D stays for as long as the glide
    // goes on, here longer than the 150ms it takes to call one landed.
    move({ a: -200, b: 100, c: 400, d: 700 });
    for (let tick = 0; tick < 3; tick += 1) {
      fireEvent.scroll(container);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(currentNames()).toEqual(['D']);
    }
    // Still for 150ms, the jump has landed, short of the top where the page
    // ends: D stays until the reader scrolls.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(currentNames()).toEqual(['D']);
    fireEvent.scroll(container);
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(currentNames()).toEqual(['B']);
  });

  it('keeps the current heading in view in a list longer than the card', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `h${i}`);
    const at = (first: number) => Object.fromEntries(ids.map((id, i) => [id, first + i * 100]));
    const { container, ref, move } = page(ids, at(300));
    show(stubEditor(ids.map((id, i) => heading(id, 2, `Part ${i + 1}`))), { scrollRef: ref });
    // jsdom lays nothing out: rows of 28px from 6px down, a card showing 280px.
    const card = screen.getByTestId('doc-outline-card');
    rows().forEach((row, i) => {
      Object.defineProperty(row, 'offsetTop', { configurable: true, value: 6 + i * 28 });
      Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 28 });
    });
    Object.defineProperty(card, 'clientHeight', { configurable: true, value: 280 });

    // Part 25 reaches the top: its row's foot comes up to the card's.
    move(at(100 - 24 * 100));
    fireEvent.scroll(container);
    await waitFor(() => expect(card.scrollTop).toBe(6 + 24 * 28 + 28 - 280));
    // Back to the first: its row's head comes down to the card's.
    move(at(300));
    fireEvent.scroll(container);
    await waitFor(() => expect(card.scrollTop).toBe(6));
  });

  it('stops listening when it goes', () => {
    const observer: string[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {
          observer.push('observe');
        }
        unobserve() {}
        disconnect() {
          observer.push('disconnect');
        }
      },
    );
    const { container, ref } = page(['a', 'b']);
    const add = vi.spyOn(container, 'addEventListener');
    const remove = vi.spyOn(container, 'removeEventListener');
    const { unmount } = show(stubEditor(sections('a', 'b')), { scrollRef: ref });
    const [, onScroll, options] = add.mock.calls.find(([type]) => type === 'scroll')!;
    expect(options).toEqual({ passive: true });
    unmount();
    expect(remove).toHaveBeenCalledWith('scroll', onScroll);
    expect(observer).toEqual(['observe', 'disconnect']);
  });

  it('measures without a ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { ref } = page(['a', 'b'], { a: 40, b: 150 });
    show(stubEditor(sections('a', 'b')), { scrollRef: ref });
    expect(currentNames()).toEqual(['B']);
  });

  // WCAG 1.4.13: the card covers text, so Escape puts it away without the
  // pointer or focus having to move. Through layers.ts, never its own keydown.
  it('Escape puts a card the pointer opened away until the pointer leaves', () => {
    show(stubEditor(sections('a', 'b')));
    const nav = screen.getByTestId('doc-outline');
    fireEvent.pointerEnter(nav);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.hasAttribute('data-dismissed')).toBe(true);
    fireEvent.pointerLeave(nav);
    expect(nav.hasAttribute('data-dismissed')).toBe(false);
  });

  it('Escape from the list sends focus into the page, at the caret it left there', () => {
    const editor = {
      ...stubEditor(sections('a', 'b')),
      focus: vi.fn(),
    } as unknown as CerebroEditor;
    show(editor);
    act(() => rows()[1].focus());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect((editor as unknown as { focus: ReturnType<typeof vi.fn> }).focus).toHaveBeenCalled();
    expect(screen.getByTestId('doc-outline').hasAttribute('data-dismissed')).toBe(false);
  });

  it('holds no Escape while the card is put away', () => {
    show(stubEditor(sections('a', 'b')));
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    fireEvent.keyDown(window, { key: 'Escape' });
    // Closed, the outline is not a layer: the key goes on to whoever wants it.
    expect(outer).toHaveBeenCalled();
    window.removeEventListener('keydown', outer);
  });
});

describe('outline.css', () => {
  // Read from disk, as editorCss.test.ts reads editor.css: vitest loads no
  // stylesheet into jsdom.
  const css = readFileSync(join(__dirname, 'outline.css'), 'utf8');

  it('opens the card on hover and on keyboard focus, drawn with tokens alone', () => {
    expect(css).toContain('.cb-doc-outline:hover .cb-doc-outline-card');
    expect(css).toContain('.cb-doc-outline:focus-within .cb-doc-outline-card');
    // A hidden button cannot take focus, and focus is how a key opens it.
    expect(css).not.toMatch(/visibility:\s*hidden/);
    // Movement spends the token reduced motion collapses (tokens/spacing.css).
    expect(css).toContain('var(--dur-move)');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i);
  });

  it('folds a card Escape put away, after the rules that open it', () => {
    const open = css.indexOf('.cb-doc-outline:hover .cb-doc-outline-card');
    const away = css.indexOf('.cb-doc-outline[data-dismissed] .cb-doc-outline-card');
    expect(away).toBeGreaterThan(open);
  });
});
