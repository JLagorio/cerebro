import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { importBoard, importReportLines } from '@/engine/scene/importBoard';
import { readCanvas, writeCanvas } from '@/engine/scene/jsonCanvas';
import { CARD_SIZES } from '@/engine/boardCards';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { newBoardFile } from './newBoardFile';
import { readMermaidBoard } from './mermaidBoard';
import { measureMermaidBoard } from './measureMermaidBoard';

export function ConvertBoardDialog({
  path,
  code,
  container,
  onClose,
  onConverted,
}: {
  path: string;
  code: string;
  container: HTMLElement | null;
  onClose(): void;
  onConverted(path: string): void;
}) {
  const entries = useVaultStore((state) => state.entries);
  const capture = useVaultActionGuard(JSON.stringify([path, code]));
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const target = path.replace(/\.mmd$/i, '.canvas');
  const planned = useMemo(() => {
    try {
      const read = readMermaidBoard(code, entries);
      if (!read.ok)
        return {
          ok: false as const,
          reason: 'This diagram is not a nonempty manual-layout flowchart.',
        };
      const result = importBoard(read.sketch, {
        measured: measureMermaidBoard(container, code),
        pageCard: CARD_SIZES.page,
      });
      const content = writeCanvas(result.board),
        checked = readCanvas(content);
      if (!checked.ok) return { ok: false as const, reason: checked.message };
      return { ok: true as const, content, lines: importReportLines(result.report) };
    } catch (error) {
      return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
    }
  }, [code, entries, container]);
  const convert = async () => {
    const vault = useVaultStore.getState().vaultPath;
    if (!vault || !planned.ok || busyRef.current) return;
    const current = capture();
    busyRef.current = true;
    setBusy(true);
    try {
      const actual = await newBoardFile(vault, target, planned.content);
      if (!current()) return;
      useUiStore
        .getState()
        .toast(`Made ${actual.split('/').at(-1)}. ${path.split('/').at(-1)} is unchanged.`);
      onClose();
      onConverted(actual);
    } catch (error) {
      if (current())
        useUiStore
          .getState()
          .toast(
            `Couldn't create whiteboard: ${error instanceof Error ? error.message : String(error)}`,
          );
    } finally {
      busyRef.current = false;
      if (live.current) setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Convert to whiteboard"
      primaryAction={{
        label: 'Convert',
        disabled: busy || !planned.ok,
        onClick: () => void convert(),
      }}
      secondaryAction={{ label: 'Cancel', onClick: onClose }}
    >
      <div data-testid="convert-board-dialog" className="space-y-3 text-sm text-n-600">
        <p className="break-words font-mono text-xs">{target}</p>
        {planned.ok ? (
          <ul className="list-disc space-y-2 pl-5">
            {planned.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : (
          <p role="status">{planned.reason}</p>
        )}
      </div>
    </Dialog>
  );
}
