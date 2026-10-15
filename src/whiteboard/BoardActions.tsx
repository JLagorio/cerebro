import { useRef, useState, type RefObject } from 'react';
import { useStore } from 'zustand';
import type { SceneEditor } from '@/engine/scene/editor';
import type { BoardStore } from './boardState';
import { IconButton } from '@/components/ui/IconButton';
import { MenuItem, MenuSurface } from '@/components/ui/Menu';
import { Popover } from '@/components/ui/Popover';
import { useUiStore } from '@/stores/uiStore';
import { copyChartPng, copyChartSvg, saveChartPng, saveChartSvg } from '@/views/chartExport';
import type { CardTarget } from '@/engine/boardCards';
import { AddCardPopover } from './AddCardPopover';
import { boardExportElement } from './cards/export';

export function BoardActions({
  hostRef,
  name,
  session,
  insertCard,
}: {
  hostRef: RefObject<HTMLElement | null>;
  name: string;
  session?: { editor: SceneEditor; state: BoardStore };
  insertCard?: (target: CardTarget) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const toast = useUiStore((s) => s.toast);
  const act = (kind: 'SVG' | 'PNG', save: boolean) => {
    setOpen(false);
    const host = hostRef.current;
    const svg = host?.querySelector<SVGSVGElement>('[data-testid="wb-scene"]');
    if (!host || !svg) return;
    const prepared = boardExportElement(svg);
    const run = save
      ? kind === 'SVG'
        ? saveChartSvg(prepared, host, `${name}.svg`)
        : saveChartPng(prepared, host, `${name}.png`)
      : kind === 'SVG'
        ? copyChartSvg(prepared, host)
        : copyChartPng(prepared, host);
    void run
      .then((result) => {
        if (result !== null) toast(`${kind} ${save ? 'saved' : 'copied'}`);
      })
      .catch(() => toast(`${save ? 'Save' : 'Copy'} ${kind} failed`));
  };
  return (
    <div
      data-testid="wb-actions"
      data-no-pan="true"
      className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-md border border-n-200 bg-n-0 px-1 py-0.5 shadow-sm"
    >
      {session && <EditActions {...session} />}
      {session && insertCard && (
        <span data-testid="whiteboard-add-card">
          <IconButton
            ref={addButton}
            icon="plus"
            label="Add card"
            size="sm"
            onClick={() => setAdding(true)}
          />
        </span>
      )}
      {adding && (
        <Popover anchorRef={addButton} ariaLabel="Add card" onClose={() => setAdding(false)}>
          <AddCardPopover
            onPick={(target) => {
              if (insertCard?.(target)) setAdding(false);
            }}
          />
        </Popover>
      )}
      <IconButton
        ref={button}
        icon="download"
        label="Export whiteboard"
        size="sm"
        onClick={() => setOpen(true)}
      />
      {open && (
        <Popover
          onClose={() => setOpen(false)}
          anchorRef={button}
          role="menu"
          ariaLabel="Export whiteboard"
        >
          <MenuSurface width={168}>
            <MenuItem label="Copy SVG" onSelect={() => act('SVG', false)} />
            <MenuItem label="Copy PNG" onSelect={() => act('PNG', false)} />
            <MenuItem label="Save PNG…" onSelect={() => act('PNG', true)} />
            <MenuItem label="Save SVG…" onSelect={() => act('SVG', true)} />
          </MenuSurface>
        </Popover>
      )}
    </div>
  );
}

function EditActions({ editor, state }: { editor: SceneEditor; state: BoardStore }) {
  useStore(state, (s) => s.revision);
  const snap = useStore(state, (s) => s.snap);
  const inspector = useStore(state, (s) => s.inspectorOpen);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <span data-testid="wb-inspector-toggle">
        <IconButton
          icon="panel-right"
          label="Whiteboard inspector"
          size="sm"
          active={inspector}
          onClick={() => state.getState().setInspectorOpen(!inspector)}
        />
      </span>
      <span data-testid="wb-undo">
        <IconButton
          icon="undo-2"
          label="Undo in whiteboard"
          size="sm"
          disabled={!editor.canUndo()}
          onClick={() => editor.undo()}
        />
      </span>
      <span data-testid="wb-redo">
        <IconButton
          icon="redo-2"
          label="Redo in whiteboard"
          size="sm"
          disabled={!editor.canRedo()}
          onClick={() => editor.redo()}
        />
      </span>
      <span data-testid="wb-snap">
        <IconButton
          ref={button}
          icon="magnet"
          label="Whiteboard snapping"
          size="sm"
          active={snap.grid || snap.objects}
          onClick={() => setOpen(true)}
        />
      </span>
      {open && (
        <Popover
          anchorRef={button}
          role="menu"
          ariaLabel="Whiteboard snapping"
          onClose={() => setOpen(false)}
        >
          <MenuSurface width={180}>
            <MenuItem
              label="Snap to grid"
              checked={snap.grid}
              onSelect={() => state.getState().setSnap({ ...snap, grid: !snap.grid })}
            />
            <MenuItem
              label="Snap to objects"
              checked={snap.objects}
              onSelect={() => state.getState().setSnap({ ...snap, objects: !snap.objects })}
            />
          </MenuSurface>
        </Popover>
      )}
    </>
  );
}
