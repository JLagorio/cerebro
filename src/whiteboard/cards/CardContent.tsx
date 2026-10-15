import { useContext, useEffect, useMemo, useRef } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { ResolvedPageCard } from '@/components/PageCard';
import { requestSection } from '@/editor/sectionLinks';
import { resolveCard } from '@/engine/boardCards';
import type { FileCard, LinkCard } from '@/engine/scene/model';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { WhiteboardEmbed } from '../WhiteboardEmbed';
import { nestingRefusal, WhiteboardAncestry } from '../ancestry';
import { presetPaint } from '../palette';
import { DiagramFace, FileFace, ImageFace, LinkFace, MissingFace } from './faces';

export function CardContent({ node }: { node: FileCard | LinkCard }) {
  const entries = useVaultStore((s) => s.entries),
    schema = useSchema();
  const index = useMemo(() => new Map(entries.map((entry) => [entry.path, entry])), [entries]);
  const face = resolveCard(node, index),
    open = useOpenPath('in-place');
  const ancestors = useContext(WhiteboardAncestry);
  const guarded = face.kind === 'whiteboard' && nestingRefusal(ancestors, face.pointer) !== null;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    const stop = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-board-control]'))
        event.stopPropagation();
    };
    el?.addEventListener('pointerdown', stop);
    return () => el?.removeEventListener('pointerdown', stop);
  }, []);
  const openControl =
    face.kind !== 'link' && face.kind !== 'missing' && !guarded ? (
      <button
        type="button"
        data-testid="whiteboard-card-open"
        data-board-control="true"
        className="flex-none rounded-md border border-n-300 bg-n-0 px-2 py-0.5 text-xs text-n-700 hover:bg-n-50"
        onClick={(event) => {
          event.stopPropagation();
          if (face.section) requestSection(face.pointer, face.section.replace(/^#/, ''));
          open(face.pointer, { newPane: event.metaKey || event.ctrlKey });
        }}
      >
        Open
      </button>
    ) : null;
  return (
    <div
      ref={root}
      data-testid="whiteboard-card"
      data-face={face.kind}
      className="flex h-full min-h-0 flex-col gap-2 overflow-hidden rounded-md border border-n-200 bg-n-0 p-2"
      style={{ borderColor: presetPaint(node.color) ?? undefined }}
    >
      {face.kind === 'page' ? (
        <ResolvedPageCard
          entry={face.entry}
          alias=""
          schema={schema}
          onOpen={open}
          openControl={openControl}
        />
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-hidden">
            {face.kind === 'diagram' ? (
              <DiagramFace path={face.pointer} hash={face.entry.hash} />
            ) : face.kind === 'whiteboard' ? (
              <WhiteboardEmbed
                board={face.pointer}
                height={Math.max(40, node.height - 76)}
                chrome={false}
              />
            ) : face.kind === 'image' ? (
              <ImageFace path={face.pointer} />
            ) : face.kind === 'link' ? (
              <LinkFace url={face.pointer} />
            ) : face.kind === 'missing' ? (
              <MissingFace path={face.pointer} />
            ) : (
              <FileFace path={face.pointer} />
            )}
          </div>
          {openControl && <div className="flex justify-end">{openControl}</div>}
        </>
      )}
      <span className="truncate font-mono text-2xs text-n-500" title={face.pointer}>
        {face.pointer}
        {'section' in face ? face.section : ''}
      </span>
    </div>
  );
}
