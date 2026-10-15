import type { BandContext } from '@/engine/dateBuckets';
import { proposalRows } from '@/engine/homeLanes';
import { backSection, sectionize } from '@/engine/homeSections';
import { usePendingCards, usePendingWrites } from '@/knowledge/usePendingCards';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { Lane } from './Lane';

export function ProposalsLane({ now, ctx }: { now: Date; ctx: BandContext }) {
  const vault = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const cards = usePendingCards(vault),
    writes = usePendingWrites(vault);
  const data = proposalRows(
    cards.kind === 'ready' ? cards.data : [],
    writes.kind === 'ready' ? writes.data : [],
    entries,
  );
  if (cards.kind === 'unavailable') data.notes.push('Proposals could not be read.');
  if (writes.kind === 'unavailable')
    data.notes.push('Page writes waiting for your permission could not be read.');
  const state =
    cards.kind === 'unavailable' && writes.kind === 'unavailable'
      ? 'unavailable'
      : cards.kind === 'loading' || writes.kind === 'loading'
        ? 'loading'
        : data.notes.length > 0
          ? 'partial'
          : 'ready';
  return (
    <Lane
      id="proposals"
      state={state}
      data={data}
      sections={sectionize(
        data.rows,
        (row) => backSection(row.at, now, ctx),
        (a, b) => (b.at ?? '').localeCompare(a.at ?? ''),
      )}
      door="Open Review"
      onDoor={() => useNavStore.getState().navigate({ kind: 'knowledge', nav: { tab: 'review' } })}
    />
  );
}
