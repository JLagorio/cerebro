import { MentionResults } from '@/knowledge/MentionResults';
import type { OccurrenceMode } from '@/engine/sourceOccurrences';
import type { LabSection } from '../presets';
import { useNavStore } from '@/stores/navStore';
const TARGET = 'notes/lab-occurrence-target.md';
const SOURCE = 'notes/lab-occurrence-source.md';
let mode: OccurrenceMode = 'linked';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
function seed(body?: string, nextMode: OccurrenceMode = 'linked') {
  mode = nextMode;
  useNavStore.getState().reset();
  fs().clear();
  fs().set(TARGET, '# Occurrence target\n');
  if (body !== undefined) fs().set(SOURCE, body);
}
const ROW = '[data-testid="source-occurrences-count"]';
const EMPTY = '[data-testid="source-occurrences-empty"]';
const PARTIAL = '[data-testid="source-occurrences-partial"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';
export const section: LabSection = {
  id: 'source-occurrences',
  title: 'Backlinks and mentions',
  surface: 'A page · Details',
  render: () => <MentionResults targetPath={TARGET} mode={mode} />,
  states: {
    ready: {
      note: 'Two repeated raw links on one source page retain separate locations.',
      seed: () =>
        seed('Before [[lab-occurrence-target|one]] and [[lab-occurrence-target#Notes|two]].'),
      expect: {
        present: [ROW],
        absent: [EMPTY, PARTIAL, UNAVAILABLE],
        text: '2 occurrences on 1 page',
      },
    },
    empty: {
      note: 'The readable corpus was examined and contains no link to this page.',
      seed: () => seed(),
      expect: { present: [EMPTY], absent: [PARTIAL, UNAVAILABLE] },
    },
    'not-recorded': {
      note: 'No mention query has been requested; there is no recorded result to interpret as empty.',
      seed: () => seed('Occurrence target is here.', 'mention'),
      expect: {
        present: ['[data-testid="source-occurrences-not-searched"]'],
        absent: [ROW, EMPTY, PARTIAL, UNAVAILABLE],
        text: 'Search mentions',
      },
    },
    partial: {
      note: 'The source body reaches the existing 100 KiB cap; the known occurrence opens but coverage is partial.',
      seed: () => seed('[[lab-occurrence-target]] ' + 'x'.repeat(102400)),
      expect: { present: [ROW, PARTIAL], absent: [EMPTY, UNAVAILABLE] },
    },
    unavailable: {
      note: 'The occurrence query fails; no empty result is claimed.',
      seed: () => seed(),
      failNext: ['find_source_occurrences'],
      expect: { present: [UNAVAILABLE], absent: [ROW, EMPTY] },
    },
  },
};
