// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StepStatus } from '@/engine/ai/types';
import { STEP_STATUS_WORDS, type StepState } from './StepLine';
import {
  Subagent,
  SubagentHandoff,
  handoffTitle,
  subagentFacts,
  type SubagentView,
} from './Subagent';
import { Tool } from './Tool';

/**
 * Subagent (M91.9): a subagent of the run — what it was asked, what kind it
 * is, its tool uses and time, never its tokens — and a Cerebro hand-off,
 * which says it went and never that the work is done.
 */

afterEach(cleanup);

function run(over: Partial<SubagentView> = {}): SubagentView {
  return {
    type: 'cerebro-researcher',
    description: 'Research the release notes',
    status: 'done',
    ...over,
  };
}

const slot = (name: string) =>
  document.querySelector(`[data-slot="${name}"]`) as HTMLElement | null;

describe('Subagent', () => {
  it('says what it was asked, its kind, and its tool uses and time', () => {
    render(
      <Subagent run={run({ toolUses: 12, durationMs: 48_000, summary: 'Three releases.' })} />,
    );
    expect(
      screen.getByRole('button', {
        name: 'Done: Research the release notes by the cerebro-researcher 12 tool uses · 48s',
      }),
    ).toBeTruthy();
    expect(slot('subagent-type')?.textContent).toBe('by the cerebro-researcher');
    expect(document.body.textContent).not.toMatch(/token/i);
  });

  it('leaves out what was not recorded, never 0 (CV-05)', () => {
    render(<Subagent run={run({ summary: 'Three releases.' })} />);
    expect(slot('trace-description')).toBeNull();
    expect(subagentFacts({})).toBeUndefined();
    expect(subagentFacts({ toolUses: 0 })).toBe('0 tool uses');
    expect(subagentFacts({ toolUses: 1, durationMs: 1390 })).toBe('1 tool use · 1.4s');
  });

  it('runs open, with what it is doing now under the line, lit', () => {
    render(
      <Subagent run={run({ status: 'running', progress: 'Reading hello.txt', toolUses: 2 })}>
        <Tool status="running" title="Reading hello.txt" icon="file-text" />
      </Subagent>,
    );
    const trigger = screen.getByRole('button', {
      name: 'Running: Research the release notes by the cerebro-researcher 2 tool uses Reading hello.txt',
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(slot('step-progress')?.textContent).toBe('Reading hello.txt');
    expect(
      trigger.querySelector('[data-slot="trace-title"]')?.classList.contains('cb-ai-shimmer'),
    ).toBe(true);
    expect(slot('subagent-steps')?.textContent).toContain('Reading hello.txt');
  });

  it('closes when it ends, unless the reader chose; its steps stay in the document', () => {
    const steps = <Tool status="done" title="Read hello.txt" />;
    const { rerender } = render(<Subagent run={run({ status: 'running' })}>{steps}</Subagent>);
    rerender(<Subagent run={run({ summary: 'Hello.' })}>{steps}</Subagent>);
    const trigger = screen.getByRole('button', { name: /Research the release notes/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(slot('subagent-steps')?.closest('[hidden]')).not.toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText('Hello.')).toBeTruthy();
  });

  it('shows no progress once it stopped running', () => {
    render(<Subagent run={run({ status: 'interrupted', progress: 'Reading hello.txt' })} />);
    expect(slot('step-progress')).toBeNull();
    expect(screen.getByText(STEP_STATUS_WORDS.interrupted as string)).toBeTruthy();
  });

  it('says why there are no steps: none used, or none kept', () => {
    const { rerender } = render(<Subagent run={run({ toolUses: 0 })} defaultOpen />);
    expect(slot('subagent-no-steps')?.textContent).toBe('It used no tools');
    rerender(<Subagent run={run({ toolUses: 4 })} defaultOpen />);
    expect(slot('subagent-no-steps')?.textContent).toBe('Steps not recorded');
  });

  it('shows what went wrong, its first lines closed and the whole of it open', () => {
    render(
      <Subagent
        run={run({ status: 'failed', toolUses: 2 })}
        error={'API Error: 529 overloaded\nTry again later.'}
      />,
    );
    const trigger = screen.getByRole('button', { name: /^Failed: Research the release notes/ });
    const preview = slot('subagent-error') as HTMLElement;
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toBe('API Error: 529 overloaded\nTry again later.');
    fireEvent.click(trigger);
    expect(preview.hidden).toBe(true);
    expect(slot('subagent-error-detail')?.textContent).toContain('Try again later.');
    // What went wrong says why there are no steps; nothing else is claimed.
    expect(slot('subagent-no-steps')).toBeNull();
  });

  it('draws no badge for a kind nobody named', () => {
    render(<Subagent run={run({ type: '' })} />);
    expect(slot('subagent-type')).toBeNull();
    expect(slot('step-head')?.textContent).not.toContain('by the');
  });

  it('is a plain line while it has nothing to open', () => {
    render(<Subagent run={run({ status: 'running' })} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(slot('subagent')?.dataset.status).toBe('running');
  });

  it('names its model inside, and says a failure in danger ink', () => {
    render(<Subagent run={run({ status: 'failed', model: 'claude-sonnet-5' })} defaultOpen />);
    expect(slot('subagent-model')?.textContent).toBe('Model: claude-sonnet-5');
    const line = slot('trace-line') as HTMLElement;
    expect(line.dataset.status).toBe('error');
    expect(
      screen.getByRole('button', { name: /^Failed: Research the release notes/ }),
    ).toBeTruthy();
  });

  it.each<StepStatus>([
    'running',
    'done',
    'failed',
    'interrupted',
    'waiting',
    'not_run',
    'cancelled',
    'paused',
  ])('%s: has a status word in its name', (status) => {
    render(<Subagent run={run({ status, summary: 'x' })} />);
    const name =
      screen.getByRole('button', { name: /Research the release notes/ }).textContent ?? '';
    const words = status === 'done' ? 'Done' : (STEP_STATUS_WORDS[status] as string);
    expect(name.startsWith(`${words}: `)).toBe(true);
  });
});

describe('SubagentHandoff', () => {
  it('says it went, opens the agent’s own run, and never says the work is done', () => {
    const onOpenRun = vi.fn();
    render(<SubagentHandoff agent="release-scout" status="done" onOpenRun={onOpenRun} />);
    const button = screen.getByRole('button', { name: 'Handed to release-scout (opens its run)' });
    fireEvent.click(button);
    expect(onOpenRun).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toMatch(/\bdone\b|\bRan\b|\bfinished\b/i);
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('is a plain line with no run to open', () => {
    render(<SubagentHandoff agent="release-scout" status="done" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(slot('trace-line')?.textContent).toBe('Handed to release-scout');
  });

  it('gives its control the tab stop a caller asks for, and its line none (M92.4)', () => {
    render(
      <SubagentHandoff
        data-testid="handoff"
        agent="release-scout"
        status="done"
        onOpenRun={() => undefined}
        tabIndex={0}
      />,
    );
    expect(screen.getByRole('button').getAttribute('tabindex')).toBe('0');
    expect(screen.getByTestId('handoff').hasAttribute('tabindex')).toBe(false);
    cleanup();
    render(
      <SubagentHandoff agent="release-scout" status="failed" refusal="Paused." tabIndex={0} />,
    );
    expect(screen.getByRole('button').getAttribute('tabindex')).toBe('0');
    cleanup();
    // A line with nothing to press is no stop, asked or not.
    render(<SubagentHandoff agent="release-scout" status="done" tabIndex={0} />);
    expect(document.querySelector('[tabindex]')).toBeNull();
    cleanup();
    // Unasked, the button keeps its own.
    render(<SubagentHandoff agent="release-scout" status="done" onOpenRun={() => undefined} />);
    expect(screen.getByRole('button').hasAttribute('tabindex')).toBe(false);
  });

  it('shows why it could not go, its first lines closed and the whole of it open', () => {
    render(
      <SubagentHandoff
        agent="release-scout"
        status="failed"
        refusal={'release-scout is paused.\nNothing was handed.'}
      />,
    );
    const trigger = screen.getByRole('button', { name: "Couldn't hand to release-scout" });
    const preview = slot('subagent-handoff-refusal') as HTMLElement;
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toBe('release-scout is paused.\nNothing was handed.');
    fireEvent.click(trigger);
    expect(preview.hidden).toBe(true);
    expect(document.querySelector('[data-variant="destructive"]')?.textContent).toContain(
      'Nothing was handed.',
    );
  });

  it.each<[StepState, string]>([
    ['running', 'Handing to release-scout'],
    ['done', 'Handed to release-scout'],
    ['failed', "Couldn't hand to release-scout"],
    ['denied', 'Denied the hand-off to release-scout'],
    ['interrupted', `${STEP_STATUS_WORDS.interrupted}: Hand to release-scout`],
    ['waiting', `${STEP_STATUS_WORDS.waiting}: Hand to release-scout`],
    ['not_run', `${STEP_STATUS_WORDS.not_run}: Hand to release-scout`],
  ])('%s reads "%s"', (status, words) => {
    render(<SubagentHandoff agent="release-scout" status={status} />);
    const line = slot('step-head') as HTMLElement;
    const copy = line.cloneNode(true) as HTMLElement;
    for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    expect(copy.textContent).toBe(words);
    expect(handoffTitle('release-scout', status)).not.toMatch(/\bdone\b|\bRan\b/i);
  });
});
