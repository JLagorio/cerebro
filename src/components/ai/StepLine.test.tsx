// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFERRED, INTERRUPTED } from '@/agent/AiActionCard';
import {
  STEP_STATUS_ICONS,
  STEP_STATUS_WORDS,
  StepExtra,
  StepHead,
  formatDuration,
  plural,
  stepTraceStatus,
  stepWords,
  useStepOpen,
  vaultPathOf,
  type StepState,
} from './StepLine';
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger } from './Trace';

/**
 * The line every trace step draws (M91.9). Its state is said in words as
 * well as ink (§3.3): before the title for a screen reader, and, for the five
 * states a stopped turn or a hook leaves, under the title for everyone.
 */

afterEach(cleanup);

const STATES: StepState[] = [
  'running',
  'done',
  'failed',
  'denied',
  'interrupted',
  'waiting',
  'cancelled',
  'not_run',
  'paused',
];

/** What a screen reader reads of an element: its text, less what is hidden. */
function spoken(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('the words', () => {
  it('says every state but done work, whose past tense says it', () => {
    for (const state of STATES) {
      if (state === 'done') expect(STEP_STATUS_WORDS[state]).toBeNull();
      else expect(STEP_STATUS_WORDS[state], state).toMatch(/\w/);
    }
  });

  it('keeps the transcript’s own sentences for unfinished work', () => {
    expect(STEP_STATUS_WORDS.interrupted).toBe(INTERRUPTED);
    for (const state of ['waiting', 'cancelled', 'not_run', 'paused'] as const) {
      expect(STEP_STATUS_WORDS[state]).toBe(DEFERRED[state]);
    }
  });

  it('gives every state an icon', () => {
    for (const state of STATES) expect(STEP_STATUS_ICONS[state]).toMatch(/^[a-z-]+$/);
  });

  it('draws each state as running, failed, not started or done', () => {
    expect(STATES.map((state) => [state, stepTraceStatus(state)])).toEqual([
      ['running', 'running'],
      ['done', undefined],
      ['failed', 'error'],
      ['denied', undefined],
      ['interrupted', undefined],
      ['waiting', 'pending'],
      ['cancelled', 'pending'],
      ['not_run', 'pending'],
      ['paused', 'pending'],
    ]);
  });

  it('leaves out words a string title already starts with', () => {
    expect(stepWords('running', undefined, 'Running git status')).toBeNull();
    expect(stepWords('failed', undefined, 'Failed to read notes.md')).toBeNull();
    expect(stepWords('denied', undefined, '  denied git push')).toBeNull();
    expect(stepWords('running', undefined, 'Reading 5 notes')).toBe('Running');
    expect(stepWords('running', undefined, 'Runningtotal')).toBe('Running');
    expect(stepWords('failed', undefined, <>Failed to read</>)).toBeNull();
    expect(
      stepWords('failed', undefined, ['Failed to read ', <code key="f">a.md</code>]),
    ).toBeNull();
    expect(stepWords('failed', undefined, [false, ' Failed to read'])).toBeNull();
    expect(stepWords('failed', undefined, <code>Failed to read</code>)).toBe('Failed');
    expect(stepWords('failed', undefined, ['Read ', <code key="f">a.md</code>])).toBe('Failed');
  });

  it('never drops the sentence of unfinished work, whatever the title says', () => {
    expect(stepWords('interrupted', undefined, 'Interrupted, may have completed')).toBe(
      INTERRUPTED,
    );
  });

  it('takes the caller’s words, or none when the caller says the title has them', () => {
    expect(stepWords('waiting', 'Waiting for your OK', 'Run git push')).toBe('Waiting for your OK');
    expect(stepWords('running', null, 'pnpm build')).toBeNull();
    expect(stepWords('failed', '', 'pnpm build')).toBeNull();
    expect(stepWords('done', 'Done', 'Research')).toBe('Done');
  });
});

describe('StepHead', () => {
  it.each(STATES)('%s: its state in words, before the title', (state) => {
    render(<StepHead status={state} title="git status" />);
    const line = document.querySelector('[data-slot="trace-line"]') as HTMLElement;
    const words = STEP_STATUS_WORDS[state];
    expect(spoken(line)).toBe(words === null ? 'git status' : `${words}: git status`);
  });

  it.each(['interrupted', 'waiting', 'cancelled', 'not_run', 'paused'] as const)(
    '%s: draws its sentence under the title, hidden there from a reader who heard it',
    (state) => {
      render(<StepHead status={state} title="Ran git status" />);
      const note = document.querySelector('[data-slot="step-note"]') as HTMLElement;
      expect(note.textContent).toBe(STEP_STATUS_WORDS[state]);
      expect(note.getAttribute('aria-hidden')).toBe('true');
      const head = document.querySelector('[data-slot="step-head"]') as HTMLElement;
      expect(spoken(head)).toBe(`${STEP_STATUS_WORDS[state]}: Ran git status`);
    },
  );

  it.each(['running', 'done', 'failed', 'denied'] as const)(
    '%s: draws no sentence under the title',
    (state) => {
      render(<StepHead status={state} title="git status" />);
      expect(document.querySelector('[data-slot="step-note"]')).toBeNull();
    },
  );

  it('reads its words inside a trigger, as the button’s name', () => {
    render(
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <StepHead status="paused" title="Ran git push" description="2s" />
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>output</TraceCollapsibleContent>
      </TraceCollapsible>,
    );
    expect(
      screen.getByRole('button', {
        name: `${STEP_STATUS_WORDS.paused}: Ran git push 2s`,
      }),
    ).toBeTruthy();
  });

  it('turns its own running icon, and never a tool’s icon', () => {
    const { rerender } = render(<StepHead status="running" title="Working" />);
    const icon = () => document.querySelector('[data-slot="trace-icon"]') as HTMLElement;
    expect(icon().className).toContain('animate-spin');
    expect(icon().getAttribute('aria-hidden')).toBe('true');
    rerender(<StepHead status="running" icon="terminal" title="Running pnpm test" />);
    expect(icon().className).not.toContain('animate-spin');
    expect(icon().querySelector('[data-icon="terminal"]')).not.toBeNull();
  });

  it('draws a progress line a reader hears, and a description only when given', () => {
    render(<StepHead status="running" title="Research" progress="Reading hello.txt" />);
    const progress = document.querySelector('[data-slot="step-progress"]') as HTMLElement;
    expect(progress.textContent).toBe('Reading hello.txt');
    expect(progress.getAttribute('aria-hidden')).toBeNull();
    expect(document.querySelector('[data-slot="trace-description"]')).toBeNull();
  });

  it('groups what follows the title, so it wraps under the title rather than cut it', () => {
    // A 380px panel cut a subagent's description to "Rea…" to keep its type
    // badge and facts on one line (M91 ui-a11y review).
    render(
      <StepHead
        status="done"
        title="Read the risks"
        after={<span data-testid="badge">cerebro-researcher</span>}
        description="2 tool uses · 2.4s"
      />,
    );
    const body = document.querySelector('[data-slot="step-body"]') as HTMLElement;
    const [title, facts] = [...body.children] as HTMLElement[];
    expect(title.dataset.slot).toBe('trace-title');
    expect(facts.dataset.slot).toBe('step-facts');
    expect([...facts.children].map((el) => el.textContent)).toEqual([
      'cerebro-researcher',
      '2 tool uses · 2.4s',
    ]);
    const css = readFileSync(resolve(__dirname, 'trace-steps.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css).toMatch(/\.cb-ai-step-body \{[^}]*flex-wrap: wrap;/);
    cleanup();
    render(<StepHead status="done" title="Read the risks" />);
    expect(document.querySelector('[data-slot="step-facts"]')).toBeNull();
  });

  it('lights a running title, and no other', () => {
    const { rerender } = render(<StepHead status="running" title="Running pnpm test" />);
    const title = () => document.querySelector('[data-slot="trace-title"]') as HTMLElement;
    expect(title().classList.contains('cb-ai-shimmer')).toBe(true);
    rerender(<StepHead status="interrupted" title="Run pnpm test" />);
    expect(title().classList.contains('cb-ai-shimmer')).toBe(false);
  });
});

describe('StepExtra', () => {
  it('hangs a caller’s lines under the line, and draws nothing for none', () => {
    const { rerender, container } = render(
      <StepExtra>
        <p>Kept the frontmatter.</p>
      </StepExtra>,
    );
    const extra = container.querySelector('[data-slot="step-extra"]') as HTMLElement;
    expect(extra.className).toBe('cb-ai-step-extra');
    expect(extra.textContent).toBe('Kept the frontmatter.');
    for (const none of [undefined, null, false, []]) {
      rerender(<StepExtra>{none}</StepExtra>);
      expect(container.firstChild).toBeNull();
    }
  });
});

describe('useStepOpen', () => {
  it('opens while it works and closes after, until the reader chooses', () => {
    const { result, rerender } = renderHook(({ auto }) => useStepOpen({}, auto), {
      initialProps: { auto: true },
    });
    expect(result.current.open).toBe(true);
    rerender({ auto: false });
    expect(result.current.open).toBe(false);
    act(() => result.current.onOpenChange(true));
    rerender({ auto: false });
    expect(result.current.open).toBe(true);
    rerender({ auto: true });
    act(() => result.current.onOpenChange(false));
    expect(result.current.open).toBe(false);
  });

  it('keeps a step closed with defaultOpen false, and open with true', () => {
    expect(renderHook(() => useStepOpen({ defaultOpen: false }, true)).result.current.open).toBe(
      false,
    );
    expect(renderHook(() => useStepOpen({ defaultOpen: true }, false)).result.current.open).toBe(
      true,
    );
  });

  it('draws what a controlling caller says, and tells it the reader’s choice', () => {
    const onOpenChange = vi.fn();
    const { result } = renderHook(() => useStepOpen({ open: false, onOpenChange }, true));
    expect(result.current.open).toBe(false);
    act(() => result.current.onOpenChange(true));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(result.current.open).toBe(false);
  });

  it('works through a TraceCollapsible', () => {
    function Row({ running }: { running: boolean }) {
      const opened = useStepOpen({}, running);
      return (
        <TraceCollapsible open={opened.open} onOpenChange={opened.onOpenChange}>
          <TraceCollapsibleTrigger>
            <StepHead status={running ? 'running' : 'done'} title="Research" />
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>Reading hello.txt</TraceCollapsibleContent>
        </TraceCollapsible>
      );
    }
    const { rerender } = render(<Row running />);
    expect(screen.getByText('Reading hello.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('Reading hello.txt')).toBeNull();
    rerender(<Row running={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Reading hello.txt')).toBeTruthy();
  });
});

describe('formatDuration and plural', () => {
  it.each([
    [0, '0ms'],
    [417, '417ms'],
    [1000, '1s'],
    [1390, '1.4s'],
    [9_960, '10s'],
    [12_400, '12s'],
    [59_400, '59s'],
    [60_000, '1m'],
    [125_000, '2m 5s'],
    [3_600_000, '1h'],
    [3_780_000, '1h 3m'],
  ])('%i ms reads %s', (ms, words) => {
    expect(formatDuration(ms)).toBe(words);
  });

  it.each([-1, -0.4, -60_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'clamps %s ms, a clock that stepped back, to no time at all',
    (ms) => {
      expect(formatDuration(ms)).toBe('0ms');
    },
  );

  it('counts one and many', () => {
    expect(plural(1, 'step', 'steps')).toBe('1 step');
    expect(plural(0, 'step', 'steps')).toBe('0 steps');
    expect(plural(3, 'step', 'steps')).toBe('3 steps');
  });
});

describe('vaultPathOf (CV-16)', () => {
  it.each([
    ['src/cart.test.ts', 'src/cart.test.ts'],
    ['./notes/a.md', 'notes/a.md'],
    ['/Users/me/vault/a.ts', null],
    ['~/vault/a.ts', null],
    ['C:\\vault\\a.ts', null],
    ['https://example.com/a.js', null],
    ['node:internal/process', null],
    ['<anonymous>', null],
    ['javascript:alert(1)', null],
    ['webpack-internal:///./src/a.ts', null],
    ['../outside/a.ts', null],
    ['notes/../../a.ts', null],
    ['notes/a\u0000.md', null],
    ['', null],
    [undefined, null],
  ])('%s → %s', (file, path) => {
    expect(vaultPathOf(file)).toBe(path);
  });

  it('lets the caller have the last word', () => {
    const isVaultPath = (path: string) => path.startsWith('notes/');
    expect(vaultPathOf('notes/a.md', isVaultPath)).toBe('notes/a.md');
    expect(vaultPathOf('src/a.ts', isVaultPath)).toBeNull();
  });
});
