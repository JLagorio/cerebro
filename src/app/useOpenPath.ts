import { isMarkdownPath } from '@/engine/roots';
import { isWhiteboardPath } from '@/engine/fileKinds';
import { openBesideIntent } from './openIntent';
import { useContext } from 'react';
import { holderOf } from '@/engine/panes';
import { isCollectionPage } from '@/engine/collections';
import { pageOfSidecar } from '@/engine/comments';
import { isKnowledgePath } from '@/engine/okf';
import { libraryKind } from '@/engine/library';
import { isRecordEntry } from '@/engine/typeCatalog';
import {
  PaneContext,
  layoutOf,
  useNavStore,
  usePaneId,
  type NavOutcome,
  type NavigateOptions,
} from '@/stores/navStore';
import { recordPersonOpen } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { Selection } from '@/engine/types';

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
 * any untyped note — opens full-page. The peek header and external app
 * links explicitly ask for a full page; normal callers keep this default.
 * No type name routes specially.
 *
 * `type: Type` docs are the schema, so opening one goes to the type screen
 * it declares. Templates and the knowledge bundle carry types that are not
 * content types, so they keep their document form.
 */
export function useOpenPath(
  mode: OpenMode = 'navigate',
  {
    byAgent = false,
    replace = false,
    fullPage = false,
  }: { byAgent?: boolean; replace?: boolean; fullPage?: boolean } = {},
): (path: string, options?: { newPane?: boolean }) => NavOutcome {
  const pane = usePaneId();
  const context = useContext(PaneContext);
  const currentPane = () => (context === null ? useNavStore.getState().active : pane);
  // The opens that are not page selections — a Type doc, a Collection page, a
  // record's panel — are recorded here; navStore records page selections.
  const recordOpen = (path: string) => {
    if (!byAgent) recordPersonOpen(path);
  };

  return (path, openOptions = {}) => {
    const newPane = !byAgent && (openOptions.newPane ?? openBesideIntent());
    const navigate = (sel: Selection, options?: NavigateOptions) => {
      const opts = {
        ...options,
        ...(replace ? { replace: true } : {}),
        ...(byAgent ? { byAgent } : {}),
      };
      return newPane
        ? useNavStore.getState().openPane(sel, { ...opts, from: currentPane() })
        : useNavStore.getState().navigateIn(currentPane(), sel, opts);
    };
    // This pane's selection resolves at CALL time (M12.8): New creates
    // a record and opens it in the same tick — a render-time snapshot predates
    // the record, fails the lookup, and misroutes a typed record to Docs.
    const entries = useVaultStore.getState().entries;
    const selection = useNavStore.getPaneState(currentPane()).selection;
    // File editors route before the scan: raw diagrams and JSON boards must
    // never fall through to the markdown editor while their entry loads.
    if (path.endsWith('.mmd')) {
      return navigate({ kind: 'diagram', path });
    }
    if (isWhiteboardPath(path)) return navigate({ kind: 'diagram', path });
    // M70.2b: a page's comment sidecar (`.comments/<page>.json`, which
    // Changes' Open passes) opens its page, full, on the Comments tab:
    // comments live on the full page, never in the peek (Q6).
    const page = pageOfSidecar(path);
    if (page !== null) {
      // Both tab slots, since a page under knowledge/ may or may not be a
      // concept; the open flag is the one its panel keeps.
      const ui = useUiStore.getState();
      ui.setDocPanelTab('comments');
      ui.setConceptPanelTab('comments');
      if (isKnowledgePath(page)) ui.setConceptPanelOpen(true);
      else ui.setDocPanelOpen(true);
      return navigate({ kind: 'doc', path: page });
    }
    if (!isMarkdownPath(path)) return navigate({ kind: 'file', path });
    // Reuse happens before backdrop routing, so opening a held record never
    // moves its source table to a different database on the way there.
    const held = holderOf(layoutOf(useNavStore.getState()), { kind: 'doc', path });
    if (held)
      return held.id === currentPane()
        ? { kind: 'unchanged', pane: held.id }
        : useNavStore.getState().openPeek(path, { from: currentPane(), byAgent });
    const entry = entries.find((e) => e.path === path);
    if (entry === undefined) {
      return navigate({ kind: 'doc', path });
    }
    // A Type doc IS its type screen — editing the schema by hand in a doc
    // editor is the old world.
    // A re-open where you already are moves nothing, so it logs nothing.
    if (entry.type === 'Type') {
      const here = selection.kind === 'type' && selection.name === entry.title;
      const result = navigate({ kind: 'type', name: entry.title });
      if (!here) recordOpen(path);
      return result;
    }
    // Same rule for a container: its page IS the collection (M47.5). Routed
    // as a record it opened a `Collection` type screen that exists nowhere
    // else, with the container listed as a row of it.
    if (isCollectionPage(entry)) {
      const here = selection.kind === 'collection' && selection.folder === entry.folder;
      const result = navigate({ kind: 'collection', folder: entry.folder });
      if (!here) recordOpen(path);
      return result;
    }
    // M55.12: an agent opens as a page. Its body is its instructions, and its
    // grants are that page's own property rows — each writes one key on Done,
    // never a generic property table.
    const kind = libraryKind(entry);
    if (kind === 'agent') {
      return navigate({ kind: 'doc', path });
    }
    // M18: same rule, one level out. A skill's frontmatter is the app's own
    // contract — `allowed-tools:` is a boundary Rust enforces — so a skill or
    // a template opens in the Library editor that knows what those values
    // mean, never in a property table or a doc canvas. This is why a wikilink
    // to a template lands somewhere useful instead of in a body editor that
    // would let you break it.
    if (kind !== null) {
      return navigate({ kind: 'library', tab: kind, path });
    }
    // External app links are explicit page opens, so Back can return to the
    // linked record; a transient peek is deliberately not a history entry.
    if (!fullPage && !newPane && isRecordEntry(entry) && entry.type !== null) {
      // The backdrop jump: in-place callers get the panel and nothing else —
      // DetailPanel's breadcrumb is how you reach the container deliberately.
      // The backdrop is never the open; the record is, once, and a record
      // already in the panel is not opened again.
      const alreadyOpen = useUiStore.getState().detailPath === path;
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
      const result = useNavStore.getState().openPeek(path, { from: currentPane(), byAgent });
      if (!alreadyOpen && result.kind !== 'reused') recordOpen(path);
      return result;
    }
    return navigate({ kind: 'doc', path });
  };
}
