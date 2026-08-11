import { BlockNoteEditor } from '@blocknote/core';
import { describe, expect, it } from 'vitest';
import { cerebroSchema } from './MarkdownEditor';

/**
 * What leaves the app when a selection crosses a custom block (M29.53).
 *
 * BlockNote builds `blocknote/html`, `text/html` and `text/plain` from ONE
 * serializer pass, so a block with no `toExternalHTML` contributes its rendered
 * chrome to all three. MEASURED on demo-vault/strategy/systems-map.md: a
 * drag-select across the first diagram put
 * "FlowchartOpen full screenSave as file…Edit" on the OS clipboard — read back
 * through navigator.clipboard.readText() — with the diagram source nowhere in
 * it, while an in-app paste round-tripped losslessly off the other two
 * flavours. Only what left the app was wrong.
 */
describe('the mermaid block as it leaves the app', () => {
  const code = 'flowchart TD\n  Idea[Idea] --> Build[Build]';

  async function externalHtml(): Promise<string> {
    const editor = BlockNoteEditor.create({ schema: cerebroSchema });
    return editor.blocksToHTMLLossy([{ type: 'mermaid', props: { code } }] as never);
  }

  it('exports the fence, not the block chrome', async () => {
    const html = await externalHtml();
    expect(html).toContain('```mermaid');
    expect(html).toContain('Idea[Idea] --&gt; Build[Build]');
    for (const chrome of ['Open full screen', 'Save as file', 'Edit']) {
      expect(html).not.toContain(chrome);
    }
  });

  it('is the same fence markdown.ts writes to disk, so a paste elsewhere is the source', async () => {
    const html = await externalHtml();
    // The plain-text flavour is derived from this markup, so what a text
    // editor receives is the fence verbatim. Read through a parser rather than
    // a regex: the markup carries the source in an attribute too.
    const text = new DOMParser().parseFromString(html, 'text/html').body.textContent;
    expect(text).toBe(`\`\`\`mermaid\n${code}\n\`\`\``);
  });
});
