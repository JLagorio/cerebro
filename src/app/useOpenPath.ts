import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * How much a caller is allowed to move you (M9.3).
 *
 * `navigate` is the original open-by-kind rule (Tasks 10/11/14 — recents,
 * QuickOpen, wikilinks): those surfaces carry no canvas of their own, so a
 * work item is given its project as a backdrop before the panel opens.
 *
 * `in-place` is for surfaces that ARE the backdrop. A collection already
 * shows you the record in context; navigating away to show it again throws
 * away the list you were reading. Only a Project still moves, because a
 * project is a page and there is nothing to put in a panel.
 */
export type OpenMode = 'navigate' | 'in-place';

export function useOpenPath(mode: OpenMode = 'navigate'): (path: string) => void {
  const entries = useVaultStore((s) => s.entries);
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const openDetail = useUiStore((s) => s.openDetail);

  return (path) => {
    const entry = entries.find((e) => e.path === path);
    if (entry?.type === 'Project') {
      navigate({ kind: 'project', path });
      return;
    }
    if (entry?.type === 'Work item') {
      // The project jump is what made opening a row in a saved view land you
      // on a project page. In-place callers get the panel and nothing else;
      // DetailPanel's breadcrumb is how you reach the project deliberately.
      const onProject =
        entry.project !== null &&
        selection.kind === 'project' &&
        selection.path === entry.project;
      if (mode === 'navigate' && entry.project !== null && !onProject) {
        navigate({ kind: 'project', path: entry.project });
      }
      openDetail(path);
      return;
    }
    // A document has no panel form, so in-place callers still open it
    // full-page — there is no other way to show it.
    navigate({ kind: 'doc', path });
  };
}
