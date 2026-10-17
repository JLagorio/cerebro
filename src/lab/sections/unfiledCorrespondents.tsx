import { UnfiledCorrespondents } from '@/views/UnfiledCorrespondents';
import { __seedMailDismissals } from '@/lib/mockIpc';
import { composeNote } from '@/engine/frontmatter';
import { useVaultStore } from '@/stores/vaultStore';
import type { LabSection } from '../presets';
function seed(mail = true, matched = false, broken = false) {
  const disk = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  disk.set('types/lab-person.md', '---\ntype: Type\nfields:\n  email: email\n---\n# Lab person\n');
  if (mail)
    disk.set(
      'sources/mail/lab-unfiled.md',
      composeNote(
        {
          source_kind: 'thread',
          participants: ['friend@gmail.com', 'owner@our.example'],
          sent_to: ['friend@gmail.com'],
          owner_addresses: ['owner@our.example'],
          first_message_at: '2026-07-27T09:00:00Z',
          last_message_at: '2026-07-27T09:00:00Z',
          last_sent_at: '2026-07-27T09:00:00Z',
          last_from: 'owner@our.example',
          needs_reply: false,
          message_count: 1,
        },
        '# Hello\n',
      ),
    );
  if (matched)
    disk.set(
      'people/lab-friend.md',
      '---\ntype: Lab person\nemail: friend@gmail.com\n---\n# Friend\n',
    );
  if (broken)
    disk.set(
      'sources/mail/lab-broken.md',
      '---\nsource_kind: thread\nparticipants: [\n---\n# Broken\n',
    );
  __seedMailDismissals(useVaultStore.getState().vaultPath ?? '/demo-vault', []);
}
const BLOCK = '[data-testid="unfiled-correspondents"]';
export const section: LabSection = {
  id: 'unfiledCorrespondents',
  title: 'Unfiled correspondents',
  surface: 'Database › Unfiled correspondents',
  render: () => <UnfiledCorrespondents typeName="Lab person" onClose={() => {}} />,
  states: {
    ready: {
      note: 'Only a sent-to unfiled address appears.',
      seed: () => seed(),
      expect: { present: [`${BLOCK}[data-state="ready"]`], text: 'friend@gmail.com' },
    },
    empty: {
      note: 'Every sent-to address is held by a declared page.',
      seed: () => seed(true, true),
      expect: {
        present: [`${BLOCK}[data-state="empty"]`],
        text: 'No unfiled correspondents.',
      },
    },
    'not-recorded': {
      note: 'No mail has been cached.',
      seed: () => seed(false),
      expect: { present: [`${BLOCK}[data-state="not-recorded"]`], text: 'No mail cached.' },
    },
    partial: {
      note: 'Readable sent-to rows coexist with an unreadable digest.',
      seed: () => seed(true, false, true),
      expect: {
        present: [`${BLOCK}[data-state="partial"]`],
        text: '1 cached thread could not be read.',
      },
    },
    unavailable: {
      note: 'A failed operational read cannot mean no dismissals.',
      seed: () => seed(),
      failNext: ['mail_dismissals_read'],
      expect: {
        present: ['[data-testid="section-unavailable"]'],
        text: 'Dismissals or cached mail could not be read.',
      },
    },
  },
};
