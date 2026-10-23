import { StateMessage } from '@/components/ui/StateMessage';
import { lazy, Suspense, useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import type { FileText } from '@/engine/roots';
import { isFileRefusal, VAULT_ROOT, type FileProbe } from '@/engine/fileBytes';
import { fileActionWords, fileSizeWords } from '@/engine/fileActions';
import { desktopFileActions, probeFile, quickLookFile, readFileText } from '@/lib/rootsIpc';
import { useKeyScope, useCommand } from '@/lib/keys/useKeys';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { CodeViewer } from './CodeViewer';
import { DocViewer } from './DocViewer';
import { viewerFor, type ViewerKind } from './viewers/registry';
import { ViewerToolbar } from './viewers/ViewerToolbar';
import { FileActions } from './viewers/FileActions';
import { ImageViewer } from './viewers/ImageViewer';
import { MediaViewer } from './viewers/MediaViewer';
import { TableViewer } from './viewers/TableViewer';
import { UnknownViewer } from './viewers/UnknownViewer';

const PdfViewer = lazy(() =>
  import('./viewers/PdfViewer').then((module) => ({ default: module.PdfViewer })),
);

type Read = { key: string } & (
  | { state: 'loading' }
  | { state: 'missing' | 'unavailable'; words: string }
  | { state: 'ready'; probe: FileProbe; viewer: ViewerKind; text: FileText | null }
);
export function FileViewer({
  rootId,
  path,
  onPresence,
}: {
  rootId: string;
  path: string;
  onPresence?: (present: boolean) => void;
}) {
  const vault = useVaultStore((s) => (rootId === VAULT_ROOT ? s.vaultPath : null));
  const key = JSON.stringify([rootId, path, vault]);
  const [read, setRead] = useState<Read>({ key: '', state: 'loading' });
  useEffect(() => {
    if (read.key !== key) return;
    if (read.state === 'missing') onPresence?.(false);
    if (read.state === 'ready') onPresence?.(read.text?.kind !== 'notFound');
  }, [key, read, onPresence]);
  const scope = useKeyScope('file-viewer');
  useCommand(
    'viewer.quickLook',
    () => {
      void quickLookFile(rootId, path)
        .then((result) => {
          const words = fileActionWords(result);
          if (words !== null) useUiStore.getState().toast(words);
        })
        .catch(() => useUiStore.getState().toast("Couldn't preview this file"));
    },
    {
      scope,
      when: () =>
        read.key === key &&
        read.state === 'ready' &&
        read.viewer === 'unknown' &&
        desktopFileActions(),
    },
  );
  useEffect(() => {
    let live = true;
    setRead({ key, state: 'loading' });
    void (async () => {
      try {
        const probe = await probeFile(rootId, path);
        if (!live) return;
        if (isFileRefusal(probe)) {
          setRead({
            key,
            state: ['not_found', 'no_such_root', 'folder'].includes(probe.code)
              ? 'missing'
              : 'unavailable',
            words: probe.message,
          });
          return;
        }
        const viewer = viewerFor(path, probe);
        const text = ['doc', 'code', 'table'].includes(viewer)
          ? await readFileText(rootId, path)
          : null;
        if (live) setRead({ key, state: 'ready', probe, viewer, text });
      } catch {
        if (live)
          setRead({
            key,
            state: 'unavailable',
            words: "Couldn't read this file. Try opening it again.",
          });
      }
    })();
    return () => {
      live = false;
    };
  }, [rootId, path, key]);
  let body;
  if (read.key !== key || read.state === 'loading')
    body = <StateMessage state="loading" title="Reading file…" testId="viewer-loading" />;
  else if (read.state === 'missing')
    body = (
      <div data-testid="viewer-not-found" className="p-8">
        <EmptyState icon="file-x" title="File not found" description={path} />
      </div>
    );
  else if (read.state === 'unavailable')
    body = (
      <div data-testid="section-unavailable" className="p-8">
        <EmptyState icon="file-warning" title="File unavailable" description={read.words} />
      </div>
    );
  else if (read.state === 'ready') {
    const { probe, viewer, text } = read;
    let content;
    if (text?.kind === 'notFound')
      content = (
        <div data-testid="viewer-not-found" className="p-8">
          <EmptyState icon="file-x" title="File not found" description={path} />
        </div>
      );
    else if (text?.kind === 'binary')
      content = (
        <div data-testid="viewer-binary" className="p-8">
          <EmptyState icon="file-lock" title="Not a text file" description={path} />
        </div>
      );
    else if (text?.kind === 'tooLarge')
      content = (
        <div data-testid="viewer-too-large" className="p-8">
          <EmptyState
            icon="file-warning"
            title="File too large to display"
            description={`${fileSizeWords(text.size)} — the text viewer stops at ${fileSizeWords(text.limit)}.`}
          />
        </div>
      );
    else if (viewer === 'image')
      content = <ImageViewer key={key} rootId={rootId} path={path} probe={probe} />;
    else if (viewer === 'media')
      content = <MediaViewer key={key} rootId={rootId} path={path} probe={probe} />;
    else if (viewer === 'pdf')
      content = (
        <Suspense fallback={<StateMessage state="loading" title="Opening PDF…" />}>
          <PdfViewer key={key} rootId={rootId} path={path} probe={probe} />
        </Suspense>
      );
    else if (viewer === 'unknown')
      content = <UnknownViewer rootId={rootId} path={path} probe={probe} />;
    else if (text?.kind === 'text')
      content =
        viewer === 'doc' ? (
          <DocViewer rootId={rootId} path={path} content={text.content} />
        ) : viewer === 'table' ? (
          <TableViewer key={key} path={path} content={text.content} />
        ) : (
          <CodeViewer path={path} content={text.content} />
        );
    body = (
      <>
        <ViewerToolbar>
          <FileActions rootId={rootId} path={path} probe={probe} />
        </ViewerToolbar>
        {content}
      </>
    );
  }
  return (
    <scope.Provider>
      <section
        {...scope.props}
        tabIndex={0}
        aria-label={`File ${path.split('/').at(-1)}`}
        className="file-viewer"
      >
        {body}
      </section>
    </scope.Provider>
  );
}
