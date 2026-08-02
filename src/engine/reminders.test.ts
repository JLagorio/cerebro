import { describe, expect, it } from 'vitest';
import { collectReminders, dueReminders, reminderKey } from './reminders';

const BODY = [
  '# Plan',
  '- [ ] Ship the beta 📅 2026-07-30 ((remind:1d)) @[[maya-chen]]',
  'Kickoff is 📅 2026-08-01 09:30 ((remind:0d)) with the team.',
  '- [ ] No reminder here 📅 2026-07-28',
  '```',
  'fenced 📅 2026-07-29 ((remind:0d))',
  '```',
].join('\n');

describe('collectReminders', () => {
  it('finds reminder-bearing tokens and strips chrome from context', () => {
    const reminders = collectReminders('inbox/plan.md', BODY);
    expect(reminders).toHaveLength(2);
    expect(reminders[0]).toMatchObject({
      sourcePath: 'inbox/plan.md',
      line: 1,
      at: '2026-07-29T09:00',
      context: 'Ship the beta maya-chen',
    });
    expect(reminders[1]).toMatchObject({
      line: 2,
      at: '2026-08-01T09:30',
      context: 'Kickoff is with the team.',
    });
  });

  it('skips tokens without a remind flag and fenced code', () => {
    const paths = collectReminders('x.md', BODY).map((r) => r.line);
    expect(paths).not.toContain(3);
    expect(paths).not.toContain(5);
  });
});

describe('dueReminders', () => {
  const reminders = collectReminders('inbox/plan.md', BODY);

  it('fires only reminders that are due and unfired', () => {
    const due = dueReminders(reminders, '2026-07-29T09:05', new Set());
    expect(due).toHaveLength(1);
    expect(due[0].at).toBe('2026-07-29T09:00');
  });

  it('never re-fires an already-fired reminder', () => {
    const fired = new Set([reminderKey(reminders[0])]);
    expect(dueReminders(reminders, '2026-07-29T09:05', fired)).toHaveLength(0);
  });

  it('stays silent for reminders older than the grace window', () => {
    expect(dueReminders(reminders, '2026-08-15T12:00', new Set())).toHaveLength(0);
  });

  it('future reminders wait', () => {
    expect(dueReminders(reminders, '2026-07-28T12:00', new Set())).toHaveLength(0);
  });
});
