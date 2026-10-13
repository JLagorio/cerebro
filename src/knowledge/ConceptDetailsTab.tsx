import { useOpenPath } from '@/app/useOpenPath';
import type { Concept } from '@/engine/okf';
import { KnowledgePanel } from '@/knowledge/KnowledgePanel';
import { chipsFor, useBeliefChips } from '@/knowledge/useBeliefChips';
import { todayIso } from '@/lib/templates';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * A concept page's Details tab (M50.1; M51.3): the provenance a person judges
 * a claim by. The two acts that follow from it — Verify, and asking for a
 * revision — are the review bar's, under the title (`ConceptReviewBar`).
 */
export function ConceptDetailsTab({ concept }: { concept: Concept }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const navigate = useNavStore((s) => s.navigate);
  const openPath = useOpenPath();
  const chipIndex = useBeliefChips(vaultPath);
  return (
    <KnowledgePanel
      concept={concept}
      today={todayIso()}
      chips={chipsFor(chipIndex, concept.entry.path)}
      onOpenEntity={openPath}
      onOpenConcept={(path) => navigate({ kind: 'doc', path })}
    />
  );
}
