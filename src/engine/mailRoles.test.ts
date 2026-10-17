import { describe, expect, it } from 'vitest';
import { isRoleAddress } from './mailRoles';

describe('Cerebro role addresses', () => {
  it.each([
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
    'noreply-ticket',
    'no-reply-ticket',
    'bounce-ticket',
    'notifications-ticket',
    '0123456789abcdefabcd',
    '550e8400-e29b-41d4-a716-446655440000',
    '1234567890',
    'SUPPORT+case-123',
  ])('keeps %s out of people suggestions', (local) => {
    expect(isRoleAddress(`${local}@acme.example`)).toBe(true);
  });
  it('keeps named people and short identifiers', () => {
    for (const local of ['dana', 'jane+news', '123456789', 'abcdef', 'supporter'])
      expect(isRoleAddress(`${local}@acme.example`)).toBe(false);
    expect(isRoleAddress('invalid')).toBe(false);
  });
});
