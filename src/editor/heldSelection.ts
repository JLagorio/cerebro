import { createExtension } from '@blocknote/core';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

const key = new PluginKey<DecorationSet>('cerebroHeldSelection');

/** A contextual input can own focus without making its target disappear.
 * This view-only paint maps through transactions and never enters Markdown. */
export const HeldSelection = createExtension(({ editor }) => ({
  key: 'cerebroHeldSelection',
  prosemirrorPlugins: [
    new Plugin<DecorationSet>({
      key,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, previous) =>
          (tr.getMeta(key) as DecorationSet | undefined) ?? previous.map(tr.mapping, tr.doc),
      },
      props: {
        decorations: (state) => key.getState(state),
        handleDOMEvents: {
          blur(view) {
            const { from, to } = view.state.selection;
            if (from !== to)
              view.dispatch(
                view.state.tr.setMeta(
                  key,
                  DecorationSet.create(view.state.doc, [
                    Decoration.inline(from, to, { class: 'cb-held-selection' }),
                  ]),
                ),
              );
            return false;
          },
          focus(view) {
            view.dispatch(view.state.tr.setMeta(key, DecorationSet.empty));
            return false;
          },
        },
      },
    }),
  ],
  hold() {
    editor.transact((tr) => {
      const { from, to } = tr.selection;
      tr.setMeta(
        key,
        from === to
          ? DecorationSet.empty
          : DecorationSet.create(tr.doc, [
              Decoration.inline(from, to, { class: 'cb-held-selection' }),
            ]),
      );
    });
  },
  clear() {
    editor.transact((tr) => tr.setMeta(key, DecorationSet.empty));
  },
}));
