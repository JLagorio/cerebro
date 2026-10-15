/** Page flush (including quit) settles drafts before measuring pending saves. */
const pending = new WeakMap<object, Map<string, () => void>>();
export function registerSheetDraft(owner: object, id: string, flush: () => void): () => void {
  const book = pending.get(owner) ?? new Map<string, () => void>();
  pending.set(owner, book);
  book.set(id, flush);
  return () => {
    if (book.get(id) === flush) book.delete(id);
    if (book.size === 0) pending.delete(owner);
  };
}
export function settleSheetDrafts(owner: object): void {
  for (const flush of [...(pending.get(owner)?.values() ?? [])]) flush();
}
