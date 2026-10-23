import { StateMessage } from '@/components/ui/StateMessage';
import { useState } from 'react';
import { FileImage } from '@/components/FileImage';
import { Button } from '@/components/ui/Button';
import { FILE_BYTES, type FileProbe } from '@/engine/fileBytes';
import { useCommands } from '@/lib/keys/useKeys';
export function ImageViewer({
  rootId,
  path,
  probe,
}: {
  rootId: string;
  path: string;
  probe: FileProbe;
}) {
  const [fit, setFit] = useState(true);
  useCommands([
    { id: 'viewer.fit', run: () => setFit(true) },
    { id: 'viewer.actual', run: () => setFit(false) },
  ]);
  if (probe.size > FILE_BYTES.limits.body_bytes)
    return (
      <StateMessage state="partial" title="Image preview unavailable" testId="viewer-too-large">
        This image is over the 64 MiB preview limit.
      </StateMessage>
    );
  return (
    <div data-testid="image-viewer" className="image-viewer" data-fit={fit ? 'fit' : 'actual'}>
      <div className="file-viewer-controls" role="group" aria-label="Image zoom">
        <Button
          size="sm"
          variant={fit ? 'secondary' : 'ghost'}
          aria-pressed={fit}
          onClick={() => setFit(true)}
        >
          Fit
        </Button>
        <Button
          size="sm"
          variant={fit ? 'ghost' : 'secondary'}
          aria-pressed={!fit}
          onClick={() => setFit(false)}
        >
          100%
        </Button>
      </div>
      <div className="image-viewer-frame">
        <FileImage rootId={rootId} path={path} className={fit ? 'image-fit' : 'image-actual'} />
      </div>
    </div>
  );
}
