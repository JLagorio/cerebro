import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import type { FileText } from '@/engine/roots';
import { viewerKindFor } from '@/engine/roots';
import { readFileText } from '@/lib/rootsIpc';
import { CodeViewer } from './CodeViewer';
import { DocViewer } from './DocViewer';

/** Bytes as a short human string, for the too-large placeholder. */
function humanSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

export function FileViewer({ rootId, path }: { rootId: string; path: string }) {
  const [state, setState] = useState<FileText | null>(null);

  useEffect(() => {
    let live = true;
    setState(null);
    void readFileText(rootId, path).then((out) => {
      if (live) setState(out);
    });
    return () => {
      live = false;
    };
  }, [rootId, path]);

  if (state === null) return <div data-testid="viewer-loading" />;

  // Each refusal gets its own placeholder. Collapsing them into one blank pane
  // would make "too big", "not text" and "gone" indistinguishable — which is
  // the whole reason read_file_text returns typed values instead of strings.
  if (state.kind === 'notFound') {
    return (
      <div data-testid="viewer-not-found" className="p-8">
        <EmptyState icon="file-x" title="File not found" description={path} />
      </div>
    );
  }
  if (state.kind === 'binary') {
    return (
      <div data-testid="viewer-binary" className="p-8">
        <EmptyState icon="file-lock" title="Not a text file" description={path} />
      </div>
    );
  }
  if (state.kind === 'tooLarge') {
    return (
      <div data-testid="viewer-too-large" className="p-8">
        <EmptyState
          icon="file-warning"
          title="File too large to display"
          description={`${humanSize(state.size)} — the viewer stops at ${humanSize(state.limit)}.`}
        />
      </div>
    );
  }

  return viewerKindFor(path) === 'doc' ? (
    <DocViewer rootId={rootId} path={path} content={state.content} />
  ) : (
    <CodeViewer path={path} content={state.content} />
  );
}
