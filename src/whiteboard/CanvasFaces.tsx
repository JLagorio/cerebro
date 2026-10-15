import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { CanvasHeld } from './useCanvasFile';

export function CanvasLoading() {
  return (
    <div data-testid="canvas-loading" className="p-6 text-sm text-n-500">
      Opening whiteboard…
    </div>
  );
}
export function CanvasUnavailable({ reason, preview }: { reason: string; preview: string }) {
  return (
    <div data-testid="canvas-unavailable" className="mx-auto w-full max-w-2xl p-6">
      <EmptyState
        icon="file-warning"
        title="This whiteboard can't be opened"
        description={reason}
      />
      <p className="mt-3 text-center text-sm text-n-500">Cerebro won't change this file.</p>
      {preview !== '' && (
        <details className="mt-5 text-sm text-n-600">
          <summary className="cursor-pointer">The file as it is</summary>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-n-50 p-3 text-xs">
            {preview}
          </pre>
        </details>
      )}
    </div>
  );
}
export function CanvasMissing({ onHome }: { onHome: () => void }) {
  return (
    <div data-testid="canvas-missing" className="flex flex-1 items-center justify-center">
      <EmptyState
        icon="file-x"
        title="This whiteboard no longer exists"
        action={
          <Button variant="secondary" onClick={onHome}>
            Go home
          </Button>
        }
      />
    </div>
  );
}
export function CanvasHeldFace({
  held,
  reload,
}: {
  held: Exclude<CanvasHeld, null>;
  reload: () => Promise<void>;
}) {
  return (
    <div
      data-testid="canvas-held"
      className="flex items-center gap-3 border-b border-n-200 bg-n-50 px-4 py-3 text-sm text-n-700"
    >
      <p className="flex-1">
        {held === 'missing'
          ? 'This board was moved or deleted on disk. Your unsaved changes stay on this page; there is no file to save them to.'
          : "This board changed on disk and Cerebro can't read the new version, so it won't save over it. Your unsaved changes stay on this page."}
      </p>
      <Button variant="secondary" onClick={() => void reload()}>
        Reload
      </Button>
    </div>
  );
}
export function CanvasReadOnly() {
  return (
    <p
      data-testid="canvas-read-only"
      className="border-b border-n-200 px-4 py-2 text-sm text-n-500"
    >
      Knowledge boards are read-only here.
    </p>
  );
}
