import { isRecordEntry } from '@/engine/typeCatalog';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * How much a caller is allowed to move you (M9.3).
 *
 * `navigate` is the original open-by-kind rule (Tasks 10/11/14 — recents,
 * QuickOpen, wikilinks): those surfaces carry no canvas of their own, so a
 * record is given a backdrop — its project when it has one, its type screen
 * otherwise — before the panel opens.
 *
 * `in-place` is for surfaces that ARE the backdrop. A collection already
 * shows you the record in context; navigating away to show it again throws
 * away the list you were reading.
 */
export type OpenMode = 'navigate' | 'in-place';

/**
 * The one routing rule (M12.1): a RECORD — any typed entry — opens in the
 * detail panel, and a DOC — any untyped note — opens full-page in Docs.
 * Records never land in the doc editor; the two surfaces never blend.
 *
 * `type: Type` docs are the schema, so opening one goes to the type screen
 * it declares. Templates and the knowledge bundle carry types that are not
 * content types, so they keep their document form.
 */
export function useOpenPath(mode: OpenMode = 'navigate'): (path: string) => void {
  const entries = useVaultStore((s) => s.entries);
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const openDetail = useUiStore((s) => s.openDetail);

  return (path) => {
    const entry = entries.find((e) => e.path === path);
    if (entry === undefined) {
      navigate({ kind: 'doc', path });
      return;
    }
    if (entry.type === 'Project') {
      navigate({ kind: 'project', path });
      return;
    }
    // A Type doc IS its type screen — editing the schema by hand in a doc
    // editor is the old world.
    if (entry.type === 'Type') {
      navigate({ kind: 'type', name: entry.title });
      return;
    }
    if (isRecordEntry(entry) && entry.type !== null) {
      // The project jump is what made opening a row in a saved view land you
      // on a project page. In-place callers get the panel and nothing else;
      // DetailPanel's breadcrumb is how you reach the backdrop deliberately.
      if (mode === 'navigate') {
        const onProject =
          entry.project !== null &&
          selection.kind === 'project' &&
          selection.path === entry.project;
        const onType = selection.kind === 'type' && selection.name === entry.type;
        if (entry.project !== null && !onProject) {
          navigate({ kind: 'project', path: entry.project });
        } else if (entry.project === null && !onType) {
          navigate({ kind: 'type', name: entry.type });
        }
      }
      openDetail(path);
      return;
    }
    navigate({ kind: 'doc', path });
  };
}
