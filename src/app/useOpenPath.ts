import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The one open-by-kind rule (Tasks 10/11/14 — trees, recents, QuickOpen):
 * project.md IS the project, work items open the detail panel on their
 * project canvas, every other markdown file opens as a full-page document.
 */
export function useOpenPath(): (path: string) => void {
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
      const onProject =
        entry.project !== null &&
        selection.kind === 'project' &&
        selection.path === entry.project;
      if (entry.project !== null && !onProject) {
        navigate({ kind: 'project', path: entry.project });
      }
      openDetail(path);
      return;
    }
    navigate({ kind: 'doc', path });
  };
}
