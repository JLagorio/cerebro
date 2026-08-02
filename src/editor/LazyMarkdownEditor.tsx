import { lazy, Suspense } from 'react';
import type { MarkdownEditorProps } from './MarkdownEditor';

// BlockNote (and shiki, lazily behind it) is by far the heaviest dependency
// in the app. Consumers import this wrapper — never MarkdownEditor directly —
// so the editor stays off the boot path.
const Inner = lazy(() => import('./MarkdownEditor').then((m) => ({ default: m.MarkdownEditor })));

export function LazyMarkdownEditor(props: MarkdownEditorProps) {
  return (
    <Suspense fallback={<div data-testid="markdown-editor-loading" />}>
      <Inner {...props} />
    </Suspense>
  );
}
