import { createExtension, createStore } from '@blocknote/core';
import { NodeSelection, Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

import type { CerebroEditor } from './MarkdownEditor';

/** First visual body block, including a title's explicitly nested children. */
export function firstPageBody(editor: CerebroEditor, titleId: string) {
  return (
    editor.getBlock(titleId)?.children[0] ?? editor.document.find((block) => block.id !== titleId)
  );
}

/** Enter creates an intentional writing line before a first atomic block;
 * ArrowDown merely selects that block, without mutating it. */
export function enterPageBody(editor: CerebroEditor, titleId: string, writing: boolean) {
  let body = firstPageBody(editor, titleId);
  if (body === undefined) body = editor.insertBlocks([{ type: 'paragraph' }], titleId, 'after')[0];
  else if (writing && editor.schema.blockSchema[body.type].content === 'none')
    body = editor.insertBlocks([{ type: 'paragraph' }], body.id, 'before')[0];
  if (body !== undefined) editor.setTextCursorPosition(body.id, 'start');
}

const key = new PluginKey('cerebroPageTitleProjection');

/** Page chrome is a view-only widget. The real H1 stays in the same document,
 * selection, undo history and Markdown position as every other block. */
export const PageTitleProjection = createExtension(({ editor }) => {
  let host: HTMLElement | null = null;
  let bodyVisible = true;
  const store = createStore({ titleId: null as string | null });

  const titleOf = (doc: typeof editor.prosemirrorState.doc) => {
    let title: { from: number; to: number; start: number; end: number; id: string } | null = null;
    doc.firstChild?.forEach((node, offset) => {
      const heading = node.firstChild;
      if (title === null && heading?.type.name === 'heading' && heading.attrs.level === 1) {
        title = {
          from: offset + 1,
          to: offset + 1 + node.nodeSize,
          start: offset + 3,
          end: offset + 3 + heading.content.size,
          id: String(node.attrs.id),
        };
      }
    });
    return title as { from: number; to: number; start: number; end: number; id: string } | null;
  };

  const plugin = new Plugin({
    key,
    props: {
      decorations(state) {
        if (host === null) return DecorationSet.empty;
        const title = titleOf(state.doc);
        const decorations: Decoration[] = [
          // Inside the title container, after the heading and before its
          // optional child group. Children remain body content below chrome.
          Decoration.widget(title === null ? 1 : title.end + 1, host, {
            key: 'page-chrome',
            side: -1,
            ignoreSelection: true,
            // Property controls and related views own their input, even though
            // their presentation is between two editor blocks.
            stopEvent: () => true,
          }),
        ];
        state.doc.firstChild?.forEach((node, offset) => {
          const from = offset + 1;
          const isTitle = from === title?.from;
          decorations.push(
            Decoration.node(from, from + node.nodeSize, {
              class: isTitle
                ? `cb-page-title-block${bodyVisible ? '' : ' cb-page-title-body-hidden'}`
                : bodyVisible
                  ? ''
                  : 'cb-page-body-hidden',
              ...(isTitle ? { 'data-page-title': 'true' } : {}),
            }),
          );
        });
        return DecorationSet.create(state.doc, decorations);
      },
      handleKeyDown(view, event) {
        if (
          host === null ||
          !editor.isEditable ||
          event.isComposing ||
          event.shiftKey ||
          event.metaKey ||
          event.ctrlKey
        )
          return false;
        const title = titleOf(view.state.doc);
        const { selection } = view.state;
        if (title === null || (!selection.empty && !(selection instanceof NodeSelection)))
          return false;
        const inTitle = selection.from >= title.start && selection.from <= title.end;
        if (inTitle && (event.key === 'Enter' || event.key === 'ArrowDown')) {
          if (event.key === 'ArrowDown') {
            const caret = view.coordsAtPos(selection.from);
            const end = view.coordsAtPos(title.end);
            if (caret.bottom < end.top) return false;
          }
          if (!bodyVisible) {
            event.preventDefault();
            host.querySelector<HTMLElement>('button, input, textarea, [tabindex="0"]')?.focus();
            return true;
          }
          enterPageBody(editor as CerebroEditor, title.id, event.key === 'Enter');
          event.preventDefault();
          return true;
        }
        if (event.key === 'ArrowUp' && bodyVisible && !inTitle) {
          const firstBody = firstPageBody(editor as CerebroEditor, title.id);
          const block = editor.getTextCursorPosition().block;
          if (
            firstBody?.id !== block.id ||
            (!(selection instanceof NodeSelection) && selection.$from.parentOffset !== 0)
          )
            return false;
          view.dispatch(
            view.state.tr.setSelection(TextSelection.create(view.state.doc, title.end)),
          );
          event.preventDefault();
          return true;
        }
        return false;
      },
    },
    view: (view) => {
      const sync = () => {
        const titleId = titleOf(view.state.doc)?.id ?? null;
        if (store.state.titleId !== titleId) store.setState(() => ({ titleId }));
      };
      // The initial document can be loaded before BlockNote mounts its view.
      // A title subscriber must see that document without needing a keystroke.
      sync();
      return { update: sync };
    },
  });

  return {
    key: 'cerebroPageTitleProjection',
    store,
    prosemirrorPlugins: [plugin],
    configure(next: HTMLElement | null, visible: boolean) {
      host = next;
      bodyVisible = visible;
      editor.transact((tr) => tr.setMeta(key, true));
    },
  } as const;
});
