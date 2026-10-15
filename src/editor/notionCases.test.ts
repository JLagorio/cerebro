// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import cases from '../../src-tauri/fixtures/notion-cases.json';
import { splitFrontmatter } from '@/engine/frontmatter';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import { blocksToMarkdown, isLossyImport, markdownToBlocks } from './markdown';

// Rust alone converts fetched Notion bytes. This replay proves every expected
// carrier in src-tauri/fixtures/notion-cases.json opens through the real editor.
let editor: CerebroEditor;
beforeAll(() => {
  editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
});
interface Expected {
  markdown?: string;
  refusal?: { reason: string; words: string };
}
describe('Notion import carriers', () => {
  for (const row of cases.cases) {
    it(row.name, async () => {
      const answer = row.expect as Expected;
      if (!answer.markdown) {
        expect(answer.refusal?.reason).toBeTruthy();
        return;
      }
      const { body } = splitFrontmatter(answer.markdown);
      const blocks = await markdownToBlocks(editor, body);
      const saved = await blocksToMarkdown(editor, blocks);
      expect(isLossyImport(body, saved)).toBe(false);
      const again = await blocksToMarkdown(editor, await markdownToBlocks(editor, saved));
      expect(again).toBe(saved);
    });
  }
});
