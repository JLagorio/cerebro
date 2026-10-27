import type { DocumentOwner } from '@/editor/documentOwner';
import type { Cell } from '@/engine/sheet/selection';
import type { SheetSource } from '@/engine/sheet/gridEdit';
import { parseSheetFence } from '@/engine/sheet/fence';

export interface SheetDraftSnapshot {
  cell: Cell;
  text: string;
  origin: 'cell' | 'bar';
}
interface RetainedSheetDraft {
  id: string;
  draft: SheetDraftSnapshot;
  /** Content correspondence, never a persisted BlockNote id. Ambiguous
   * original targets cannot become unambiguous merely by losing a duplicate. */
  target: { source: string; unique: boolean } | null;
}
interface RegistrationOptions {
  sources: () => readonly SheetSource[];
  restore: (draft: SheetDraftSnapshot) => void;
}
interface PendingSheet {
  prepare: () => boolean;
  snapshot: () => SheetDraftSnapshot | null;
  options?: RegistrationOptions;
  retained: RetainedSheetDraft | null;
}
interface SheetBook {
  entries: Map<string, PendingSheet>;
  detached: RetainedSheetDraft[];
  binding?: {
    owner: DocumentOwner;
    sources: () => readonly SheetSource[];
    diskSources: readonly SheetSource[] | null;
    active: boolean;
  };
  restoring: boolean;
}
const pending = new WeakMap<object, SheetBook>();
const currentBooks = new WeakMap<DocumentOwner, SheetBook>();
const copy = (draft: SheetDraftSnapshot): SheetDraftSnapshot => ({
  ...draft,
  cell: { ...draft.cell },
});
function bookFor(editor: object): SheetBook {
  let book = pending.get(editor);
  if (!book) {
    book = { entries: new Map(), detached: [], restoring: false };
    pending.set(editor, book);
  }
  return book;
}
function capture(id: string, entry: PendingSheet): RetainedSheetDraft | null {
  const draft = entry.snapshot();
  if (draft === null) return (entry.retained = null);
  if (entry.retained === null) {
    const sources = entry.options?.sources() ?? [];
    const source = sources.find((sheet) => sheet.id === id)?.source;
    entry.retained = {
      id,
      draft: copy(draft),
      target:
        source === undefined
          ? null
          : {
              source,
              unique: sources.filter((sheet) => sheet.source === source).length === 1,
            },
    };
  } else entry.retained = { ...entry.retained, draft: copy(draft) };
  return entry.retained;
}
function retained(book: SheetBook): RetainedSheetDraft[] {
  return [
    ...book.detached,
    ...[...book.entries].flatMap(([id, entry]) => {
      const value = capture(id, entry);
      return value === null ? [] : [value];
    }),
  ];
}
function publish(book: SheetBook): void {
  const binding = book.binding;
  if (!binding || !binding.active || book.restoring || currentBooks.get(binding.owner) !== book)
    return;
  const values = retained(book);
  binding.owner.setChildDrafts('sheets', values.length ? JSON.stringify(values) : null);
}
function restore(book: SheetBook): void {
  const binding = book.binding;
  if ((binding && !binding.active) || book.restoring) return;
  book.restoring = true;
  try {
    const sources =
      binding?.sources() ??
      [...book.entries.values()].find((entry) => entry.options)?.options?.sources() ??
      [];
    const diskSources = binding?.diskSources ?? null;
    book.detached = book.detached.filter((saved) => {
      if (!saved.target?.unique) return true;
      const candidates = sources.filter((sheet) => sheet.source === saved.target!.source);
      if (
        candidates.length !== 1 ||
        (diskSources !== null &&
          diskSources.filter((sheet) => sheet.source === saved.target!.source).length !== 1)
      )
        return true;
      const candidate = candidates[0];
      const entry = book.entries.get(candidate.id);
      if (!entry?.options || entry.snapshot() !== null) return true;
      entry.retained = { ...saved, id: candidate.id, draft: copy(saved.draft) };
      entry.options.restore(copy(saved.draft));
      return false;
    });
  } finally {
    book.restoring = false;
  }
  publish(book);
}

/** Attach data to a replacement presentation, never old editor callbacks.
 * Both the original and replacement source must be unique. A changed, missing,
 * or ambiguous target stays detached and continues blocking the page. */
export function bindSheetDrafts(
  editor: object,
  owner: DocumentOwner,
  sources: () => readonly SheetSource[],
  diskSources: readonly SheetSource[] | null,
): void {
  const book = bookFor(editor);
  const previous = currentBooks.get(owner);
  if (previous === book && book.binding) {
    book.binding = { owner, sources, diskSources, active: true };
    restore(book);
    return;
  }
  if (previous?.binding) {
    publish(previous);
    previous.binding.active = false;
  }
  const payload = owner.snapshot().childDrafts?.sheets;
  // This namespace is written only here, from the data-only retained records.
  // A malformed internal payload throws and leaves its owner hold intact.
  book.detached = payload ? (JSON.parse(payload) as RetainedSheetDraft[]) : [];
  book.binding = { owner, sources, diskSources, active: true };
  currentBooks.set(owner, book);
  restore(book);
}
export function detachSheetDrafts(editor: object): void {
  const book = pending.get(editor);
  if (!book?.binding?.active) return;
  publish(book);
  book.binding.active = false;
}
/** Capture source identity at the first keystroke, before outside reconciliation
 * can change the fence. Publishing this snapshot never writes the page. */
export function notifySheetDraftChanged(editor: object): void {
  const book = pending.get(editor);
  if (!book || book.restoring) return;
  retained(book);
  publish(book);
}
function cellText(source: string, cell: Cell): string | null {
  const parsed = parseSheetFence(source);
  if (!parsed.ok) return null;
  return (
    parsed.cells.find((value) => value.row === cell.row + 1 && value.col === cell.column + 1)
      ?.source ?? ''
  );
}
export function canPrepareSheetDraft(editor: object, id: string): boolean {
  const book = pending.get(editor);
  if (book?.binding?.owner.recoveryRetired()) return false;
  if (book?.binding && (!book.binding.active || currentBooks.get(book.binding.owner) !== book))
    return false;
  const entry = book?.entries.get(id);
  const saved = entry && capture(id, entry);
  if (!saved?.target || !entry?.options) return true;
  const current = entry.options.sources().find((sheet) => sheet.id === id)?.source;
  if (current === undefined) return false;
  const before = cellText(saved.target.source, saved.draft.cell);
  const now = cellText(current, saved.draft.cell);
  return now !== null && (now === before || now === saved.draft.text);
}

/** Child preparation is synchronous and accepted source edits still go through
 * the existing page writer. A detached registration stores data, not a writer. */
export function registerSheetDraft(
  editor: object,
  id: string,
  prepare: () => boolean,
  snapshot: () => SheetDraftSnapshot | null = () => null,
  options?: RegistrationOptions,
): () => void {
  const book = bookFor(editor);
  const entry: PendingSheet = { prepare, snapshot, options, retained: null };
  book.entries.set(id, entry);
  const alreadyRestored = snapshot();
  if (alreadyRestored !== null) {
    const prior = book.detached.find(
      (saved) => saved.id === id && JSON.stringify(saved.draft) === JSON.stringify(alreadyRestored),
    );
    if (prior) {
      entry.retained = prior;
      book.detached = book.detached.filter((saved) => saved !== prior);
    }
  }
  restore(book);
  notifySheetDraftChanged(editor);
  return () => {
    if (book.entries.get(id) !== entry) return;
    const saved = capture(id, entry);
    if (saved !== null) book.detached.push(saved);
    book.entries.delete(id);
    publish(book);
  };
}
export function pendingSheetDrafts(editor: object): { id: string; draft: SheetDraftSnapshot }[] {
  const book = pending.get(editor);
  return book ? retained(book).map(({ id, draft }) => ({ id, draft: copy(draft) })) : [];
}
export function settleSheetDrafts(editor: object): void {
  const book = pending.get(editor);
  if (!book) return;
  if (book.binding?.owner.recoveryRetired()) {
    book.entries.clear();
    book.detached = [];
    book.binding.active = false;
    return;
  }
  if (book.binding && !book.binding.active) {
    if (retained(book).length) throw new Error('A sheet cell still has an unsaved draft.');
    return;
  }
  restore(book);
  let unresolved = book.detached.length > 0;
  for (const [id, entry] of [...book.entries]) {
    try {
      if (!canPrepareSheetDraft(editor, id) || !entry.prepare()) unresolved = true;
    } catch {
      unresolved = true;
    }
  }
  publish(book);
  if (unresolved) throw new Error('A sheet cell still has an unsaved draft.');
}
