import { FileImage } from '@/components/FileImage';
import { Icon } from '@/components/ui/Icon';
import { VAULT_ROOT } from '@/engine/fileBytes';
import { fileLook } from '@/engine/fileKinds';
import { isWebUrl } from '@/mermaid/flowchart/linkTargets';
import { MermaidDiagram } from '@/mermaid/MermaidDiagram';
import { useFileText } from './useFileText';

export function DiagramFace({ path, hash }: { path: string; hash: string | null }) {
  const read = useFileText(path, hash);
  return read.state === 'ready' ? (
    <div className="pointer-events-none h-full overflow-hidden" data-testid="whiteboard-diagram">
      <MermaidDiagram code={read.text} collapseHeight={200} />
    </div>
  ) : (
    <p role="status" className="text-xs text-n-500">
      {read.state === 'loading'
        ? 'Opening diagram…'
        : read.state === 'missing'
          ? `No diagram at ${path}`
          : read.reason}
    </p>
  );
}
export function ImageFace({ path }: { path: string }) {
  return <FileImage rootId={VAULT_ROOT} path={path} className="h-full w-full" />;
}
export function FileFace({ path }: { path: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-n-700">
      <Icon name={fileLook(path).icon} size={22} />
      <span className="truncate">{path.split('/').at(-1) ?? path}</span>
    </div>
  );
}
export function LinkFace({ url }: { url: string }) {
  let host = url;
  try {
    host = new URL(url).host || url;
  } catch {
    /* Keep an unreadable pointer visible. */
  }
  return (
    <div className="min-w-0 space-y-2 text-sm text-n-700">
      <div className="truncate">{host}</div>
      {isWebUrl(url) ? (
        <a
          data-board-control="true"
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-cortex-600 underline"
        >
          Open link
        </a>
      ) : (
        <p className="text-xs text-n-500">This link cannot be opened here.</p>
      )}
    </div>
  );
}
export function MissingFace({ path }: { path: string }) {
  const word = /\.canvas$/i.test(path) ? 'whiteboard' : /\.mmd$/i.test(path) ? 'diagram' : 'page';
  return (
    <p className="text-sm text-n-500" role="status">
      No {word} at {path}
    </p>
  );
}
