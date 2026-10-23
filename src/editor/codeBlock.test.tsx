// @vitest-environment jsdom
import { BlockNoteEditor } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseOption, optionLabels } from '@/test/chooseOption';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import { CODE_LANGUAGES, codeLanguageRow } from './codeBlock';
import { blocksToMarkdownNow, markdownToBlocksNow } from './markdown';

/*
 * BlockNote builds its code block's language picker as a native <select>, and
 * no native select draws anywhere in the app (CV-63). The block renders the
 * design system's Select in its place; these tests hold it there, on a live
 * editor rendering the app's own schema.
 */

let editor: CerebroEditor;
let host: HTMLElement;

/** Each picker renders in a React root of its own, after its node view, and
 *  unmounts a microtask after it. */
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

beforeEach(() => {
  editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
  host = document.createElement('div');
  document.body.append(host);
  act(() => editor.mount(host));
});

afterEach(async () => {
  act(() => editor.unmount());
  await settle();
  document.body.replaceChildren();
});

async function load(markdown: string) {
  act(() => {
    editor.replaceBlocks(editor.document, markdownToBlocksNow(editor, markdown));
  });
  await settle();
}

const pickers = () => within(host).getAllByRole('button', { name: 'Code language' });
const codeBlocks = () => editor.document.filter((b) => b.type === 'codeBlock');
const codeText = (index: number) =>
  host.querySelectorAll('[data-content-type="codeBlock"] code')[index]?.textContent;

describe('the code block language picker', () => {
  it('draws no native select in a rendered code block, and the design system Select in its corner', async () => {
    await load('```ts\nconst a = 1;\n```\n\n```\nnpm install\n```\n\n```toml\n[a]\n```\n');
    expect(host.querySelectorAll('[data-content-type="codeBlock"]')).toHaveLength(3);
    expect(host.querySelector('select')).toBeNull();
    const [ts, bare, toml] = pickers();
    expect(ts.getAttribute('aria-haspopup')).toBe('listbox');
    expect(ts.closest<HTMLElement>('.cb-code-language')?.contentEditable).toBe('false');
    expect([ts, bare, toml].map((p) => [p.textContent, p.getAttribute('data-value')])).toEqual([
      ['TypeScript', 'typescript'],
      ['Plain Text', 'text'],
      // A fence word the list does not know shows as written.
      ['toml', 'toml'],
    ]);
  });

  it("lists BlockNote's own languages, in its order and under its names", async () => {
    await load('```\nnpm install\n```\n');
    const names = Object.values(codeBlockOptions.supportedLanguages).map((l) => l.name);
    expect(optionLabels(pickers()[0])).toEqual(names);
    expect(CODE_LANGUAGES.map((o) => o.value)).toEqual(
      Object.keys(codeBlockOptions.supportedLanguages),
    );
  });

  it('writes the picked language to the block, and a save changes the fence word alone', async () => {
    await load('Intro.\n\n```ts\nconst a = 1;\n```\n\nAfter.\n');
    const before = blocksToMarkdownNow(editor);
    chooseOption(pickers()[0], 'Python');
    await settle();
    expect(editor.document[1].props).toEqual({ language: 'python' });
    expect(blocksToMarkdownNow(editor)).toBe(before.replace('```ts', '```python'));
    expect(pickers()[0].getAttribute('data-value')).toBe('python');
    expect(host.querySelector('select')).toBeNull();
  });

  it('opens an alias and a bare fence as written, and choosing their own row writes nothing', async () => {
    const markdown = '```ts\nconst a = 1;\n```\n\n```\nnpm install\n```\n';
    await load(markdown);
    const saved = blocksToMarkdownNow(editor);
    expect(saved).toBe(markdown);
    chooseOption(pickers()[0], 'TypeScript');
    chooseOption(pickers()[1], 'Plain Text');
    await settle();
    expect(codeBlocks().map((b) => b.props)).toEqual([{ language: 'ts' }, { language: '' }]);
    expect(blocksToMarkdownNow(editor)).toBe(saved);
  });

  it('hands focus to the rebuilt picker after a pick, and after an undo from it', async () => {
    await load('```ts\nconst a = 1;\n```\n');
    act(() => pickers()[0].focus());
    chooseOption(pickers()[0], 'Python');
    await settle();
    expect(document.activeElement).toBe(pickers()[0]);
    expect(pickers()[0].getAttribute('data-value')).toBe('python');
    // Undo and redo still reach the editor's history from the picker.
    fireEvent.keyDown(pickers()[0], { key: 'z', ctrlKey: true });
    await settle();
    expect(editor.document[0].props).toEqual({ language: 'ts' });
    expect(document.activeElement).toBe(pickers()[0]);
  });

  it('keeps every other key on the picker out of the code', async () => {
    await load('```ts\nconst a = 1;\n```\n');
    act(() => editor.setTextCursorPosition(editor.document[0], 'end'));
    // Tab in a code block indents it, and the picker does not use Tab.
    fireEvent.keyDown(pickers()[0], { key: 'Tab' });
    await settle();
    expect(codeText(0)).toBe('const a = 1;');
    expect(editor.document[0].props).toEqual({ language: 'ts' });
  });

  it('is read-only while the editor is, and follows the editor when it unlocks', async () => {
    act(() => {
      editor.isEditable = false;
    });
    await load('```ts\nconst a = 1;\n```\n');
    expect((pickers()[0] as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      editor.isEditable = true;
    });
    await settle();
    expect((pickers()[0] as HTMLButtonElement).disabled).toBe(false);
    act(() => {
      editor.isEditable = false;
    });
    await settle();
    expect((pickers()[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('takes its open list with it when the block goes', async () => {
    await load('```ts\nconst a = 1;\n```\n\nAfter.\n');
    fireEvent.click(pickers()[0]);
    expect(screen.getByRole('listbox')).not.toBeNull();
    act(() => editor.removeBlocks([editor.document[0]]));
    await settle();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(within(host).queryAllByRole('button', { name: 'Code language' })).toEqual([]);
  });

  it("leaves the clipboard's copy of a block without a select or a picker", async () => {
    await load('```ts\nconst a = 1;\n```\n');
    const html = editor.blocksToFullHTML(editor.document);
    expect(html).toContain('const a = 1;');
    expect(html).not.toMatch(/<select|<option|cb-code-language/);
  });
});

describe('codeLanguageRow', () => {
  it.each([
    ['', 'text'],
    ['text', 'text'],
    ['txt', 'text'],
    ['ts', 'typescript'],
    ['typescript', 'typescript'],
    ['sh', 'shellscript'],
    ['toml', 'toml'],
  ])('reads %j as the %j row', (language, row) => {
    expect(codeLanguageRow(language)).toBe(row);
  });
});
