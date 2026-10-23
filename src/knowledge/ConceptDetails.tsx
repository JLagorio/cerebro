import { useOpenPath } from '@/app/useOpenPath';
import { InspectorSection } from '@/detail/InspectorSection';
import type { Concept } from '@/engine/okf';
import { KnowledgePanel } from '@/knowledge/KnowledgePanel';
import { chipsFor, useBeliefChips } from '@/knowledge/useBeliefChips';
import { todayIso } from '@/lib/templates';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * A concept page's Details panel (M50.1; M51.3): the provenance a person
 * judges a claim by, as the panel's first section — where a page's Properties sit. The
 * two acts that follow from it — Verify, and asking for a revision — are the
 * review bar's, under the title (`ConceptReviewBar`).
 */
export function ConceptDetails({ concept }: { concept: Concept }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const navigate = useNavStore((s) => s.navigate);
  const openPath = useOpenPath();
  const chipIndex = useBeliefChips(vaultPath);
  return (
    <InspectorSection id="concept" label="Concept">
      <KnowledgePanel
        concept={concept}
        today={todayIso()}
        chips={chipsFor(chipIndex, concept.entry.path)}
        onOpenEntity={openPath}
        onOpenConcept={(path) => navigate({ kind: 'doc', path })}
      />
    </InspectorSection>
  );
}
