import {
  __seedReview,
  __seedFileTimes,
  __seedActivity,
  __seedFleet,
  __seedChanges,
  __seedReminderFires,
} from '@/lib/mockIpc';
import { demoReviewCards, demoFleetRuns, demoChanges } from '@/lib/demoOperational';
import { useUiStore } from '@/stores/uiStore';
import type { LabPreset, LabState } from '@/lab/presets';
import type { HomeLaneId } from '@/engine/homeLanes';
import type { ActivityWrite } from '@/engine/activity';
import { useDoneMarksStore } from '@/stores/doneMarksStore';
import { useReminderStore } from '@/stores/reminderStore';
import type { ReminderFire } from '@/engine/reminderState';

const disk = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
function clean() {
  disk().clear();
  __seedReview({ cards: [], applications: [] });
  useDoneMarksStore.getState().reset(null);
  useReminderStore.getState().reset('/demo-vault');
  useUiStore.setState({ inboxEnabled: true, inboxPeriod: 'all', homeTaskAssignee: '' });
}
const TASK_TYPE =
  '---\ntype: Type\ndeadline: due\nstatuses:\n  - {id: open, group: active}\nfields:\n  status: {kind: status}\n  due: {kind: date}\n---\n# Work\n';
const EVENT_TYPE = '---\ntype: Type\nfields:\n  when: {kind: date}\n---\n# Event\n';
const lane = (id: string) => `[data-testid="home-lane"][data-lane="${id}"]`;
const ready = (id: string, text: string): LabPreset['expect'] => ({
  present: [lane(id)],
  absent: ['[data-testid="section-unavailable"]'],
  text,
});
const empty = (id: string): LabPreset['expect'] => ({ present: [], absent: [lane(id)] });
const unavailable = {
  present: ['[data-testid="section-unavailable"]'],
  absent: ['[data-testid="home-row"]'],
};
const proposal = (at: string | null) => ({ ...demoReviewCards()[0], submitted_at: at });
const edit = (at = '2026-07-28T11:58:00Z'): Omit<ActivityWrite, 'content'> => ({
  path: 'docs/edited.md',
  kind: 'vault.write',
  to: null,
  actor: 'human:me',
  run_id: null,
  approved_by: null,
  first_at: at,
  at,
});
function seedEdits(writes: Omit<ActivityWrite, 'content'>[]) {
  clean();
  disk().set('docs/edited.md', '# Delivery notes\n');
  __seedActivity({ writes });
}
const homeRun = (extra = {}) => ({
  ...demoFleetRuns().find((run) => run.actor === 'process:release-scout')!,
  ...extra,
});
const reminderFire = (extra: Partial<ReminderFire> = {}): ReminderFire => ({
  path: 'docs/reminder.md',
  chip: '0123456789abcdef',
  ordinal: 0,
  fireAt: '2026-07-28T11:58',
  claimedAt: '2026-07-28T11:58:00Z',
  outcome: 'fired',
  ...extra,
});
function seedReminder(removed = false) {
  clean();
  disk().set('docs/reminder.md', '# Supplier call\n');
  __seedReminderFires('/demo-vault', [reminderFire()]);
  if (!removed)
    useReminderStore.getState().setReminders('/demo-vault', [
      {
        sourcePath: 'docs/reminder.md',
        chip: '0123456789abcdef',
        ordinal: 0,
        at: '2026-07-28T11:58',
        context: 'Call the vendor',
        line: 0,
      },
    ]);
}
export const HOME_PRESETS: {
  id: HomeLaneId;
  title: string;
  states: Record<LabState, LabPreset>;
}[] = [
  {
    id: 'mywork',
    title: 'Home · My work',
    states: {
      ready: {
        note: 'A declared deadline leads the document checklist.',
        seed: () => {
          clean();
          disk().set('types/work.md', TASK_TYPE);
          disk().set(
            'work/late.md',
            '---\ntype: Work\nstatus: open\ndue: 2026-07-27\n---\n# Confirm scope\n',
          );
          disk().set('docs/ready.md', '# Plan\n- [ ] Call the vendor\n');
        },
        expect: ready('mywork', '1 overdue · 1 open task'),
      },
      empty: {
        note: 'No deadlines and no checklist tasks; the lane stays silent.',
        seed: clean,
        expect: empty('mywork'),
      },
      'not-recorded': {
        note: 'An open task has no date; it stays under No date.',
        seed: () => {
          clean();
          disk().set('docs/no-date.md', '# Plan\n- [ ] Ask about delivery\n');
        },
        expect: ready('mywork', 'No date'),
      },
      partial: {
        note: 'A note body cannot be read; its name is held on the lane.',
        seed: () => {
          clean();
          disk().set('docs/unreadable.md', '# Delivery plan\n- [ ] Check delivery\n');
        },
        failNext: ['read_note_source'],
        expect: ready('mywork', 'Tasks could not be read in Delivery plan.'),
      },
      unavailable: {
        note: 'The vault scan failed.',
        seed: clean,
        failNext: ['scan_vault'],
        expect: unavailable,
      },
    },
  },
  {
    id: 'proposals',
    title: 'Home · Waiting on you',
    states: {
      ready: {
        note: 'One proposal received two minutes ago.',
        seed: () => {
          clean();
          __seedReview({ cards: [proposal('2026-07-28T11:58:00Z')] });
        },
        expect: ready('proposals', 'Last few minutes'),
      },
      empty: {
        note: 'Both queues read successfully and contain no rows.',
        seed: clean,
        expect: empty('proposals'),
      },
      'not-recorded': {
        note: 'A legacy proposal has no recorded submission time.',
        seed: () => {
          clean();
          __seedReview({ cards: [proposal(null)] });
        },
        expect: ready('proposals', 'When not recorded'),
      },
      partial: {
        note: 'The proposal queue reads but the page-write queue fails.',
        seed: () => {
          clean();
          __seedReview({ cards: [proposal('2026-07-28T11:58:00Z')] });
        },
        failNext: ['pending_writes'],
        expect: ready('proposals', 'Page writes waiting for your permission could not be read.'),
      },
      unavailable: {
        note: 'Neither waiting queue can be read.',
        seed: clean,
        failNext: ['review_queue', 'pending_writes'],
        expect: unavailable,
      },
    },
  },
  {
    id: 'captures',
    title: 'Home · Captures',
    states: {
      ready: {
        note: 'An untyped capture is ready to organize.',
        seed: () => {
          clean();
          disk().set('inbox/capture.md', '# Notes from the supplier\n');
          __seedFileTimes('inbox/capture.md', {
            createdAt: '2026-07-28T11:58:00Z',
            modifiedAt: '2026-07-28T11:58:00Z',
          });
        },
        expect: ready('captures', '1 capture to organize'),
      },
      empty: { note: 'No unorganized captures.', seed: clean, expect: empty('captures') },
      'not-recorded': {
        note: 'A capture with no recorded creation time remains visible.',
        seed: () => {
          clean();
          disk().set('inbox/unknown.md', '# Untimed capture\n');
          __seedFileTimes('inbox/unknown.md', { createdAt: '', modifiedAt: '' });
        },
        expect: ready('captures', 'When not recorded'),
      },
      partial: {
        note: 'One timed capture and one with no recorded time.',
        seed: () => {
          clean();
          disk().set('inbox/dated.md', '# Dated capture\n');
          disk().set('inbox/untimed.md', '# Untimed capture\n');
          __seedFileTimes('inbox/dated.md', { createdAt: '2026-07-28T11:58:00Z', modifiedAt: '' });
          __seedFileTimes('inbox/untimed.md', { createdAt: '', modifiedAt: '' });
        },
        expect: ready('captures', 'When not recorded'),
      },
      unavailable: {
        note: 'The vault scan failed; an empty Inbox cannot be claimed.',
        seed: clean,
        failNext: ['scan_vault'],
        expect: unavailable,
      },
    },
  },
  {
    id: 'runs',
    title: 'Home · Agents',
    states: {
      ready: {
        note: 'A finished unattended run says why it started.',
        seed: () => {
          clean();
          __seedFleet([homeRun()]);
        },
        expect: ready('runs', '1 run ended'),
      },
      empty: {
        note: 'No unattended runs finished.',
        seed: () => {
          clean();
          __seedFleet([]);
        },
        expect: empty('runs'),
      },
      'not-recorded': {
        note: 'A legacy run has no recorded actor or cause.',
        seed: () => {
          clean();
          __seedFleet([homeRun({ actor: null, cause: null })]);
        },
        expect: ready('runs', 'why not recorded'),
      },
      partial: {
        note: 'The runs read reaches its limit.',
        seed: () => {
          clean();
          __seedFleet(
            Array.from({ length: 201 }, (_, index) => homeRun({ run_id: `run-${index}` })),
          );
        },
        expect: ready('runs', 'Only the newest 200 finished runs are counted.'),
      },
      unavailable: {
        note: 'The runs read failed.',
        seed: clean,
        failNext: ['home_runs'],
        expect: unavailable,
      },
    },
  },
  {
    id: 'reminders',
    title: 'Home · Reminders',
    states: {
      ready: {
        note: 'One fired reminder.',
        seed: () => seedReminder(),
        expect: ready('reminders', 'Call the vendor'),
      },
      empty: {
        note: 'No reminder claims.',
        seed: () => {
          clean();
          __seedReminderFires('/demo-vault', []);
        },
        expect: empty('reminders'),
      },
      'not-recorded': {
        note: 'The reminder chip was removed, but its claim remains.',
        seed: () => seedReminder(true),
        expect: ready('reminders', '(since removed)'),
      },
      partial: {
        note: 'Claims are readable but Done marks failed; Done is disabled.',
        seed: () => seedReminder(),
        failNext: ['done_marks_read'],
        expect: {
          ...ready('reminders', 'Done history could not be read'),
          present: [lane('reminders'), '[data-testid="home-row-done"][disabled]'],
        },
      },
      unavailable: {
        note: 'Reminder history could not be read.',
        seed: clean,
        failNext: ['reminder_state'],
        expect: unavailable,
      },
    },
  },
  {
    id: 'changes',
    title: 'Home · Knowledge changed',
    states: {
      ready: {
        note: 'Changes since the last convergence run.',
        seed: () => {
          clean();
          __seedChanges(demoChanges());
        },
        expect: ready('changes', 'since the last convergence run'),
      },
      empty: {
        note: 'A quiet window stays silent.',
        seed: () => {
          clean();
          __seedChanges({ ...demoChanges(), quiet: true });
        },
        expect: empty('changes'),
      },
      'not-recorded': {
        note: 'No Knowledge ledger has been recorded.',
        seed: () => {
          clean();
          __seedChanges(null);
        },
        expect: empty('changes'),
      },
      partial: {
        note: 'Changes read, but the Done boundary could not be read.',
        seed: () => {
          clean();
          __seedChanges(demoChanges());
        },
        failNext: ['done_marks_read'],
        expect: ready('changes', 'Done history could not be read'),
      },
      unavailable: {
        note: 'The Knowledge change read failed.',
        seed: clean,
        failNext: ['home_changes'],
        expect: unavailable,
      },
    },
  },
  {
    id: 'edits',
    title: 'Home · Your recent edits',
    states: {
      ready: {
        note: 'Five recorded edits fold into one page.',
        seed: () =>
          seedEdits([edit('2026-01-01T12:00:00Z'), ...Array.from({ length: 5 }, () => edit())]),
        expect: ready('edits', 'edited 5 times'),
      },
      empty: {
        note: 'Recording began long ago, with no edits in the window.',
        seed: () => seedEdits([edit('2026-01-01T12:00:00Z')]),
        expect: empty('edits'),
      },
      'not-recorded': {
        note: 'The first recorded edit was today; earlier days are unknown.',
        seed: () => seedEdits([edit()]),
        expect: ready('edits', "Edits before Tue, Jul 28, 2026 weren't recorded."),
      },
      partial: {
        note: 'The write read reached its cap and says more edits exist.',
        seed: () => seedEdits(Array.from({ length: 20_001 }, () => edit())),
        expect: ready('edits', 'More edits were recorded than could be read.'),
      },
      unavailable: {
        note: 'The activity read failed.',
        seed: () => seedEdits([]),
        failNext: ['vault_activity'],
        expect: unavailable,
      },
    },
  },
  {
    id: 'comingup',
    title: 'Home · Coming up',
    states: {
      ready: {
        note: 'A declared event date is tomorrow.',
        seed: () => {
          clean();
          disk().set('types/event.md', EVENT_TYPE);
          disk().set(
            'events/one.md',
            '---\ntype: Event\nwhen: 2026-07-29\n---\n# Supplier visit\n',
          );
        },
        expect: ready('comingup', 'Tomorrow'),
      },
      empty: {
        note: 'No dated records in the next seven days.',
        seed: clean,
        expect: empty('comingup'),
      },
      'not-recorded': {
        note: 'A record with no date is not a scheduled event; this lane stays silent.',
        seed: () => {
          clean();
          disk().set('types/event.md', EVENT_TYPE);
          disk().set('events/no-date.md', '---\ntype: Event\n---\n# Unscheduled visit\n');
        },
        expect: empty('comingup'),
      },
      partial: {
        note: 'An unreadable date is named beside the readable event.',
        seed: () => {
          clean();
          disk().set('types/event.md', EVENT_TYPE);
          disk().set(
            'events/good.md',
            '---\ntype: Event\nwhen: 2026-07-29\n---\n# Supplier visit\n',
          );
          disk().set('events/bad.md', '---\ntype: Event\nwhen: someday\n---\n# Unclear visit\n');
        },
        expect: ready('comingup', 'Dates could not be read on Unclear visit · When.'),
      },
      unavailable: {
        note: 'The vault scan failed.',
        seed: clean,
        failNext: ['scan_vault'],
        expect: unavailable,
      },
    },
  },
];
