import { libraryKind } from '@/engine/library';
import { isRecordEntry } from '@/engine/typeCatalog';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * How much a caller is allowed to move you (M9.3).
 *
 * `navigate` is the original open-by-kind rule (Tasks 10/11/14 — recents,
 * QuickOpen, wikilinks): those surfaces carry no canvas of their own, so a
 * record is given a backdrop — its containing Collection when it lives in
 * one, its type screen otherwise — before the panel opens.
 *
 * `in-place` is for surfaces that ARE the backdrop. A collection already
 * shows you the record in context; navigating away to show it again throws
 * away the list you were reading.
 */
export type OpenMode = 'navigate' | 'in-place';

const dirOf = (path: string) => {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
};

/**
 * The one routing DEFAULT (M12.1 as law, M38.2 as default; projects retired
 * M12.5): a RECORD — any typed entry — peeks in the detail panel, and a DOC —
 * any untyped note — opens full-page. The peek header's "Open in full page"
 * is the explicit act that puts a record on the page canvas; nothing routes
 * there implicitly, and no type name routes specially.
 *
 * `type: Type` docs are the schema, so opening one goes to the type screen
 * it declares. Templates and the knowledge bundle carry types that are not
 * content types, so they keep their document form.
 */
export function useOpenPath(mode: OpenMode = 'navigate'): (path: string) => void {
  const navigate = useNavStore((s) => s.navigate);
  const openDetail = useUiStore((s) => s.openDetail);

  return (path) => {
    // Resolved at CALL time, not render time (M12.8): the New button creates
    // a record and opens it in the same tick — a render-time snapshot predates
    // the record, fails the lookup, and misroutes a typed record to Docs.
    const entries = useVaultStore.getState().entries;
    const selection = useNavStore.getState().selection;
    // M29.21: a .mmd is raw diagram source — no frontmatter, no record shape —
    // so it has exactly one surface, the full-page diagram editor. Decided on
    // the extension, before the entry lookup: even a not-yet-scanned .mmd must
    // never fall through to the doc canvas, which would edit it as markdown.
    if (path.endsWith('.mmd')) {
      navigate({ kind: 'diagram', path });
      return;
    }
    const entry = entries.find((e) => e.path === path);
    if (entry === undefined) {
      navigate({ kind: 'doc', path });
      return;
    }
    // A Type doc IS its type screen — editing the schema by hand in a doc
    // editor is the old world.
    if (entry.type === 'Type') {
      navigate({ kind: 'type', name: entry.title });
      return;
    }
    // M18: same rule, one level out. A skill's frontmatter is the app's own
    // contract — `allowed-tools:` is a boundary Rust enforces — so it opens in
    // the editor that knows what those values mean, never in a property table
    // or a doc canvas. This is why a wikilink to a template lands somewhere
    // useful instead of in a body editor that would let you break it.
    const kind = libraryKind(entry);
    if (kind !== null) {
      navigate({ kind: 'library', tab: kind, path });
      return;
    }
    if (isRecordEntry(entry) && entry.type !== null) {
      // The backdrop jump: in-place callers get the panel and nothing else —
      // DetailPanel's breadcrumb is how you reach the container deliberately.
      if (mode === 'navigate') {
        const folder = entry.project !== null ? dirOf(entry.project) : null;
        const onCollection =
          folder !== null && selection.kind === 'collection' && selection.folder === folder;
        const onType = selection.kind === 'type' && selection.name === entry.type;
        if (folder !== null && !onCollection) {
          navigate({ kind: 'collection', folder });
        } else if (folder === null && !onType) {
          navigate({ kind: 'type', name: entry.type });
        }
      }
      openDetail(path);
      return;
    }
    navigate({ kind: 'doc', path });
  };
}
