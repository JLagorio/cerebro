import { MailSettings } from '@/app/MailSettings';
import { __seedConnectorStatus, __seedMailGate } from '@/lib/mockIpc';
import type { LabSection } from '../presets';
const seed = (body: string) => {
  (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs.set(
    'sources/mail/lab.md',
    body,
  );
};
const digest = (time: string) =>
  `---\ntype: Source\nsource_kind: thread\nsource_id: lab\n${time}---\n# Lab thread\n`;
export const section: LabSection = {
  id: 'mail-settings',
  title: 'Mail',
  surface: 'Settings',
  render: () => <MailSettings />,
  states: {
    ready: {
      note: 'One readable digest with its fetch time.',
      seed: () => {
        seed(digest('fetched_at: 2026-07-28T12:00:00Z\nlast_message_at: 2020-01-01T00:00:00Z\n'));
        __seedMailGate({ state: 'open', kinds: ['thread', 'thread_text'] });
        __seedConnectorStatus([
          {
            connector: 'gmail',
            cli_name: 'gmail',
            refused: null,
            state: 'working',
            signal: null,
            seen_at: null,
            run_id: null,
          },
        ]);
      },
      expect: {
        present: [
          '[data-testid="mail-cached"]',
          '[data-testid="mail-sweep"]',
          '[data-testid="mail-prune"]',
        ],
        text: '1 thread cached, the newest fetched',
      },
    },
    empty: {
      note: 'The scan found no mail.',
      expect: { present: ['[data-testid="mail-cached"]'], text: 'No mail cached.' },
    },
    'not-recorded': {
      note: 'The digest has no fetch time.',
      seed: () => seed(digest('')),
      expect: { present: ['[data-testid="mail-cached"]'], text: 'fetch time not recorded' },
    },
    partial: {
      note: 'A mail file has malformed metadata.',
      seed: () => seed('---\nbad: [\n---\n# Unreadable\n'),
      expect: { present: ['[data-testid="mail-cached"]'], text: '1 could not be read.' },
    },
    unavailable: {
      note: 'The cache scan failed.',
      failNext: ['scan_vault'],
      expect: {
        present: ['[data-testid="section-unavailable"]'],
        absent: ['[data-testid="mail-cached"]'],
        text: 'Cached mail could not be read',
      },
    },
  },
};
