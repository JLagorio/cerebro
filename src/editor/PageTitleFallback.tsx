import { useEffect, useRef, useState } from 'react';
import { TextSelection } from 'prosemirror-state';
import type { CerebroEditor } from './MarkdownEditor';
import { hasTitleBlock, spliceTitleIntoBlocks } from './markdown';
import { registerFlush } from './openPages';
import { enterPageBody } from './pageTitleProjection';

/** A filename is only a fallback until the person deliberately gives the
 * document an H1. This field never has a writer or debounce of its own. */
export function PageTitleFallback({
  title,
  editor,
  readOnly,
  bodyVisible = true,
  settleRef,
  flushPendingSave,
}: {
  title: string;
  editor: CerebroEditor;
  readOnly: boolean;
  bodyVisible?: boolean;
  settleRef: React.RefObject<(() => void) | null>;
  flushPendingSave: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(title);
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const pending = useRef(title);
  const baseline = useRef(title);
  useEffect(() => {
    if (!composing.current) {
      pending.current = title;
      baseline.current = title;
      setDraft(title);
    }
  }, [title]);
  // IME text stays in its native input until composition ends. Explicit save
  // and quit still adopt it through the same document before flushing.
  useEffect(() => {
    const settle = () => {
      const value = pending.current.trim();
      if (!readOnly && value !== '' && value !== baseline.current && !hasTitleBlock(editor))
        spliceTitleIntoBlocks(editor, value);
    };
    const unregister = registerFlush(async () => {
      settle();
      await flushPendingSave();
    });
    settleRef.current = settle;
    return () => {
      settleRef.current = null;
      unregister();
      settle();
    };
  }, [editor, readOnly, flushPendingSave, settleRef]);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const fit = () => {
      node.style.height = 'auto';
      node.style.height = `${node.scrollHeight + 2}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [draft]);
  const commit = (enter: boolean, value = draft, offset = value.length) => {
    const next = value.trim();
    if (readOnly || next === '' || (!enter && next === title)) return;
    const origin = ref.current;
    spliceTitleIntoBlocks(editor, next);
    if (enter) {
      if (bodyVisible) {
        enterPageBody(editor, editor.document[0].id, true);
        editor.focus();
      } else {
        origin
          ?.closest('.cb-page-editor-chrome')
          ?.querySelector<HTMLElement>('button, input, [tabindex="0"]')
          ?.focus();
      }
    } else {
      // The first edit adopts the H1 immediately through the document owner.
      // There is no local title draft for quit, navigation or an outside
      // rename to lose. Restore the caret after React removes the fallback.
      requestAnimationFrame(() => {
        const titleBlock = editor.document.find(
          (block) => block.type === 'heading' && block.props.level === 1,
        );
        if (titleBlock === undefined || !editor.domElement?.isConnected) return;
        const active = document.activeElement;
        // A property or page action the person just chose outranks the
        // delayed transfer from the disappearing filename field.
        if (active !== document.body && active !== origin && active !== editor.domElement) return;
        editor.setTextCursorPosition(titleBlock.id, 'start');
        editor.transact((tr) => {
          const at = tr.selection.from + Math.min(offset, next.length);
          tr.setSelection(TextSelection.near(tr.doc.resolve(at)));
        });
        editor.focus();
      });
    }
  };
  return (
    <textarea
      ref={ref}
      data-testid="doc-title-heading"
      aria-label="Document title"
      className="cb-page-title-fallback"
      rows={1}
      value={draft}
      readOnly={readOnly}
      onChange={(event) => {
        pending.current = event.target.value;
        setDraft(event.target.value);
        if (!composing.current && !(event.nativeEvent as InputEvent).isComposing)
          commit(false, event.target.value, event.target.selectionStart);
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        commit(false, event.currentTarget.value, event.currentTarget.selectionStart);
      }}
      onBlur={(event) =>
        commit(false, event.currentTarget.value, event.currentTarget.selectionStart)
      }
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          commit(true);
        } else if (event.key === 'Escape') {
          event.stopPropagation();
          pending.current = title;
          setDraft(title);
        }
      }}
    />
  );
}
