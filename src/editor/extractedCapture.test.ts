// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import goldens from '../../src-tauri/fixtures/extract-captures.json';
import { toExtractedDoc } from '@/engine/extracted';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import { blocksToMarkdown, markdownToBlocks, isLossyImport } from './markdown';
let editor: CerebroEditor;
beforeAll(() => {
  editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
});
describe('editable extracted document captures', () => {
  it.each(Object.entries(goldens))(
    'carries the %s golden through two editor saves',
    async (format, outcome) => {
      const { body } = toExtractedDoc({
        filename: `Report.${format}`,
        attachment: `attachments/Report.${format}`,
        at: '2026-10-15',
        extraction: {
          format,
          sha256: 'a'.repeat(64),
          bytes: 100,
          outcome: { state: 'extracted', ...outcome },
        },
      });
      const blocks = await markdownToBlocks(editor, body);
      const first = await blocksToMarkdown(editor, blocks);
      expect(isLossyImport(body, first)).toBe(false);
      const second = await blocksToMarkdown(editor, await markdownToBlocks(editor, first));
      expect(second).toBe(first);
      expect(first).toContain(`![Report.${format}](/attachments/Report.${format})`);
      if (format === 'docx') {
        expect(first).toContain('## Overview');
        expect(first).toContain('4. First');
        expect(blocks.some((block) => block.type === 'table')).toBe(true);
      }
    },
  );
});
