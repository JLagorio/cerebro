import cases from '../../../src-tauri/fixtures/pr-cases.json';
import { PullRequestStrip } from '@/detail/PullRequestStrip';
import type { PrRead } from '@/engine/pullRequest';
import { buildSchema } from '@/engine/schema';
import { seedPullRequests } from '@/lib/mockGit';
import { useVaultStore } from '@/stores/vaultStore';
import type { LabSection } from '../presets';
const PATH = 'records/pr-example.md';
const URL = 'https://github.com/acme/notes/pull/42';
function seed(name: string | null, body = URL) {
  const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  fs.set(PATH, `# Pull request example\n\n${body}\n`);
  seedPullRequests(
    name === null ? {} : { [URL]: cases.cases.find((row) => row.name === name)!.expect as PrRead },
  );
}
function Stage() {
  const entries = useVaultStore((s) => s.entries);
  const entry = entries.find((e) => e.path === PATH);
  return entry === undefined ? null : (
    <PullRequestStrip entry={entry} schema={buildSchema(entries)} />
  );
}
const CHIP = '[data-testid="pr-chip"]';
const UNAVAILABLE = '[data-testid="section-unavailable"]';
export const section: LabSection = {
  id: 'pull-request-strip',
  title: 'Pull requests',
  surface: 'A page or its peek',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'A reported successful check is ready.',
      seed: () => seed(cases.cases[0].name),
      expect: { present: [`${CHIP}[data-readiness="ready"]`], absent: [UNAVAILABLE] },
    },
    empty: {
      note: 'The page contains no pull request links.',
      seed: () => seed(null, ''),
      expect: { present: [], absent: [CHIP, UNAVAILABLE] },
    },
    'not-recorded': {
      note: 'GitHub did not report a check rollup; this is unknown, not no checks.',
      seed: () => seed('null-rollup'),
      expect: { present: [`${CHIP}[data-readiness="checks_unknown"]`], text: 'checks unknown' },
    },
    partial: {
      note: 'A check type this reader does not understand keeps readiness unknown.',
      seed: () => seed('unknown-typename'),
      expect: { present: [`${CHIP}[data-readiness="checks_unknown"]`], text: 'checks unknown' },
    },
    unavailable: {
      note: 'The page body could not be read; its links are unavailable.',
      seed: () => seed(null),
      failNext: ['read_note_source'],
      expect: {
        present: [UNAVAILABLE],
        absent: [CHIP],
        text: 'Pull request links could not be read.',
      },
    },
  },
};
