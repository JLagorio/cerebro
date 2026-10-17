import { normalizeAddress } from './mailAddress';

/** Cerebro's role-address heuristic, authored here; it never infers a person. */
const ROLES = new Set([
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'notifications',
  'notification',
  'alerts',
  'mailer-daemon',
  'postmaster',
  'bounce',
  'bounces',
  'info',
  'support',
  'help',
  'hello',
  'contact',
  'sales',
  'billing',
  'invoices',
  'accounts',
  'admin',
  'team',
  'news',
  'newsletter',
  'updates',
  'marketing',
  'feedback',
  'careers',
  'jobs',
  'press',
  'privacy',
  'security',
  'legal',
  'webmaster',
  'receipts',
  'orders',
  'service',
  'calendar-notification',
]);
const PREFIXES = ['noreply-', 'no-reply-', 'bounce-', 'notifications-'];
export function isRoleAddress(value: string): boolean {
  const local = normalizeAddress(value)?.split('@')[0].split('+')[0];
  return (
    local !== undefined &&
    (ROLES.has(local) ||
      PREFIXES.some((prefix) => local.startsWith(prefix)) ||
      /^[a-f0-9-]{20,}$/.test(local) ||
      /^\d{10,}$/.test(local))
  );
}
