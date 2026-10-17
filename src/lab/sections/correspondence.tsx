import { useEffect } from 'react';
import { CorrespondenceSection } from '@/detail/CorrespondenceSection';
import { armedFaults } from '@/lib/mockFaults';
import { useEntry, useSchema, useVaultStore } from '@/stores/vaultStore';
import DIGESTS from '../../../src-tauri/fixtures/thread-digests.json';
import type { LabSection } from '../presets';

const PATH = 'contacts/lab-correspondence.md';
const content = DIGESTS.find((row) => row.name === 'two-people-replied')!.content!;
function seed(address = 'dana@example.test', broken = false): void {
  const disk = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  disk.set(
    'types/lab-contact.md',
    '---\ntype: Type\nfields:\n  email: email\n---\n# Lab contact\n',
  );
  disk.set(PATH, `---\ntype: Lab contact\nemail: ${address}\n---\n# Dana contact\n`);
  disk.set('sources/mail/lab-thread.md', content);
  if (broken)
    disk.set(
      'sources/mail/lab-broken.md',
      '---\nsource_kind: thread\nparticipants: [\n---\n# Unreadable\n',
    );
}
function Stage() {
  const entry = useEntry(PATH);
  const schema = useSchema();
  useEffect(() => {
    const vault = useVaultStore.getState().vaultPath;
    if (vault !== null && armedFaults().scan_vault !== undefined)
      void useVaultStore.getState().openVault(vault);
  }, []);
  return entry === null ? null : <CorrespondenceSection entry={entry} schema={schema} />;
}
const BLOCK = '[data-testid="correspondence-section"]';
export const section: LabSection = {
  id: 'correspondence',
  title: 'Correspondence',
  surface: 'Record page › Correspondence',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'A declared address matches a cached thread.',
      seed: () => seed(),
      expect: { present: [`${BLOCK}[data-state="ready"]`], text: 'Last message' },
    },
    empty: {
      note: 'Mail is cached, but this address has no matching thread.',
      seed: () => seed('none@example.test'),
      expect: {
        present: [`${BLOCK}[data-state="empty"]`],
        text: 'No cached thread includes none@example.test.',
      },
    },
    'not-recorded': {
      note: 'A SENT header identifies the owner, whose own contact has no counterpart match.',
      seed: () => seed('owner@example.test'),
      expect: { present: [`${BLOCK}[data-state="not-recorded"]`], text: 'This is you' },
    },
    partial: {
      note: 'A readable thread and an unreadable cache remain distinct.',
      seed: () => seed('dana@example.test', true),
      expect: {
        present: [`${BLOCK}[data-state="partial"]`],
        text: '1 cached thread could not be read.',
      },
    },
    unavailable: {
      note: 'A failed scan cannot tell whether any thread matches.',
      seed: () => seed(),
      failNext: ['scan_vault'],
      expect: {
        present: ['[data-testid="section-unavailable"]'],
        text: 'correspondence is unavailable',
      },
    },
  },
};
