import { createCodeBlockSpec, getLanguageId } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Select, type SelectOption } from '@/components/ui/Select';

/**
 * The fully-featured code block (shiki highlighting, the full language list),
 * whose language is empty until someone picks one (M55.15). The package's
 * default is `javascript`, so a bare fence reopened as a JavaScript fence:
 * the save wrote a word the file never had, and the lossy-import check locked
 * the page for it. Empty is what a bare fence means, and the serializer writes
 * it back bare; the picker shows it as Plain Text.
 */
const OPTIONS = { ...codeBlockOptions, defaultLanguage: '' };
const upstream = createCodeBlockSpec(OPTIONS);
const upstreamRender = upstream.implementation.render;

type CodeEditor = Parameters<typeof upstreamRender>[1];

/** The picker's rows: BlockNote's language list, in its order, under its names. */
export const CODE_LANGUAGES: readonly SelectOption[] = Object.entries(
  OPTIONS.supportedLanguages,
).map(([value, { name }]) => ({ value, label: name }));

/**
 * The row a block's language word picks out, read the way the highlighter
 * reads it: a listed id or one of its aliases, so a `ts` fence shows the
 * TypeScript it is highlighted as. Empty is Plain Text. A word the list does
 * not know comes back as itself and matches no row.
 */
export function codeLanguageRow(language: string): string {
  if (language === '') return 'text';
  return getLanguageId(OPTIONS, language) ?? language;
}

function CodeLanguagePicker({
  editor,
  blockId,
  language,
  takeFocus,
}: {
  editor: CodeEditor;
  blockId: string;
  language: string;
  /** The block's previous picker held focus when its node view was rebuilt. */
  takeFocus: boolean;
}) {
  const host = useRef<HTMLSpanElement | null>(null);
  // Read live: unlocking a lossy import makes the page editable without
  // rebuilding its blocks.
  const subscribe = useCallback((changed: () => void) => editor.onChange(changed), [editor]);
  const editable = useSyncExternalStore(subscribe, () => editor.isEditable);

  useEffect(() => {
    if (takeFocus) host.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [takeFocus]);

  return (
    <span
      ref={host}
      // WebKit focuses no button it presses, and the list reads its keys from
      // the focused trigger: without this they would type into the code.
      onMouseDown={(e) => {
        const trigger = host.current?.querySelector('button');
        if (!trigger || trigger.disabled || !trigger.contains(e.target as Node)) return;
        e.preventDefault();
        trigger.focus({ preventScroll: true });
      }}
    >
      <Select
        options={CODE_LANGUAGES}
        value={codeLanguageRow(language)}
        // A fence word the list does not know shows as written.
        placeholder={language}
        onChange={(next) => editor.updateBlock(blockId, { props: { language: next } })}
        ariaLabel="Code language"
        size="sm"
        variant="ghost"
        disabled={!editable}
        testId="code-language"
      />
    </span>
  );
}

/** Undo and redo: the keys ProseMirror still reads on the picker. */
const isHistoryKey = (event: Event): boolean =>
  event instanceof KeyboardEvent && (event.metaKey || event.ctrlKey) && /^[yz]$/i.test(event.key);

/**
 * Whether focus sits in `blockId`'s picker. A language change rebuilds the
 * block's node view, and ProseMirror renders the new one while the old one is
 * still on the page, so the new picker can take focus over, as a native
 * select keeps focus after a pick, and after an undo.
 */
function pickerHasFocus(blockId: string): boolean {
  let active = document.activeElement;
  // An open list holds focus in its own portalled listbox: the picker it
  // belongs to is the trigger that names that list in `aria-controls`.
  const list = active?.closest('[role="listbox"]');
  if (list !== null && list !== undefined && list.id !== '') {
    active =
      [...document.querySelectorAll('[aria-controls]')].find(
        (el) => el.getAttribute('aria-controls') === list.id,
      ) ?? active;
  }
  return (
    active !== null &&
    active !== undefined &&
    active.closest('.cb-code-language') !== null &&
    active.closest('[data-id]')?.getAttribute('data-id') === blockId
  );
}

/**
 * BlockNote's code block, whose render builds its language picker as a native
 * `<select>`, and no native select draws anywhere in the app (CV-63). The
 * render here takes that select out before the block reaches the page and
 * mounts the design system's `Select` in the non-editable corner it sat in,
 * in a React root of its own that lives as long as the block's node view.
 */
export const codeBlockSpec: typeof upstream = {
  ...upstream,
  implementation: {
    ...upstream.implementation,
    render(block, editor) {
      const view = upstreamRender.call(this, block, editor);
      const native = view.dom.querySelector('select');
      const slot = native?.parentElement ?? null;
      native?.remove();
      // A one-off render, the clipboard's copy of a block, keeps no picker.
      if (this.renderType !== 'nodeView' || slot === null) return view;
      slot.classList.add('cb-code-language');
      // The keys a native select kept from the app's keymap (CV-47).
      slot.setAttribute('data-key-claim', 'editor');
      const root = createRoot(slot);
      root.render(
        <CodeLanguagePicker
          editor={editor}
          blockId={block.id}
          language={block.props.language}
          takeFocus={pickerHasFocus(block.id)}
        />,
      );
      const inPicker = (node: EventTarget | null) => node instanceof Node && slot.contains(node);
      // BlockNote hands this object to ProseMirror as the block's node view.
      const nodeView = {
        ...view,
        // A key pressed on the picker is not typing in the code, and a press
        // on it moves no cursor: ProseMirror reads none of its events, except
        // undo and redo, which take a language back like any other edit.
        stopEvent: (event: Event) => inPicker(event.target) && !isHistoryKey(event),
        // The picker's own renders are not a change to the document.
        ignoreMutation: (mutation: { target: Node }) => inPicker(mutation.target),
        destroy: () => {
          view.destroy?.();
          // Deferred: ProseMirror can destroy a node view inside a React
          // commit, where unmounting another root warns and races it.
          queueMicrotask(() => root.unmount());
        },
      };
      return nodeView;
    },
  },
};
