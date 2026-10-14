import { pageLinkOf } from '@/engine/pageCard';
import { citationPasteHandler, pastedMarkdown, type PasteContext } from './citationInput';

/**
 * The editor's paste handler (M55.14): a lone page link pasted on an empty
 * line becomes a page card.
 *
 * Only when all of it holds: the paste is not into code, BlockNote would read
 * it as markdown (`text/plain` or `text/markdown` first), it is exactly one
 * wikilink once trimmed, nothing is selected, and the cursor stands in an
 * empty paragraph with no children. The paragraph turns into the card in one
 * step, so ⌘Z gives the empty line back.
 *
 * Everything else goes on to `citationPasteHandler` (M52.4), so a link pasted
 * into text stays an inline link and a pasted citation keeps its markers.
 */
export function pageLinkPasteHandler(ctx: PasteContext): boolean | undefined {
  const { event, editor } = ctx;
  const { selection } = editor.prosemirrorState;
  const inCode = selection.$from.parent.type.spec.code || selection.$to.parent.type.spec.code;
  if (!inCode && selection.empty) {
    const data = pastedMarkdown(event.clipboardData);
    const ref = data === null ? null : pageLinkOf(data);
    if (ref !== null) {
      const { block } = editor.getTextCursorPosition();
      const empty =
        block.type === 'paragraph' &&
        Array.isArray(block.content) &&
        block.content.length === 0 &&
        block.children.length === 0;
      if (empty) {
        editor.updateBlock(block, { type: 'pageCard', props: ref } as never);
        return true;
      }
    }
  }
  return citationPasteHandler(ctx);
}
