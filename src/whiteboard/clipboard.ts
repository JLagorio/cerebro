import { addCards, deleteItems, pasteItems } from '@/engine/scene/commands';
import {
  BOARD_CLIPBOARD_TYPE,
  copyFragment,
  parseFragment,
  serializeFragment,
} from '@/engine/scene/fragments';
import type { SceneEditor } from '@/engine/scene/editor';
import type { Point } from '@/engine/scene/figure';
type Clipboard = Pick<DataTransfer, 'getData' | 'setData' | 'types' | 'files'>;
interface ClipboardEventLike {
  clipboardData: Clipboard | null;
  target: EventTarget | null;
  preventDefault(): void;
}
let memory: { source: string; text: string; pastes: number } | null = null;
export function resetBoardClipboard() {
  memory = null;
}
const editable = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest('input,textarea,[contenteditable="true"],[data-key-claim="editor"]') !== null;

/** Native clipboard events retain user activation. The in-memory copy is only
 * a fallback for WebKit dropping our custom type, and requires matching text. */
export function createBoardClipboard(
  editor: SceneEditor,
  centre: () => Point,
  toast: (words: string) => void,
  color: () => string | null = () => null,
  beforeChange: () => void = () => {},
) {
  const copy = (event: ClipboardEventLike, cut = false) => {
    if (editable(event.target) || !event.clipboardData || editor.selection.size === 0) return;
    const { fragment } = copyFragment(editor.board, editor.selection);
    if (fragment.nodes.length + fragment.ink.length === 0) {
      event.preventDefault();
      toast('Select the connected cards to copy this connection.');
      return;
    }
    const text = fragment.nodes
      .flatMap((node) => (node.type === 'text' ? [node.text] : []))
      .join('\n\n');
    const source = serializeFragment(fragment);
    try {
      event.clipboardData.setData('text/plain', text);
      try {
        event.clipboardData.setData(BOARD_CLIPBOARD_TYPE, source);
      } catch {
        /* WebKit may support only text/plain. */
      }
      memory = { source, text, pastes: 0 };
      event.preventDefault();
      if (cut) {
        beforeChange();
        const result = editor.execute(deleteItems, { keys: [...editor.selection] });
        if (!result.ok) toast(result.refusal.message);
      }
    } catch {
      toast("Couldn't copy the selected whiteboard items.");
    }
  };
  const paste = (event: ClipboardEventLike) => {
    if (editable(event.target) || !event.clipboardData) return;
    try {
      const custom = event.clipboardData.getData(BOARD_CLIPBOARD_TYPE),
        text = event.clipboardData.getData('text/plain');
      const imageOnly =
        !text &&
        (event.clipboardData.files.length > 0 ||
          event.clipboardData.types.some((type) => type.startsWith('image/')));
      const source = custom || (!imageOnly && memory?.text === text ? memory.source : '');
      if (source) {
        event.preventDefault();
        const fragment = parseFragment(source);
        if (!fragment) {
          toast("This clipboard data isn't a readable whiteboard fragment.");
          return;
        }
        const previous = memory?.source === source ? memory.pastes : 0;
        beforeChange();
        const result = editor.execute(pasteItems, { fragment, offset: 24 * (previous + 1) });
        if (!result.ok) {
          toast(result.refusal.message);
          return;
        }
        memory = { source, text, pastes: previous + 1 };
      } else if (text) {
        event.preventDefault();
        const point = centre(),
          height = Math.max(60, Math.min(600, 24 + 20 * text.split('\n').length));
        const paint = color();
        beforeChange();
        const result = editor.execute(addCards, {
          cards: [
            {
              type: 'text',
              shape: 'rectangle',
              text,
              ...(paint ? { color: paint } : {}),
              x: Math.round(point.x - 125),
              y: Math.round(point.y - height / 2),
              width: 250,
              height,
            },
          ],
        });
        if (!result.ok) toast(result.refusal.message);
      } else if (imageOnly) {
        event.preventDefault();
        toast('Image paste is not available here.');
      }
    } catch {
      toast("Couldn't paste the clipboard into this whiteboard.");
    }
  };
  return {
    copy: (event: ClipboardEventLike) => copy(event),
    cut: (event: ClipboardEventLike) => copy(event, true),
    paste,
  };
}
