import { ReminderSettings, PERMISSION_WORDS } from '@/pages/ReminderSettings';
import { __seedNotifications } from '@/lib/mockIpc';
import type { NotificationPermission } from '@/lib/ipc';
import type { LabPreset, LabSection } from '../presets';
function state(permission: NotificationPermission): LabPreset {
  return {
    note: PERMISSION_WORDS[permission],
    seed: () => __seedNotifications(permission),
    expect: {
      present: [`[data-testid="notification-permission"][data-state="${permission}"]`],
      absent: ['[data-testid="section-unavailable"]'],
      text: PERMISSION_WORDS[permission],
    },
  };
}
export const section: LabSection = {
  id: 'reminder-settings',
  title: 'Reminders',
  surface: 'Settings',
  render: () => <ReminderSettings />,
  states: {
    ready: state('allowed'),
    empty: state('not-asked'),
    'not-recorded': state('unknown'),
    partial: state('quiet'),
    unavailable: {
      note: 'The permission read failed.',
      failNext: ['notification_permission'],
      expect: {
        present: ['[data-testid="section-unavailable"]'],
        text: 'Notification permission could not be read.',
      },
    },
  },
};
