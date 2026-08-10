import { EmptyState } from '@/components/ui/EmptyState';
import type { Entry, Presentation, Schema } from '@/engine/types';

/**
 * Where a whiteboard tab creates and finds its canvas file (M29.45).
 *
 * `folder` is the folder of the HOST'S OWN file — the `.list.yml`'s folder
 * for a List (which is the collection folder, or '' for a root-level List),
 * the Type doc's folder for a Type screen. The canvas lands in a
 * `whiteboards/` subfolder of it. `viewName` names the file.
 */
export interface WhiteboardHost {
  folder: string;
  viewName: string;
}

export interface WhiteboardViewProps {
  /** The view's own (filtered) records — what "Add record" offers. */
  entries: Entry[];
  presentation: Presentation;
  schema: Schema;
  /** null = a surface that cannot host a canvas (a dashboard block). */
  host: WhiteboardHost | null;
  /** Persists the created file's path onto the view. */
  onPresentationChange?: (next: Presentation) => void;
}

/**
 * A whiteboard tab (M29.45, spec D8): a `.mmd` canvas owned by the view,
 * rendered through the shared full-screen editor. Stub in M29.45 — M29.46
 * adds create-on-open and the canvas; M29.47 adds record chips.
 *
 * `EmptyState` takes a fixed prop list and spreads nothing, so each face is
 * wrapped in the div that carries its test id.
 */
export function WhiteboardView({ host }: WhiteboardViewProps) {
  if (host === null) {
    // A dashboard block reaches here (M29.48 wires the page hosts and leaves
    // the dashboard out): recursion aside, a whiteboard is an EDITOR, and a
    // 300px read-only tile of one would be a picture pretending to be a
    // canvas. `hasBlocks` guards view-in-view nesting; this face guards
    // canvas-in-block.
    return (
      <div data-testid="whiteboard-unavailable" className="flex min-h-0 flex-1">
        <EmptyState
          icon="presentation"
          title="Whiteboards live on their list"
          description="Open the list to draw on this whiteboard — it can't be embedded in a dashboard."
          className="flex-1"
        />
      </div>
    );
  }
  return (
    <div data-testid="whiteboard-creating" className="flex min-h-0 flex-1">
      <EmptyState icon="presentation" title="Preparing canvas…" className="flex-1" />
    </div>
  );
}
