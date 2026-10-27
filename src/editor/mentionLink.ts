import type { SourceLocator } from '@/engine/sourceLocation';
import { sourceUtf8Length } from '@/engine/sourceLocation';
import { splitFrontmatter } from '@/engine/frontmatter';
import { rustTrim } from '@/engine/comments';
import { isDocEntry } from '@/engine/typeCatalog';
import { linkTargetsFor, targetIndexFor } from '@/engine/wikilink';
import { stalePath } from '@/engine/batch';
import { readNoteSource, resolveSource } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import limits from '../../shared/knowledge/source-location.v1.json';
import type { CerebroEditor } from './MarkdownEditor';
import { mapSourceRange, sourceUtf16Offset } from './sourceReveal';
import { heldOpenPages, prepareOpenPages } from './openPages';

export interface MentionLinkRequest {
  vault: string;
  locator: SourceLocator;
  targetPath: string;
  targetHash: string;
  editor: CerebroEditor;
  stillCurrent: () => boolean;
}
export type MentionLinkOutcome =
  'applied' | 'changed' | 'unsupported' | 'cancelled' | 'unavailable';

/** The ordinary body writer composes LF fences and drops empty YAML/BOM.
 * Admit only envelopes it can carry unchanged; shared mention-link-body
 * cases exercise this promise against the actual native compose_saved. */
function canonicalBody(content: string): string | null {
  if (content.startsWith('\ufeff') || content.includes('\r')) return null;
  const { yaml, body } = splitFrontmatter(content);
  if (sourceUtf8Length(body) > limits.maxBodyBytes) return null;
  const prefix = content.slice(0, content.length - body.length);
  if (yaml === null) return prefix === '' ? body : null;
  return rustTrim(yaml) !== '' && prefix === `---\n${yaml}\n---\n` ? body : null;
}

function safeAlias(quote: string): boolean {
  return (
    quote !== '' &&
    quote === quote.trim() &&
    !/[[\]|\r\n]/.test(quote) &&
    ![...quote].some((char) => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127)
  );
}

/** The existing reveal map also maps code and atoms. Linking deliberately
 * permits only part of one plain text child; an entire block could become
 * a standalone page-card carrier after reopening. */
function linkedBody(
  content: string,
  locator: SourceLocator,
  target: string,
  editor: CerebroEditor,
): string | null {
  const body = canonicalBody(content);
  const range = locator.bodyUtf8Range;
  if (body === null || !range || !safeAlias(locator.quote)) return null;
  const start = sourceUtf16Offset(body, range.start);
  const end = sourceUtf16Offset(body, range.end);
  if (start === null || end === null || body.slice(start, end) !== locator.quote) return null;
  const mapped = mapSourceRange(body, range, editor);
  if (!mapped) return null;
  const doc = editor.prosemirrorState.doc;
  const from = doc.resolve(mapped.from);
  const to = doc.resolve(mapped.to);
  if (
    from.parent !== to.parent ||
    !['paragraph', 'heading', 'bulletListItem', 'numberedListItem'].includes(
      from.parent.type.name,
    ) ||
    (from.parentOffset === 0 && to.parentOffset === from.parent.content.size) ||
    doc.textBetween(mapped.from, mapped.to) !== locator.quote
  )
    return null;
  let plain = false;
  from.parent.forEach((child, offset) => {
    if (
      child.isText &&
      child.marks.length === 0 &&
      offset <= from.parentOffset &&
      offset + child.nodeSize >= to.parentOffset
    )
      plain = true;
  });
  return plain ? body.slice(0, start) + `[[${target}|${locator.quote}]]` + body.slice(end) : null;
}

/** One explicit human transformation. The batch door owns flushing, native
 * compare/write/receipt, retained-editor reconciliation and app Undo.
 * Ordinary editor saves and their last-write-wins behavior are unchanged. */
export async function insertMentionLink(request: MentionLinkRequest): Promise<MentionLinkOutcome> {
  const { vault, locator, targetPath, targetHash, editor, stillCurrent } = request;
  const ready = () => {
    const state = useVaultStore.getState();
    return state.vaultPath === vault && state.entriesVault === vault && state.status === 'ready';
  };
  if (!stillCurrent() || !ready()) return 'cancelled';
  const entries = useVaultStore.getState().entries;
  const source = entries.find((entry) => entry.path === locator.path);
  const target = entries.find((entry) => entry.path === targetPath);
  if (
    locator.kind !== 'body' ||
    !locator.path.endsWith('.md') ||
    !source ||
    !isDocEntry(source) ||
    source.authority !== undefined
  )
    return 'unsupported';
  if (
    !target ||
    target.authority !== undefined ||
    source.parseError !== null ||
    target.parseError !== null ||
    source.hash !== locator.sourceHash ||
    target.hash !== targetHash
  )
    return 'changed';
  const name = linkTargetsFor(entries)(target);
  if (
    name === null ||
    !safeAlias(name) ||
    targetIndexFor(entries).resolveLink(name)?.entry !== target
  )
    return 'unsupported';
  let retired = false;
  let modelChanged = false;
  const doc = editor.prosemirrorState.doc;
  const unsubscribeVault = useVaultStore.subscribe(() => {
    if (!ready()) retired = true;
  });
  const unsubscribeEditor = editor.onChange(() => {
    modelChanged = true;
  });
  const invalid = (): MentionLinkOutcome | null => {
    if (retired || !ready() || !stillCurrent()) return 'cancelled';
    if (
      modelChanged ||
      editor.prosemirrorState.doc !== doc ||
      useVaultStore.getState().entries !== entries
    )
      return 'changed';
    return null;
  };
  const mayDispatch = () => {
    prepareOpenPages();
    const held = heldOpenPages();
    return invalid() === null && !held.includes(locator.path) && !held.includes(targetPath);
  };
  try {
    if (!mayDispatch()) return invalid() ?? 'changed';
    const resolved = await resolveSource(vault, locator);
    const afterResolve = invalid();
    if (afterResolve) return afterResolve;
    if (resolved.status !== 'exact')
      return resolved.status === 'relocated' || resolved.status === 'changed'
        ? 'changed'
        : resolved.status;
    const [snapshot, destination] = await Promise.all([
      readNoteSource(vault, locator.path),
      readNoteSource(vault, targetPath),
    ]);
    const afterRead = invalid();
    if (afterRead) return afterRead;
    if (snapshot.hash !== locator.sourceHash || destination.hash !== targetHash) return 'changed';
    const body = linkedBody(snapshot.content, locator, name, editor);
    if (body === null) return 'unsupported';
    if (!mayDispatch()) return invalid() ?? 'changed';
    let refused: MentionLinkOutcome = 'unavailable';
    const applied = await useVaultStore
      .getState()
      .applyBatch([{ op: 'body', path: locator.path, body, expectHash: snapshot.hash }], {
        undo: 'Linked mention',
        stillCurrent: mayDispatch,
        onRefused: (message) => {
          refused = stalePath(message) === null ? 'unavailable' : 'changed';
        },
      });
    // Once dispatched, a real acknowledgement remains applied even if its
    // origin retired while IPC/refresh waited. It never writes another vault.
    return applied !== null ? 'applied' : (invalid() ?? refused);
  } catch {
    return invalid() ?? 'unavailable';
  } finally {
    unsubscribeEditor();
    unsubscribeVault();
  }
}
