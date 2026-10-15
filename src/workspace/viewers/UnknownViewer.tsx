import { Icon } from '@/components/ui/Icon';
import { fileLook } from '@/engine/fileKinds';
import { fileSizeWords } from '@/engine/fileActions';
import type { FileProbe } from '@/engine/fileBytes';
import { FileThumb } from '@/components/FileThumb';
export function UnknownViewer({
  rootId = '0',
  path,
  probe,
}: {
  rootId?: string;
  path: string;
  probe: FileProbe;
}) {
  return (
    <div className="unknown-viewer" data-testid="unknown-viewer">
      <Icon name={fileLook(path).icon} size={32} />
      <h2>{path.split('/').at(-1)}</h2>
      <p>{fileSizeWords(probe.size)}</p>
      <FileThumb
        rootId={rootId}
        path={path}
        size={512}
        eager
        caption
        className="inline-flex max-h-96 max-w-full flex-col items-center gap-2"
      />
      <p>
        {probe.open === 'deny'
          ? 'This looks like a program or script. You can reveal or preview it.'
          : 'No preview is available for this kind of file.'}
      </p>
    </div>
  );
}
