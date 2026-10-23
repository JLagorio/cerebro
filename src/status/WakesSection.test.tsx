// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { __seedWakes, resetMockFs, type SeedWake } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { WakesSection } from './WakesSection';

/*
 * Waiting to wake (M63.1b): the lobby's and an agent's Runs tab's list of
 * what is waiting to wake an agent, over the real mock wake store.
 */
const VAULT = '/demo-vault';
const SCOUT = 'process:release-scout';
/** The scout's bare identity, the cooldown clock's key: it declares a slug. */
const SCOUT_ID = 'slug:release-scout';
const PAGE = 'projects/guided-onboarding-ga/items/fld-1.md';
const MINUTE = 60_000;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

function pending(over: Partial<SeedWake> = {}): SeedWake {
  return {
    vault: VAULT,
    agent: SCOUT,
    admittedAt: ago(5 * MINUTE),
    cause: { kind: 'event', subject: PAGE, detail: 'it changes in projects' },
    ...over,
  };
}

const rows = () => screen.getAllByTestId('agent-wake');

describe('WakesSection', () => {
  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault(VAULT);
    useUiStore.setState({ triggerRuns: {}, wakesRevision: 0 });
    useNavStore.setState({ selection: { kind: 'agents' } });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('names recorded writers and never labels an unrecorded writer as a person', async () => {
    __seedWakes([
      pending({ author: 'person', authorActor: 'human:me' }),
      pending({ author: 'run', authorActor: 'claude-code' }),
      pending({ author: 'run', authorActor: SCOUT }),
      pending({ author: 'not_recorded' }),
      pending({ author: null }),
    ]);
    render(<WakesSection vaultPath={VAULT} />);
    const authors = await screen.findAllByTestId('agent-wake-author');
    expect(authors.map((row) => row.textContent)).toEqual([
      'by You',
      'by Assistant',
      'by Release scout',
      'author not recorded',
      'author not recorded',
    ]);
  });

  it('shows each recorded chain refusal in its own words', async () => {
    __seedWakes(
      ['cycle', 'hop_limit', 'chain_spent'].map((reason) =>
        pending({ outcome: 'skipped', reason, finishedAt: ago(MINUTE) }),
      ),
    );
    render(<WakesSection vaultPath={VAULT} />);
    const words = (await screen.findAllByTestId('agent-wake-words')).map((row) => row.textContent);
    expect(words.some((word) => word?.includes('would wake itself'))).toBe(true);
    expect(words.some((word) => word?.includes('second hop'))).toBe(true);
    expect(words.some((word) => word?.includes('spent its allowance'))).toBe(true);
  });

  it('renders both condition skips with the question and reason as plain text', async () => {
    __seedWakes(
      ['condition_not_met', 'condition_unavailable'].map((reason) =>
        pending({
          outcome: 'skipped',
          reason,
          finishedAt: ago(MINUTE),
          note: {
            question: 'Is <b>this</b> urgent?',
            reason:
              reason === 'condition_not_met'
                ? 'No <img src=x> work is due.'
                : 'no answer within 10 minutes',
          },
        }),
      ),
    );
    const { container } = render(<WakesSection vaultPath={VAULT} />);
    const checks = await screen.findAllByTestId('agent-wake-check');
    expect(checks.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([
        '“Is <b>this</b> urgent?” — No <img src=x> work is due.',
        '“Is <b>this</b> urgent?” — no answer within 10 minutes',
      ]),
    );
    expect(container.querySelector('b,img')).toBeNull();
    expect(
      rows()
        .map((row) => row.textContent)
        .join(' '),
    ).toContain("skipped — its check couldn't answer");
  });

  it('names the next retry while an unanswered check waits', async () => {
    __seedWakes([pending({ notBefore: ahead(3 * MINUTE) })]);
    render(<WakesSection vaultPath={VAULT} />);
    expect((await screen.findByTestId('agent-wake-waits')).textContent).toMatch(
      /^its check couldn't answer · tries again /,
    );
  });

  it('identifies the unfinished read without claiming that nothing waits', () => {
    vi.spyOn(ipc, 'fleetWakes').mockImplementation(() => new Promise(() => undefined));
    render(<WakesSection vaultPath={VAULT} />);
    expect(screen.getByRole('status').textContent).toBe('Reading waiting work…');
    expect(screen.queryByTestId('agent-wakes-empty')).toBeNull();
  });

  it('a failed read says it could not tell, never that nothing waits', async () => {
    __seedWakes(null);
    render(<WakesSection vaultPath={VAULT} />);
    expect(await screen.findByTestId('agent-wakes-unavailable')).toHaveProperty(
      'textContent',
      "Couldn't read what is waiting to wake your agents.",
    );
    expect(screen.queryByTestId('agent-wakes-empty')).toBeNull();
    expect(screen.queryAllByTestId('agent-wake')).toHaveLength(0);
  });

  it('says nothing waits in the lobby, and on an agent page says it of that agent', async () => {
    render(<WakesSection vaultPath={VAULT} />);
    expect((await screen.findByTestId('agent-wakes-empty')).textContent).toBe(
      'Nothing is waiting to wake an agent.',
    );
    cleanup();
    render(<WakesSection vaultPath={VAULT} actor={SCOUT} />);
    expect((await screen.findByTestId('agent-wakes-empty')).textContent).toBe(
      'Nothing is waiting to wake it.',
    );
  });

  it('carries the coalescing line in its header', async () => {
    render(<WakesSection vaultPath={VAULT} />);
    const section = await screen.findByTestId('agent-wakes');
    expect(section.textContent).toContain('Waiting to wake');
    expect(section.textContent).toContain(
      'Changes that arrive while an agent waits wake it once, together — up to 20 in one run.',
    );
  });

  it('lists pending, skipped and expired rows, each in its own words', async () => {
    __seedWakes([
      pending(),
      pending({
        admittedAt: ago(9 * MINUTE),
        finishedAt: ago(2 * MINUTE),
        outcome: 'skipped',
        reason: 'cycle',
      }),
      pending({
        admittedAt: ago(8 * 24 * 60 * MINUTE),
        finishedAt: ago(60 * MINUTE),
        outcome: 'cancelled',
        reason: 'expired',
      }),
    ]);
    render(<WakesSection vaultPath={VAULT} />);
    await screen.findAllByTestId('agent-wake');
    expect(rows().map((r) => r.getAttribute('data-state'))).toEqual([
      'pending',
      'skipped',
      'expired',
    ]);
    // The agent by its record's title, its stamp a hover away.
    expect(rows()[0].textContent).toContain('Release scout');
    expect(within(rows()[0]).getByTestId('agent-wake-words').textContent).toMatch(
      /^waiting since \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
    // Due now: no deferral and no cooldown to name.
    expect(within(rows()[0]).queryByTestId('agent-wake-waits')).toBeNull();
    expect(within(rows()[1]).getByTestId('agent-wake-words').textContent).toBe(
      'skipped — the change came from its own chain of runs, so it would wake itself',
    );
    expect(within(rows()[2]).getByTestId('agent-wake-words').textContent).toBe(
      'expired — waited more than 7 days',
    );
  });

  it('names an assigned page and cause, with cooldown words only for an unrecorded link', async () => {
    useUiStore.setState({ triggerRuns: { [VAULT]: { [SCOUT_ID]: ago(5 * MINUTE) } } });
    __seedWakes([
      pending({
        cause: { kind: 'assigned', subject: PAGE, detail: 'via agent' },
        author: 'person',
        authorActor: 'human:me',
      }),
      pending({
        cause: { kind: 'assigned', subject: PAGE, detail: 'via agent' },
        author: 'not_recorded',
      }),
    ]);
    render(<WakesSection vaultPath={VAULT} />);
    await screen.findAllByTestId('agent-wake');
    expect(screen.getByTestId('agent-wakes').textContent).toContain(
      'Each assignment wakes its own run.',
    );
    expect(within(rows()[0]).getByTestId('agent-wake-subject').textContent).toBe(
      'First-run walkthrough GA',
    );
    expect(within(rows()[0]).getByTestId('agent-wake-cause').textContent).toBe(
      'work was assigned to it (via agent)',
    );
    expect(within(rows()[0]).queryByTestId('agent-wake-waits')).toBeNull();
    expect(within(rows()[1]).getByTestId('agent-wake-waits').textContent).toMatch(
      /^cooling down until /,
    );
  });

  it('names a budget deferral and when it tries again', async () => {
    __seedWakes([pending({ notBefore: ahead(10 * MINUTE), deferred: 'daily_runs,ambient_busy' })]);
    render(<WakesSection vaultPath={VAULT} />);
    const waits = await screen.findByTestId('agent-wake-waits');
    expect(waits.textContent).toMatch(
      /^deferred: daily_runs, ambient_busy · tries again \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });

  it('names the event cooldown from the agent’s own clock', async () => {
    useUiStore.setState({ triggerRuns: { [VAULT]: { [SCOUT_ID]: ago(5 * MINUTE) } } });
    __seedWakes([pending()]);
    render(<WakesSection vaultPath={VAULT} />);
    const waits = await screen.findByTestId('agent-wake-waits');
    expect(waits.textContent).toMatch(/^cooling down until \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('a cooldown that has passed is not named', async () => {
    useUiStore.setState({ triggerRuns: { [VAULT]: { [SCOUT_ID]: ago(20 * MINUTE) } } });
    __seedWakes([pending()]);
    render(<WakesSection vaultPath={VAULT} />);
    await screen.findByTestId('agent-wake');
    expect(screen.queryByTestId('agent-wake-waits')).toBeNull();
  });

  it('the subject opens its page, and a gone page is plain text', async () => {
    __seedWakes([
      pending(),
      pending({
        admittedAt: ago(MINUTE),
        cause: { kind: 'event', subject: 'records/risks/gone.md' },
      }),
    ]);
    render(<WakesSection vaultPath={VAULT} />);
    await screen.findAllByTestId('agent-wake');
    const live = within(rows()[0]).getByTestId('agent-wake-subject');
    expect(live.tagName).toBe('BUTTON');
    expect(live.textContent).toBe('First-run walkthrough GA');
    fireEvent.click(live);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: PAGE });
    const gone = within(rows()[1]).getByTestId('agent-wake-subject');
    expect(gone.tagName).toBe('SPAN');
    expect(gone.getAttribute('data-gone')).toBe('true');
    expect(gone.textContent).toBe('records/risks/gone.md');
  });

  it('queues what waits apart from what ended, each section headed with its count (M91.14)', async () => {
    __seedWakes([
      pending(),
      pending({ admittedAt: ago(MINUTE) }),
      pending({ outcome: 'skipped', reason: 'cycle', finishedAt: ago(2 * MINUTE) }),
      pending({
        admittedAt: ago(8 * 24 * 60 * MINUTE),
        finishedAt: ago(60 * MINUTE),
        outcome: 'cancelled',
        reason: 'expired',
      }),
    ]);
    const { container } = render(<WakesSection vaultPath={VAULT} />);
    await screen.findAllByTestId('agent-wake');
    const group = (name: string) => container.querySelector<HTMLElement>(`[data-group="${name}"]`)!;
    expect(within(group('waiting')).getByRole('heading', { level: 3 }).textContent).toBe(
      '2 waiting',
    );
    expect(within(group('ended')).getByRole('heading', { level: 3 }).textContent).toBe(
      '2 skipped or expired this week',
    );
    expect(
      within(group('waiting'))
        .getAllByTestId('agent-wake')
        .map((row) => row.getAttribute('data-state')),
    ).toEqual(['pending', 'pending']);
    expect(
      within(group('ended'))
        .getAllByTestId('agent-wake')
        .map((row) => row.getAttribute('data-state')),
    ).toEqual(['skipped', 'expired']);
  });

  it('says each wake’s state in a word before its agent, never inside its own words', async () => {
    __seedWakes([
      pending(),
      pending({ outcome: 'skipped', reason: 'cycle', finishedAt: ago(2 * MINUTE) }),
      pending({ finishedAt: ago(60 * MINUTE), outcome: 'cancelled', reason: 'expired' }),
    ]);
    render(<WakesSection vaultPath={VAULT} />);
    await screen.findAllByTestId('agent-wake');
    expect(rows().map((row) => row.textContent?.match(/^(\w+): Release scout/)?.[1])).toEqual([
      'Waiting',
      'Skipped',
      'Expired',
    ]);
    for (const words of screen.getAllByTestId('agent-wake-words')) {
      expect(words.querySelector('.sr-only')).toBeNull();
    }
  });

  it('on an agent page lists only that agent’s wakes', async () => {
    __seedWakes([pending(), pending({ agent: 'process:knowledge', admittedAt: ago(MINUTE) })]);
    render(<WakesSection vaultPath={VAULT} actor="process:knowledge" />);
    await screen.findAllByTestId('agent-wake');
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain('Knowledge agent');
  });

  it('reads again when the wakes revision moves', async () => {
    const read = vi.spyOn(ipc, 'fleetWakes');
    render(<WakesSection vaultPath={VAULT} />);
    await screen.findByTestId('agent-wakes-empty');
    expect(read).toHaveBeenCalledTimes(1);
    __seedWakes([pending()]);
    act(() => useUiStore.getState().noteWakesChanged());
    expect(await screen.findByTestId('agent-wake')).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('agent-wakes-empty')).toBeNull();
  });
});
