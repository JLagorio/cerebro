import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  notificationPermission,
  requestNotificationPermission,
  type NotificationPermission,
} from '@/lib/ipc';

export const PERMISSION_WORDS: Record<NotificationPermission, string> = {
  allowed: 'Allowed. A reminder also shows in Notification Center.',
  quiet: 'Allowed quietly. Reminders go to Notification Center without a banner.',
  denied:
    'Off. Turn on Cerebro in System Settings → Notifications to see reminders there. They still show in Cerebro.',
  'not-asked': 'Not asked yet.',
  unknown: 'Unknown. Only the installed app can read this. Reminders still show in Cerebro.',
};
export function ReminderSettings() {
  const [permission, setPermission] = useState<NotificationPermission | 'loading' | 'unavailable'>(
    'loading',
  );
  const [asking, setAsking] = useState(false);
  const generation = useRef(0);
  const requesting = useRef(false);
  useEffect(() => {
    const read = async () => {
      if (requesting.current) return;
      const token = ++generation.current;
      try {
        const state = await notificationPermission();
        if (token === generation.current) setPermission(state);
      } catch {
        if (token === generation.current) setPermission('unavailable');
      }
    };
    const invalidate = () => {
      generation.current++;
    };
    void read();
    window.addEventListener('focus', read);
    return () => {
      invalidate();
      window.removeEventListener('focus', read);
    };
  }, []);
  const ask = async () => {
    if (asking || permission !== 'not-asked') return;
    requesting.current = true;
    setAsking(true);
    const token = ++generation.current;
    try {
      const state = await requestNotificationPermission();
      if (token === generation.current) setPermission(state);
    } catch {
      if (token === generation.current) setPermission('unavailable');
    } finally {
      requesting.current = false;
      if (token === generation.current) setAsking(false);
    }
  };
  return (
    <section className="mb-6 rounded-xl border border-n-200 p-5" data-testid="settings-reminders">
      <h2 className="mb-1 text-md font-semibold text-n-900">Reminders</h2>
      {permission === 'unavailable' ? (
        <p className="m-0 text-sm text-n-500" data-testid="section-unavailable">
          Notification permission could not be read.
        </p>
      ) : (
        <p
          className="mb-3 text-sm text-n-500"
          data-testid="notification-permission"
          data-state={permission}
        >
          {permission === 'loading'
            ? 'Reading notification permission…'
            : PERMISSION_WORDS[permission]}
        </p>
      )}
      {permission === 'not-asked' && (
        <Button size="sm" testId="reminders-allow" disabled={asking} onClick={() => void ask()}>
          Allow notifications
        </Button>
      )}
    </section>
  );
}
