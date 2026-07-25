import '@blocknote/mantine/style.css';
import './editor.css';
import { useEffect, useRef, useState } from 'react';
import type { BlockNoteEditor } from '@blocknote/core';
import { BlockNoteSchema, createCodeBlockSpec, defaultBlockSpecs } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { blocksToMarkdown, isLossyImport, markdownToBlocks } from './markdown';

// Default schema with the fully-featured code block (shiki highlighting,
// full language list) swapped in — same block set otherwise.
const cerebroSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
  },
});

export interface MarkdownEditorProps {
  /**
   * Initial markdown BODY — never frontmatter. Uncontrolled after mount:
   * remount with a `key` to load a different document.
   */
  markdown: string;
  /**
   * Called with the serialized markdown, debounced after user edits.
   * Suppressed when serialization matches the last saved form, so opening a
   * document never rewrites it.
   */
  onChange: (markdown: string) => void;
  /**
   * Fires once the document is loaded. `lossyImport` is true when the parse
   * round trip lost textual content (e.g. raw HTML blocks) — consumers
   * should warn before edits overwrite the file.
   */
  onReady?: (info: { editor: BlockNoteEditor; lossyImport: boolean }) => void;
  debounceMs?: number;
  autoFocus?: boolean;
}

export function MarkdownEditor({
  markdown,
  onChange,
  onReady,
  debounceMs = 500,
  autoFocus = false,
}: MarkdownEditorProps) {
  const editor = useCreateBlockNote({ schema: cerebroSchema });
  const [loaded, setLoaded] = useState(false);
  const lastSaved = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const blocks = await markdownToBlocks(editor, markdown);
      if (cancelled) return;
      if (blocks.length > 0) editor.replaceBlocks(editor.document, blocks);
      // Serialized baseline: change events only emit when they diverge from
      // it, so mounting (and the trailing-block plugin) never writes back.
      const roundTripped = await blocksToMarkdown(editor);
      if (cancelled) return;
      lastSaved.current = roundTripped;
      setLoaded(true);
      onReadyRef.current?.({ editor, lossyImport: isLossyImport(markdown, roundTripped) });
    })();
    return () => {
      cancelled = true;
    };
    // `markdown` is the initial value by contract; the editor instance is
    // stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const emitRef = useRef(() => {});
  emitRef.current = () => {
    void blocksToMarkdown(editor).then((md) => {
      if (md === lastSaved.current) return;
      lastSaved.current = md;
      onChangeRef.current(md);
    });
  };

  const scheduleEmit = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      emitRef.current();
    }, debounceMs);
  };

  // Flush a pending debounce on unmount so the last edit isn't lost.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
        emitRef.current();
      }
    },
    [],
  );

  useEffect(() => {
    if (loaded && autoFocus) editor.focus();
  }, [loaded, autoFocus, editor]);

  return (
    <div data-testid="markdown-editor" className="cerebro-editor min-h-0 flex-1">
      {loaded && <BlockNoteView editor={editor} theme="light" onChange={scheduleEmit} />}
    </div>
  );
}
