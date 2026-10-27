import type { CerebroEditor } from './MarkdownEditor';
import type { SourceLocator } from '@/engine/sourceLocation';
import { sourceUtf8Length } from '@/engine/sourceLocation';
import { wikilinkSpans } from '@/engine/wikilink';
import { TextSelection } from 'prosemirror-state';

/** Exact scalar boundary conversion. Never apply a display excerpt's index. */
export function sourceUtf16Offset(text: string, byte: number): number | null {
  if (!Number.isSafeInteger(byte) || byte < 0) return null;
  let bytes = 0,
    offset = 0;
  for (const scalar of text) {
    if (bytes === byte) return offset;
    bytes += sourceUtf8Length(scalar);
    offset += scalar.length;
    if (bytes > byte) return null;
  }
  return bytes === byte ? offset : null;
}
interface RawInline {
  start: number;
  end: number;
  text: string;
  target?: string;
  alias?: string;
}
function rawInline(text: string): RawInline[] | null {
  const parts: RawInline[] = [];
  let at = 0;
  const plain = (start: number, end: number) => {
    const value = text.slice(start, end);
    if (/[[\]<>*_`\\|&]/.test(value)) return false;
    if (value) parts.push({ start, end, text: value });
    return true;
  };
  for (const span of wikilinkSpans(text)) {
    if (!plain(at, span.start)) return null;
    const raw = text.slice(span.start, span.end);
    parts.push({
      start: span.start,
      end: span.end,
      text: raw,
      target: span.target,
      alias: raw.slice(2, -2).split('|').slice(1).join('|').trim(),
    });
    at = span.end;
  }
  return plain(at, text.length) ? parts : null;
}
interface RawBlock {
  type: string;
  text: string;
  start: number;
  level?: number;
  inline?: RawInline[];
}
/** Deliberately narrow grammar, validated against EVERY installed document
 * block in order. No quote search, fuzzy match, or inferred chip offsets. */
function rawBlocks(body: string): RawBlock[] | null {
  if (body.includes('\r')) return null;
  const lines = body.split('\n');
  const blocks: RawBlock[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const start = offset;
    offset += line.length + 1;
    if (!line) continue;
    const fence = /^```([\w+-]*)$/.exec(line);
    if (fence) {
      const first = offset;
      const code: string[] = [];
      while (++i < lines.length && lines[i] !== '```') {
        code.push(lines[i]);
        offset += lines[i].length + 1;
      }
      if (i === lines.length) return null;
      offset += 4;
      blocks.push({ type: 'codeBlock', text: code.join('\n'), start: first });
      continue;
    }
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    const list = /^(?:[-+*] |\d+\. )(.+)$/.exec(line);
    const text = heading?.[2] ?? list?.[1] ?? line;
    // Only plain text and proven atomic wikilinks have inline source maps.
    // Other syntax, directives and indented children remain unsupported.
    const inline = rawInline(text);
    // A standalone link can be promoted to a page-card carrier. This
    // inline map deliberately requires ordinary text beside the chip.
    if (
      !inline ||
      (inline.length === 1 && inline[0].target !== undefined) ||
      /^\s|\s$/.test(text) ||
      /^(?::::|>|[=~-]{3})/.test(text)
    )
      return null;
    const type = heading
      ? 'heading'
      : list
        ? /^\d/.test(line)
          ? 'numberedListItem'
          : 'bulletListItem'
        : 'paragraph';
    // Multiline paragraphs need a break map; report unsupported for now.
    if (type === 'paragraph' && i > 0 && lines[i - 1] && blocks.at(-1)?.type === 'paragraph')
      return null;
    blocks.push({
      type,
      text,
      inline,
      start: start + line.length - text.length,
      ...(heading ? { level: heading[1].length } : {}),
    });
  }
  return blocks;
}
export function mapSourceRange(
  body: string,
  range: { start: number; end: number },
  editor: CerebroEditor,
): { from: number; to: number } | null {
  const start = sourceUtf16Offset(body, range.start),
    end = sourceUtf16Offset(body, range.end);
  if (start === null || end === null || start >= end) return null;
  const raw = rawBlocks(body);
  if (!raw?.length) return null;
  const positions: {
    from: number;
    to: number;
    rawStart: number;
    rawEnd: number;
    atomic: boolean;
  }[] = [];
  let index = 0,
    valid = true;
  editor.prosemirrorState.doc.firstChild?.forEach((container, offset) => {
    const block = raw[index++];
    const node = container.firstChild;
    // BlockNote can retain one final empty writing paragraph.
    if (
      !block &&
      index === raw.length + 1 &&
      node?.type.name === 'paragraph' &&
      node.content.size === 0
    )
      return;
    if (
      !block ||
      !node ||
      container.childCount !== 1 ||
      node.type.name !== block.type ||
      (block.level !== undefined && node.attrs.level !== block.level)
    ) {
      valid = false;
      return;
    }
    const parts: RawInline[] =
      block.inline ?? (block.text ? [{ start: 0, end: block.text.length, text: block.text }] : []);
    if (parts.length !== node.childCount) {
      valid = false;
      return;
    }
    node.forEach((child, childOffset, childIndex) => {
      const part = parts[childIndex];
      const atomic = part.target !== undefined;
      if (
        child.marks.length > 0 ||
        (atomic
          ? child.type.name !== 'wikilink' ||
            !child.isAtom ||
            child.nodeSize !== 1 ||
            child.attrs.target !== part.target ||
            child.attrs.alias !== part.alias
          : !child.isText || child.text !== part.text)
      ) {
        valid = false;
        return;
      }
      positions.push({
        from: offset + 3 + childOffset,
        to: offset + 3 + childOffset + child.nodeSize,
        rawStart: block.start + part.start,
        rawEnd: block.start + part.end,
        atomic,
      });
    });
  });
  if (!valid || index < raw.length) return null;
  const selected = positions.filter((part) => part.rawEnd > start && part.rawStart < end);
  if (
    !selected.length ||
    selected.some((part) => part.atomic && (start > part.rawStart || end < part.rawEnd))
  )
    return null;
  const first = selected[0],
    last = selected[selected.length - 1];
  return {
    from: first.from + (first.atomic ? 0 : Math.max(0, start - first.rawStart)),
    to: last.atomic ? last.to : last.from + Math.min(last.rawEnd, end) - last.rawStart,
  };
}
export interface SourceEditorOwner {
  editor: CerebroEditor;
  body: string;
  sourceHash: string;
  isCurrent(requestId: string): boolean;
  mayFocus(): boolean;
}
export async function revealSource(
  request: { requestId: string; locator: SourceLocator },
  owner: SourceEditorOwner,
): Promise<'revealed' | 'changed' | 'unsupported' | 'cancelled'> {
  if (!owner.isCurrent(request.requestId) || !owner.mayFocus()) return 'cancelled';
  if (owner.sourceHash !== request.locator.sourceHash) return 'changed';
  const range = request.locator.bodyUtf8Range;
  if (request.locator.kind !== 'body' || !range) return 'unsupported';
  const from = sourceUtf16Offset(owner.body, range.start),
    to = sourceUtf16Offset(owner.body, range.end);
  if (from === null || to === null || owner.body.slice(from, to) !== request.locator.quote)
    return 'changed';
  // Tiptap initializes on a later timer after mount. BlockNote.focus is a
  // no-op before then even when its DOM is connected. Wait for that actual
  // condition, rechecking ownership/input on each frame, before selecting.
  for (let frame = 0; owner.editor.headless && frame < 120; frame += 1) {
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    if (!owner.isCurrent(request.requestId) || !owner.mayFocus()) return 'cancelled';
  }
  if (owner.editor.headless || !owner.editor.prosemirrorView.dom.isConnected) return 'unsupported';
  const mapped = mapSourceRange(owner.body, range, owner.editor);
  if (!mapped) return 'unsupported';
  owner.editor.transact((tr) =>
    tr.setSelection(TextSelection.create(tr.doc, mapped.from, mapped.to)).scrollIntoView(),
  );
  owner.editor.focus();
  return 'revealed';
}
export function revealProperty(
  key: string,
  requestId: string,
  owner: { root: HTMLElement; isCurrent(id: string): boolean; mayFocus(): boolean },
): 'revealed' | 'unsupported' | 'cancelled' {
  if (!owner.isCurrent(requestId) || !owner.mayFocus()) return 'cancelled';
  const row = [...owner.root.querySelectorAll<HTMLElement>('[data-property]')].find(
    (item) => item.dataset.property === key,
  );
  if (!row || row.closest('[hidden], [inert]')) return 'unsupported';
  row.tabIndex = -1;
  row.focus({ preventScroll: true });
  row.scrollIntoView?.({ block: 'center' });
  return 'revealed';
}

// Property owners expand their existing section locally. The resolver owns
// searchable array/relation flattening; the UI focuses a row, never a member.
import { useEffect, useRef, type RefObject } from 'react';
import { useNavStore, usePaneId } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { sourceRequestFor, sourceMayFocus, finishSourceRequest } from '@/app/sourceOpen';
import { resolveSource, readNoteSource } from '@/lib/ipc';
const propertyOwners = new Set<{
  path: string;
  owner: import('@/stores/navStore').PaneId | 'peek';
}>();
export function hasSourcePropertyOwner(
  path: string,
  owner: import('@/stores/navStore').PaneId | 'peek',
): boolean {
  return [...propertyOwners].some((item) => item.path === path && item.owner === owner);
}
export function useSourcePropertyRow(
  path: string,
  hash: string | null,
  root: RefObject<HTMLElement | null>,
  expand: () => void,
  enabled = true,
): string | null {
  const pane = usePaneId();
  const source = useNavStore(() =>
    enabled ? (sourceRequestFor(path, 'peek') ?? sourceRequestFor(path, pane)) : undefined,
  );
  const owner = sourceRequestFor(path, 'peek') ? 'peek' : pane;
  useEffect(() => {
    if (!enabled) return;
    const registration: { path: string; owner: import('@/stores/navStore').PaneId | 'peek' } = {
      path,
      owner,
    };
    propertyOwners.add(registration);
    return () => {
      propertyOwners.delete(registration);
    };
  }, [path, owner, enabled]);
  const vault = useVaultStore((state) => state.vaultPath);
  const expandRef = useRef(expand);
  expandRef.current = expand;
  useEffect(() => {
    if (!source || source.status || source.locator.kind !== 'property' || !vault) return;
    let cancelled = false;
    const current = () =>
      !cancelled && sourceRequestFor(path, owner)?.requestId === source.requestId;
    const finish = (status: import('@/app/sourceOpen').SourceRevealStatus) => {
      if (current()) finishSourceRequest(path, owner, source.requestId, status);
    };
    void (async () => {
      const resolved = await resolveSource(vault, source.locator);
      if (!current()) return;
      if (resolved.status !== 'exact' && resolved.status !== 'relocated') {
        finish(resolved.status);
        return;
      }
      const snapshot = await readNoteSource(vault, path);
      if (!current()) return;
      if (snapshot.hash !== resolved.locator.sourceHash || hash !== snapshot.hash) {
        finish('changed');
        return;
      }
      if (!sourceMayFocus(source, owner)) {
        finish('cancelled');
        return;
      }
      expandRef.current();
      // Let this owner's normal local expansion render before asking its row.
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
      if (!current()) return;
      if (!root.current) {
        finish('unsupported');
        return;
      }
      const result = revealProperty(resolved.locator.propertyKey!, source.requestId, {
        root: root.current,
        isCurrent: current,
        mayFocus: () => sourceMayFocus(source, owner),
      });
      finish(result === 'revealed' && resolved.status === 'relocated' ? 'relocated' : result);
    })().catch(() => finish('unavailable'));
    return () => {
      cancelled = true;
    };
  }, [source, owner, path, vault, hash, root]);
  return source?.locator.kind === 'property' &&
    (source.status === undefined || source.status === 'revealed' || source.status === 'relocated')
    ? (source.locator.propertyKey ?? null)
    : null;
}
