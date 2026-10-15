import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NotePathContext } from '@/editor/notePath';
import { useEscapeLayer } from '@/components/ui/Popover';
import { useDragGesture } from '@/hooks/useDragGesture';
import { claimedByHostEditor } from '@/lib/keys/claims';
import { useKeyScope } from '@/lib/keys/useKeys';
import { sheetRestructure, sheetFill } from '@/lib/ipc';
import { expectsReference } from '@/engine/sheet/formulaComplete';
import { useUiStore } from '@/stores/uiStore';
import {
  parseSheetFence,
  sheetNames,
  type SheetComputed,
  type SheetInput,
} from '@/engine/sheet/fence';
import {
  changedSheets,
  clearArea,
  matrixOf,
  mergeRestructure,
  mergeFill,
  fillTarget,
  type FillAxis,
  pasteBlock,
  sameSources,
  setInput,
  type GridChange,
  type Matrix,
  type SheetSource,
} from '@/engine/sheet/gridEdit';
import {
  a1,
  bounds,
  displayExtent,
  edge,
  extend,
  lastUsed,
  move,
  pageStep,
  rangeA1,
  qualified,
  rowHome,
  sheetStart,
  single,
  visibleRows,
  type Cell,
  type Range,
} from '@/engine/sheet/selection';
import { readClipboard, writeClipboard } from './clipboard';
import { FormulaBar } from './FormulaBar';
import { FormulaInput, type FormulaCursor } from './FormulaInput';
import { SheetMenu } from './SheetMenu';
import { SheetExportMenu } from './SheetExportMenu';
import { SheetAsk } from './SheetAsk';
import { sheetCellPresentation } from './SheetView';

interface Draft {
  cell: Cell;
  text: string;
  origin: 'cell' | 'bar';
}
interface Props {
  id: string;
  sources: readonly SheetSource[];
  computed?: SheetComputed;
  onCommit?: (edits: SheetSource[]) => void;
  getSources?: () => readonly SheetSource[];
  getPage?: () => Promise<string>;
  registerDraft?: (flush: () => void) => () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onExit?: () => void;
}
function DraftEscape({ cancel }: { cancel: () => void }) {
  useEscapeLayer(cancel, { kind: 'gesture', modal: false });
  return null;
}
const ROW_HEIGHT = 32;
const VIEW_ROWS = 24;
const rangeFromArea = (area: ReturnType<typeof bounds>): Range => ({
  anchor: { row: area.row, column: area.column },
  active: { row: area.row + area.height - 1, column: area.column + area.width - 1 },
});

/** Selection and drafts belong to this node view; every committed source
 * change belongs to the page. Native events isolate it from ProseMirror. */
export function SheetGrid(props: Props) {
  const notePath = useContext(NotePathContext);
  const [askOpen, setAskOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const cellInput = useRef<HTMLTextAreaElement>(null);
  const barInput = useRef<HTMLTextAreaElement>(null);
  const formulaCursor = useRef<FormulaCursor | null>(null);
  const point = useRef<{
    text: string;
    start: number;
    end: number;
    anchor: Cell;
    result: string;
  } | null>(null);
  const unique = useId();
  const scope = useKeyScope('sheet-grid');
  const drag = useDragGesture();
  const [selection, select] = useState<Range>(() => single(sheetStart()));
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [scroll, setScroll] = useState(0);
  const [busy, setBusy] = useState(false);
  const [fillPreview, setFillPreview] = useState<Range | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const latest = useRef(props);
  latest.current = props;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const index = props.sources.findIndex((sheet) => sheet.id === props.id);
  const prepared = useMemo(() => {
    const parsed = props.sources.map((sheet) => parseSheetFence(sheet.source));
    const names = sheetNames(parsed);
    const inputs: SheetInput[] = parsed.map((item, i) => ({
      name: names[i],
      cells: item.ok ? item.cells : [],
    }));
    return { parsed, names, inputs, matrices: inputs.map((sheet) => matrixOf(sheet.cells)) };
  }, [props.sources]);
  const matrix = prepared.matrices[index] ?? [];
  const used = lastUsed(prepared.inputs[index]?.cells ?? []);
  const extent = displayExtent(
    Math.max(used.row + 1, props.computed?.rows ?? 0, selection.active.row),
    Math.max(used.column + 1, props.computed?.cols ?? 0, selection.active.column),
  );
  const shown = new Map(
    props.computed?.cells.map((cell) => [`${cell.row - 1}:${cell.col - 1}`, cell]),
  );
  const area = bounds(selection);
  const paintedArea = bounds(fillPreview ?? selection);
  const windowRows = visibleRows(
    scroll,
    Math.min(VIEW_ROWS, extent.rows) * ROW_HEIGHT,
    extent.rows,
  );
  const readOnly = props.onCommit === undefined;
  const focus = () => root.current?.focus({ preventScroll: true });
  const fail = (error: unknown) =>
    useUiStore
      .getState()
      .toast(
        `Couldn't change the sheet: ${error instanceof Error ? error.message : String(error)}`,
      );
  const updateDraft = (next: Draft | null) => {
    draftRef.current = next;
    setDraft(next);
  };
  const choose = (next: Range) => {
    selectionRef.current = next;
    select(next);
  };
  const currentSources = () => latest.current.getSources?.() ?? latest.current.sources;
  const commitMatrix = (rows: Matrix, cellSheet = props.id) => {
    const fresh = currentSources();
    const at = fresh.findIndex((sheet) => sheet.id === cellSheet);
    if (at < 0 || !latest.current.onCommit) return;
    const matrices = fresh.map((sheet) => {
      const parsed = parseSheetFence(sheet.source);
      if (!parsed.ok) throw new Error(parsed.message);
      return matrixOf(parsed.cells);
    });
    matrices[at] = rows.map((row) => [...row]);
    latest.current.onCommit(changedSheets(fresh, matrices));
  };
  const commitDraft = () => {
    const pending = draftRef.current;
    if (!pending) return;
    updateDraft(null);
    try {
      const source = currentSources().find((sheet) => sheet.id === latest.current.id)?.source;
      if (source === undefined || !latest.current.onCommit) return;
      const parsed = parseSheetFence(source);
      if (!parsed.ok) throw new Error(parsed.message);
      commitMatrix(setInput(matrixOf(parsed.cells), pending.cell, pending.text));
    } catch (error) {
      fail(error);
    }
  };
  const commitRef = useRef(commitDraft);
  commitRef.current = commitDraft;
  useLayoutEffect(() => {
    mounted.current = true;
    const life = ++generation.current;
    const stillCurrent = () => generation.current === life;
    const unregister = latest.current.registerDraft?.(() => commitRef.current());
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (stillCurrent()) {
          commitRef.current();
          unregister?.();
        }
      });
    };
  }, []);
  useLayoutEffect(() => {
    const pending = draftRef.current;
    if (pending?.origin === 'cell') {
      cellInput.current?.focus();
      const end = pending.text.length;
      cellInput.current?.setSelectionRange(end, end);
    }
  }, [draft?.origin, draft?.cell.row, draft?.cell.column]);
  useLayoutEffect(() => {
    const port = viewport.current;
    if (!port) return;
    const top = selection.active.row * ROW_HEIGHT;
    if (top < port.scrollTop) port.scrollTop = top;
    else if (top + ROW_HEIGHT > port.scrollTop + port.clientHeight - ROW_HEIGHT)
      port.scrollTop = Math.max(0, top + ROW_HEIGHT - port.clientHeight + ROW_HEIGHT);
    if (root.current?.contains(document.activeElement))
      root.current
        ?.querySelector<HTMLElement>(`[data-cell="${a1(selection.active)}"]`)
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selection.active]);
  const startEdit = (text?: string, origin: 'cell' | 'bar' = 'cell') => {
    if (readOnly || busy) return;
    const cell = selectionRef.current.active;
    updateDraft({ cell, text: text ?? matrix[cell.row]?.[cell.column] ?? '', origin });
  };
  const clear = () => {
    if (!readOnly)
      try {
        commitMatrix(clearArea(matrix, bounds(selectionRef.current)));
      } catch (error) {
        fail(error);
      }
  };
  const cancel = () => {
    point.current = null;
    updateDraft(null);
    focus();
  };
  const moveTo = (cell: Cell, shift = false) => {
    choose(shift ? extend(selectionRef.current, cell) : single(cell));
    focus();
  };
  const inputKey = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && event.altKey) {
      event.preventDefault();
      const input = event.target as HTMLInputElement | HTMLTextAreaElement;
      const value = draftRef.current?.text ?? input.value;
      const start = input.selectionStart ?? value.length;
      const end = input.selectionEnd ?? start;
      if (draftRef.current)
        updateDraft({ ...draftRef.current, text: value.slice(0, start) + '\n' + value.slice(end) });
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const cell = draftRef.current?.cell ?? selectionRef.current.active;
      commitDraft();
      moveTo(
        move(
          cell,
          event.key === 'Enter' ? (event.shiftKey ? -1 : 1) : 0,
          event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : 0,
        ),
      );
    }
  };
  const restructure = async (change: GridChange, at: number, count: number) => {
    if (readOnly || busy) return;
    commitDraft();
    const before = currentSources().map((sheet) => ({ ...sheet }));
    const parsed = before.map((sheet) => parseSheetFence(sheet.source));
    const broken = parsed.find((item) => !item.ok);
    if (broken && !broken.ok) {
      fail(broken.message);
      return;
    }
    const names = sheetNames(parsed);
    const inputs = parsed.map((item, i) => ({ name: names[i], cells: item.ok ? item.cells : [] }));
    const sheet = before.findIndex((item) => item.id === props.id);
    const life = generation.current;
    setBusy(true);
    try {
      const result = await sheetRestructure(inputs, sheet, change, at, count);
      if (!mounted.current || generation.current !== life) return;
      if (!sameSources(before, currentSources())) {
        useUiStore
          .getState()
          .toast('The sheet changed while that ran, so nothing changed. Try again.');
        return;
      }
      const matrices = mergeRestructure(
        inputs.map((item) => matrixOf(item.cells)),
        sheet,
        change,
        at,
        count,
        result,
      );
      latest.current.onCommit?.(changedSheets(before, matrices));
      focus();
    } catch (error) {
      if (mounted.current && generation.current === life) fail(error);
    } finally {
      if (mounted.current && generation.current === life) setBusy(false);
    }
  };
  const fill = async (area: ReturnType<typeof bounds>, axis: FillAxis, to: number) => {
    if (readOnly || busy) return;
    commitDraft();
    const before = currentSources().map((sheet) => ({ ...sheet }));
    const parsed = before.map((sheet) => parseSheetFence(sheet.source));
    if (parsed.some((item) => !item.ok)) return;
    const names = sheetNames(parsed);
    const inputs = parsed.map((item, i) => ({ name: names[i], cells: item.ok ? item.cells : [] }));
    const sheet = before.findIndex((item) => item.id === props.id);
    const life = generation.current;
    setBusy(true);
    try {
      const result = await sheetFill(inputs, sheet, area, axis, to);
      if (!mounted.current || generation.current !== life) return;
      if (!sameSources(before, currentSources())) {
        useUiStore
          .getState()
          .toast('The sheet changed while that ran, so nothing changed. Try again.');
        return;
      }
      const matrices = inputs.map((item) => matrixOf(item.cells));
      matrices[sheet] = mergeFill(matrices[sheet], area, axis, to, result);
      latest.current.onCommit?.(changedSheets(before, matrices));
      const target = fillTarget(
        area,
        axis === 'rows' ? { row: to, column: area.column } : { row: area.row, column: to },
      );
      if (target) choose(rangeFromArea(target.area));
      focus();
    } catch (error) {
      if (mounted.current && generation.current === life) fail(error);
    } finally {
      if (mounted.current && generation.current === life) setBusy(false);
    }
  };
  const pointAt = (cell: Cell, extend: boolean): boolean => {
    const pending = draftRef.current;
    if (!pending || readOnly) return false;
    const old = point.current;
    const cursor = formulaCursor.current;
    let insertion = old && old.result === pending.text && extend ? old : null;
    if (!insertion) {
      if (!cursor || cursor.text !== pending.text || !expectsReference(cursor.context))
        return false;
      const input = pending.origin === 'cell' ? cellInput.current : barInput.current;
      const start = input?.selectionStart ?? cursor.cursor;
      insertion = {
        text: pending.text,
        start,
        end: input?.selectionEnd ?? start,
        anchor: cell,
        result: '',
      };
    }
    const reference = rangeA1({ anchor: insertion.anchor, active: cell });
    const text =
      insertion.text.slice(0, insertion.start) + reference + insertion.text.slice(insertion.end);
    point.current = { ...insertion, result: text };
    updateDraft({ ...pending, text });
    const input = pending.origin === 'cell' ? cellInput.current : barInput.current;
    const end = insertion.start + reference.length;
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(end, end);
    });
    return true;
  };
  const handlers = useRef({
    startEdit,
    commitDraft,
    inputKey,
    clear,
    restructure,
    matrix,
    shown,
    readOnly,
    choose,
    moveTo,
    fill,
    pointAt,
  });
  handlers.current = {
    startEdit,
    commitDraft,
    inputKey,
    clear,
    restructure,
    matrix,
    shown,
    readOnly,
    choose,
    moveTo,
    fill,
    pointAt,
  };
  const commitMatrixRef = useRef(commitMatrix);
  commitMatrixRef.current = commitMatrix;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const key = (event: KeyboardEvent) => {
      const h = handlers.current;
      if (
        claimedByHostEditor(event) ||
        ((event.metaKey || event.ctrlKey) && event.key.startsWith('Arrow'))
      )
        event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        h.inputKey(event);
        return;
      }
      if (event.target !== element) return;
      const selected = selectionRef.current;
      const cell = selected.active;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        if (h.readOnly) return;
        (event.key.toLowerCase() === 'y' || event.shiftKey
          ? latest.current.onRedo
          : latest.current.onUndo)?.();
        focus();
        return;
      }
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        const cells = h.matrix.flatMap((row, r) =>
          row.flatMap((source, c) => (source ? [{ row: r + 1, col: c + 1, source }] : [])),
        );
        h.choose({ anchor: sheetStart(), active: lastUsed(cells) });
        return;
      }
      if (mod && ['d', 'r'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopPropagation();
        const area = bounds(selected);
        if (event.key.toLowerCase() === 'd' && area.height > 1)
          void h.fill({ ...area, height: 1 }, 'rows', area.row + area.height - 1);
        else if (event.key.toLowerCase() === 'r' && area.width > 1)
          void h.fill({ ...area, width: 1 }, 'columns', area.column + area.width - 1);
        return;
      }
      let next: Cell | null = null;
      const dirs: Record<string, [number, number]> = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
      };
      if (event.key in dirs) {
        const [r, c] = dirs[event.key];
        next = mod
          ? edge(
              cell,
              r ? 'row' : 'column',
              (r || c) as -1 | 1,
              (at) => (h.matrix[at.row]?.[at.column] ?? '') !== '',
            )
          : move(cell, r, c);
      } else if (event.key === 'Home') next = mod ? sheetStart() : rowHome(cell);
      else if (event.key === 'End' && mod)
        next = lastUsed(
          h.matrix.flatMap((row, r) =>
            row.flatMap((source, c) => (source ? [{ row: r + 1, col: c + 1, source }] : [])),
          ),
        );
      else if (event.key === 'PageDown' || event.key === 'PageUp')
        next = pageStep(cell, event.key === 'PageDown' ? 1 : -1);
      else if (event.key === 'Tab') next = move(cell, 0, event.shiftKey ? -1 : 1);
      if (next) {
        event.preventDefault();
        h.moveTo(next, event.shiftKey && event.key !== 'Tab');
        return;
      }
      if (mod || event.altKey) return;
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        h.clear();
      } else if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        h.startEdit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (rangeA1(selected).includes(':')) h.choose(single(cell));
        else latest.current.onExit?.();
      } else if (event.key.length === 1) {
        event.preventDefault();
        h.startEdit(event.key);
      }
    };
    const cellAt = (target: EventTarget | null): Cell | null => {
      const item =
        target instanceof Element ? target.closest<HTMLElement>('[data-row][data-column]') : null;
      return item && element.contains(item)
        ? { row: Number(item.dataset.row), column: Number(item.dataset.column) }
        : null;
    };
    const pointer = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      const cell = cellAt(event.target);
      if (!cell) return;
      event.preventDefault();
      event.stopPropagation();
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="sheet-fill-handle"]')
      ) {
        const source = bounds(selectionRef.current);
        let target: ReturnType<typeof fillTarget> = null;
        const motion = (move: PointerEvent) => {
          const at = cellAt(document.elementFromPoint?.(move.clientX, move.clientY));
          target = at ? fillTarget(source, at) : null;
          setFillPreview(target ? rangeFromArea(target.area) : null);
        };
        const cancel = () => {
          setFillPreview(null);
          drag.end();
        };
        const end = () => {
          const next = target;
          cancel();
          if (next) void handlers.current.fill(source, next.axis, next.to);
        };
        window.addEventListener('pointermove', motion);
        window.addEventListener('pointerup', end, { once: true });
        window.addEventListener('pointercancel', cancel, { once: true });
        drag.begin(() => {
          window.removeEventListener('pointermove', motion);
          window.removeEventListener('pointerup', end);
          window.removeEventListener('pointercancel', cancel);
        }, cancel);
        return;
      }
      if (handlers.current.pointAt(cell, event.shiftKey)) {
        const motion = (move: PointerEvent) => {
          const at = cellAt(document.elementFromPoint?.(move.clientX, move.clientY));
          if (at) handlers.current.pointAt(at, true);
        };
        const end = () => drag.end();
        window.addEventListener('pointermove', motion);
        window.addEventListener('pointerup', end, { once: true });
        window.addEventListener('pointercancel', end, { once: true });
        drag.begin(() => {
          window.removeEventListener('pointermove', motion);
          window.removeEventListener('pointerup', end);
          window.removeEventListener('pointercancel', end);
        }, end);
        return;
      }
      handlers.current.commitDraft();
      focus();
      const before = selectionRef.current;
      const target =
        event.target instanceof Element ? event.target.closest<HTMLElement>('[data-header]') : null;
      if (target?.dataset.header === 'row') {
        handlers.current.choose({
          anchor: { row: cell.row, column: 0 },
          active: {
            row: cell.row,
            column: Math.max(0, ...handlers.current.matrix.map((r) => r.length - 1)),
          },
        });
        return;
      }
      if (target?.dataset.header === 'column') {
        handlers.current.choose({
          anchor: { row: 0, column: cell.column },
          active: { row: Math.max(0, handlers.current.matrix.length - 1), column: cell.column },
        });
        return;
      }
      handlers.current.choose(event.shiftKey ? extend(before, cell) : single(cell));
      const anchor = selectionRef.current.anchor;
      const motion = (move: PointerEvent) => {
        const target = document.elementFromPoint?.(move.clientX, move.clientY);
        const at = cellAt(target);
        if (at) handlers.current.choose({ anchor, active: at });
      };
      const end = () => drag.end();
      const cancel = () => {
        handlers.current.choose(before);
        drag.end();
      };
      window.addEventListener('pointermove', motion);
      window.addEventListener('pointerup', end, { once: true });
      window.addEventListener('pointercancel', cancel, { once: true });
      drag.begin(() => {
        window.removeEventListener('pointermove', motion);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', cancel);
      }, cancel);
    };
    const double = (event: MouseEvent) => {
      if (cellAt(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        handlers.current.startEdit();
      }
    };
    const context = (event: MouseEvent) => {
      const cell = cellAt(event.target);
      if (!cell) return;
      event.preventDefault();
      handlers.current.choose(single(cell));
      requestAnimationFrame(() =>
        element.querySelector<HTMLElement>('[data-testid="sheet-structure"]')?.click(),
      );
    };
    const clipboard = (event: ClipboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      event.preventDefault();
      event.stopPropagation();
      const data = event.clipboardData;
      if (!data) return;
      const h = handlers.current;
      const area = bounds(selectionRef.current);
      const slice = (read: (r: number, c: number) => string) =>
        Array.from({ length: area.height }, (_, r) =>
          Array.from({ length: area.width }, (_, c) => read(area.row + r, area.column + c)),
        );
      try {
        if (event.type === 'paste') {
          if (h.readOnly) return;
          const pasted = pasteBlock(h.matrix, selectionRef.current, readClipboard(data));
          commitMatrixRef.current(pasted.rows);
          h.choose(rangeFromArea(pasted.area));
        } else {
          writeClipboard(
            data,
            slice((r, c) => h.matrix[r]?.[c] ?? ''),
            slice((r, c) => h.shown.get(`${r}:${c}`)?.display ?? ''),
          );
          if (event.type === 'cut') h.clear();
        }
      } catch (error) {
        fail(error);
      }
    };
    const focusOut = (event: FocusEvent) => {
      if (
        draftRef.current &&
        !(
          event.relatedTarget instanceof Element &&
          event.relatedTarget.matches(
            '[data-testid="sheet-cell-editor"],[data-testid="sheet-formula-input"]',
          )
        )
      )
        handlers.current.commitDraft();
    };
    element.addEventListener('keydown', key);
    element.addEventListener('pointerdown', pointer);
    element.addEventListener('dblclick', double);
    element.addEventListener('contextmenu', context);
    element.addEventListener('focusout', focusOut);
    for (const name of ['copy', 'cut', 'paste'] as const) element.addEventListener(name, clipboard);
    return () => {
      element.removeEventListener('keydown', key);
      element.removeEventListener('pointerdown', pointer);
      element.removeEventListener('dblclick', double);
      element.removeEventListener('contextmenu', context);
      element.removeEventListener('focusout', focusOut);
      for (const name of ['copy', 'cut', 'paste'] as const)
        element.removeEventListener(name, clipboard);
    };
  }, [drag]);
  const activeValue = matrix[selection.active.row]?.[selection.active.column] ?? '';
  return (
    <div
      ref={root}
      {...scope.props}
      role="grid"
      tabIndex={0}
      contentEditable={false}
      data-key-claim="editor"
      data-testid="sheet-grid"
      aria-label={`${prepared.names[index] ?? 'Sheet'} cells`}
      aria-rowcount={extent.rows}
      aria-colcount={extent.columns}
      aria-busy={busy}
      aria-activedescendant={`${unique}-${a1(selection.active)}`}
      className="my-3 min-w-0 overflow-hidden rounded-lg border border-n-200 outline-none focus:border-cortex-400"
      style={{ userSelect: 'none', WebkitUserDrag: 'none' } as React.CSSProperties}
    >
      <div className="flex items-center justify-between bg-n-25 px-3 py-1">
        <span data-testid="sheet-name" className="text-xs font-medium text-n-600">
          {prepared.names[index]}
        </span>
        <div className="flex items-center gap-1">
          {!readOnly && props.getPage && (
            <SheetExportMenu
              sheet={prepared.names[index] ?? 'Sheet'}
              computed={props.computed}
              getPage={props.getPage}
              beforeOpen={commitDraft}
              current={() => sameSources(currentSources(), props.sources)}
            />
          )}
          <SheetAsk
            open={askOpen}
            setOpen={setAskOpen}
            selection={qualified(prepared.names[index] ?? 'Sheet', selection)}
            beforeAsk={commitDraft}
            readCells={() => {
              const fresh = currentSources();
              const parsed = parseSheetFence(
                fresh.find((sheet) => sheet.id === props.id)?.source ?? '',
              );
              const data = parsed.ok ? matrixOf(parsed.cells) : [];
              const current = sameSources(fresh, props.sources);
              return Array.from({ length: area.height }, (_, r) =>
                Array.from({ length: area.width }, (_, c) => {
                  const row = area.row + r,
                    column = area.column + c;
                  const source = data[row]?.[column] ?? '';
                  const value = shown.get(`${row}:${column}`);
                  return {
                    address: a1({ row, column }),
                    source,
                    shown: current
                      ? (value?.display ?? (source ? 'not computed' : ''))
                      : source
                        ? 'not computed'
                        : '',
                  };
                }),
              ).flat();
            }}
          />
          <SheetMenu
            sheets={prepared.inputs}
            sheet={index}
            area={area}
            disabled={readOnly || busy}
            onChange={(change, at, count) => void restructure(change, at, count)}
            onAsk={notePath ? () => setAskOpen(true) : undefined}
          />
        </div>
      </div>
      <FormulaBar
        names={prepared.names}
        sheet={index}
        row={selection.active.row}
        column={selection.active.column}
        onContext={(cursor) => {
          if (draftRef.current?.origin === 'bar') formulaCursor.current = cursor;
        }}
        address={rangeA1(selection)}
        value={draft?.text ?? activeValue}
        readOnly={readOnly || busy}
        inputRef={barInput}
        onChange={(text) => {
          point.current = null;
          const pending = draftRef.current;
          if (pending) updateDraft({ ...pending, text });
          else startEdit(text, 'bar');
        }}
        onFocus={() => {
          if (!draftRef.current) startEdit(undefined, 'bar');
        }}
        onBlur={() => {}}
      />
      <div
        ref={viewport}
        data-testid="sheet-viewport"
        className="relative overflow-auto"
        style={{ maxHeight: (VIEW_ROWS + 1) * ROW_HEIGHT }}
        onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
      >
        <div
          role="row"
          className="sticky top-0 z-10 flex bg-n-50"
          style={{ width: 40 + extent.columns * 120, height: ROW_HEIGHT }}
        >
          <div className="w-10 shrink-0 border-b border-r border-n-200" />
          {Array.from({ length: extent.columns }, (_, column) => (
            <div
              key={column}
              role="columnheader"
              data-row="0"
              data-column={column}
              data-header="column"
              className="w-30 shrink-0 border-b border-r border-n-200 py-2 text-center text-xs text-n-500"
            >
              {a1({ row: 0, column }).replace('1', '')}
            </div>
          ))}
        </div>
        <div style={{ height: windowRows.start * ROW_HEIGHT }} />
        {Array.from({ length: windowRows.end - windowRows.start }, (_, offset) => {
          const row = windowRows.start + offset;
          return (
            <div
              key={row}
              role="row"
              className="flex"
              style={{ width: 40 + extent.columns * 120, height: ROW_HEIGHT }}
            >
              <div
                role="rowheader"
                data-row={row}
                data-column="0"
                data-header="row"
                className="sticky left-0 z-10 w-10 shrink-0 border-b border-r border-n-200 bg-n-50 px-2 py-2 text-right text-xs text-n-500"
              >
                {row + 1}
              </div>
              {Array.from({ length: extent.columns }, (_, column) => {
                const cell = { row, column };
                const address = a1(cell);
                const value = shown.get(`${row}:${column}`);
                const paint = sheetCellPresentation(value, matrix[row]?.[column]);
                const selected =
                  row >= paintedArea.row &&
                  row < paintedArea.row + paintedArea.height &&
                  column >= paintedArea.column &&
                  column < paintedArea.column + paintedArea.width;
                const editing =
                  draft?.origin === 'cell' &&
                  draft.cell.row === row &&
                  draft.cell.column === column;
                return (
                  <div
                    key={column}
                    id={`${unique}-${address}`}
                    role="gridcell"
                    aria-selected={selected}
                    data-testid="sheet-cell"
                    data-cell={address}
                    data-address={address}
                    data-row={row}
                    data-column={column}
                    data-kind={value?.kind ?? 'blank'}
                    title={paint.title}
                    className={`relative w-30 shrink-0 overflow-hidden whitespace-pre border-b border-r border-n-200 px-3 py-1.5 text-sm ${selected ? 'bg-cortex-50' : ''} ${paint.className}`}
                  >
                    {editing ? (
                      <FormulaInput
                        inputRef={cellInput}
                        testId="sheet-cell-editor"
                        label={`${address} source`}
                        names={prepared.names}
                        sheet={index}
                        row={row}
                        column={column}
                        onContext={(cursor) => {
                          if (draftRef.current?.origin === 'cell') formulaCursor.current = cursor;
                        }}
                        className="absolute inset-0 z-10 resize-none border border-cortex-500 bg-n-0 px-2 py-1 text-left font-mono text-xs text-n-800 outline-none"
                        value={draft.text}
                        onChange={(text) => {
                          point.current = null;
                          updateDraft({ ...draft, text });
                        }}
                      />
                    ) : (
                      (value?.display ?? '')
                    )}
                    {!readOnly &&
                      !busy &&
                      !draft &&
                      row === area.row + area.height - 1 &&
                      column === area.column + area.width - 1 && (
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-label="Fill selected cells"
                          data-testid="sheet-fill-handle"
                          className="absolute bottom-0 right-0 z-10 size-2 cursor-crosshair border border-n-0 bg-cortex-500"
                        />
                      )}
                  </div>
                );
              })}
            </div>
          );
        })}
        <div style={{ height: (extent.rows - windowRows.end) * ROW_HEIGHT }} />
      </div>
      {draft && <DraftEscape cancel={cancel} />}
    </div>
  );
}
