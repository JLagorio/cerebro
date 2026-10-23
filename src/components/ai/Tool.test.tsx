// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STEP_STATUS_WORDS, type StepState } from './StepLine';
import { Trace } from './Trace';
import { Tool } from './Tool';

/**
 * Tool (M91.9): a call's line in its state's tense, opening onto its input
 * and result. The app's Shiki is stood in for, as CodeBlock.test.tsx does.
 */

const { highlight } = vi.hoisted(() => ({ highlight: vi.fn() }));
vi.mock('@/workspace/highlighter', () => ({ highlight }));

beforeEach(() => {
  highlight.mockImplementation((code: string): Promise<ReactNode> =>
    Promise.resolve(
      <pre>
        <code>
          {code.split('\n').map((line, index) => (
            <span key={index} className="line">
              <span data-token="">{line}</span>
            </span>
          ))}
        </code>
      </pre>,
    ),
  );
});

afterEach(() => {
  cleanup();
  highlight.mockReset();
});

/** Every link drawn goes to the web, never to a vault path (CV-16). */
function onlyWebLinks() {
  for (const link of document.querySelectorAll('a')) {
    expect(link.getAttribute('href') ?? '').toMatch(/^https?:\/\//);
  }
}

const INPUT = '{"path":"notes/a.md","limit":20}';

describe('its state in words', () => {
  it.each<[StepState, string, string]>([
    ['running', 'Running git status', 'Running git status'],
    ['running', 'git status', 'Running: git status'],
    ['done', 'Ran git status', 'Ran git status'],
    ['failed', 'Failed to run git status', 'Failed to run git status'],
    ['failed', 'git status', 'Failed: git status'],
    ['denied', 'Denied git push', 'Denied git push'],
    ['denied', 'git push', 'Denied: git push'],
    ['interrupted', 'Run git status', `${STEP_STATUS_WORDS.interrupted}: Run git status`],
    ['waiting', 'Run git push', `${STEP_STATUS_WORDS.waiting}: Run git push`],
    ['cancelled', 'Run git push', `${STEP_STATUS_WORDS.cancelled}: Run git push`],
    ['not_run', 'Run git push', `${STEP_STATUS_WORDS.not_run}: Run git push`],
    ['paused', 'Run git push', `${STEP_STATUS_WORDS.paused}: Run git push`],
  ])('%s, titled "%s", is named "%s"', (status, title, name) => {
    render(<Tool status={status} title={title} icon="terminal" input={INPUT} />);
    expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('every line with a status has a status word in its name', () => {
    const words = new RegExp(
      `^(?:${['Running', 'Failed', 'Denied', ...Object.values(STEP_STATUS_WORDS).filter(Boolean)]
        .map((word) => String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})`,
    );
    render(
      <Trace>
        {(['running', 'failed', 'waiting', 'not_run', 'paused', 'cancelled'] as const).map(
          (status) => (
            <Tool key={status} status={status} title="git status" input={INPUT} />
          ),
        )}
      </Trace>,
    );
    const lines = document.querySelectorAll('[data-slot="trace-line"][data-status]');
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      const button = line.closest('button') as HTMLButtonElement;
      expect(button.getAttribute('aria-expanded')).not.toBeNull();
      expect(button.textContent, line.outerHTML).toMatch(words);
    }
  });

  it('shows a stopped turn’s words under the line, not shadcn’s "Failed to run"', () => {
    render(<Tool status="interrupted" title="Run git status" input={INPUT} />);
    expect(screen.getByText(STEP_STATUS_WORDS.interrupted as string)).toBeTruthy();
    expect(document.body.textContent).not.toContain('Failed');
    const line = document.querySelector('[data-slot="trace-line"]') as HTMLElement;
    expect(line.hasAttribute('data-status')).toBe(false);
  });
});

describe('what it opens onto', () => {
  it('is a plain line with nothing to show', () => {
    render(
      <Tool status="running" title="Reading notes.md" data-testid="tool">
        <p>From the inbox.</p>
      </Tool>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    const root = screen.getByTestId('tool');
    expect(root.dataset.slot).toBe('tool');
    expect(root.dataset.status).toBe('running');
    expect(root.className).toBe('cb-ai-step');
    expect(screen.getByText('From the inbox.').parentElement?.dataset.slot).toBe('step-extra');
  });

  it('starts closed, and opens onto its input laid out and its result', () => {
    render(
      <Tool
        status="done"
        title="Read notes.md"
        input={INPUT}
        output="Release notes, 3 sections"
        data-testid="tool"
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Read notes.md' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    const input = document.querySelector('[data-slot="tool-input"]') as HTMLElement;
    expect(input.textContent).toContain('Input');
    expect(input.querySelector('pre')?.textContent).toBe(
      '{\n  "path": "notes/a.md",\n  "limit": 20\n}',
    );
    const output = document.querySelector('[data-slot="tool-output"]') as HTMLElement;
    expect(output.textContent).toContain('Result');
    expect(output.dataset.variant).toBe('default');
    expect(output.querySelector('pre')?.textContent).toBe('Release notes, 3 sections');
    expect(screen.getByTestId('tool').dataset.status).toBe('done');
  });

  it('draws a failed call’s error on a danger ground', () => {
    render(
      <Tool
        status="failed"
        title="Failed to read notes.md"
        input={INPUT}
        output="File does not exist."
        defaultOpen
      />,
    );
    const output = document.querySelector('[data-slot="tool-output"]') as HTMLElement;
    expect(output.dataset.variant).toBe('destructive');
    expect(output.textContent).toContain('Error');
    expect(screen.getByRole('button', { name: 'Copy the error' })).toBeTruthy();
  });

  it('notes a cut payload under its block', () => {
    render(
      <Tool
        status="done"
        title="Read big.md"
        input={INPUT}
        output="…"
        outputNote="Showing the first 256 KB of 1.2 MB."
        defaultOpen
      />,
    );
    const output = document.querySelector('[data-slot="tool-output"]') as HTMLElement;
    expect(output.querySelector('[data-slot="code-block-footer"]')?.textContent).toBe(
      'Showing the first 256 KB of 1.2 MB.',
    );
  });

  it('puts its actions under the detail, never inside the line', () => {
    const onOpen = vi.fn();
    render(
      <Tool
        status="done"
        title="Edited notes.md"
        input={INPUT}
        actions={
          <button type="button" onClick={onOpen}>
            Open
          </button>
        }
      >
        <p>Kept the frontmatter.</p>
      </Tool>,
    );
    const trigger = screen.getByRole('button', { name: 'Edited notes.md' });
    expect(trigger.querySelector('button')).toBeNull();
    // A renderer's own line shows while the row is closed, hung from the title.
    const extra = screen.getByText('Kept the frontmatter.').parentElement as HTMLElement;
    expect(extra.dataset.slot).toBe('step-extra');
    expect(extra.previousElementSibling).toBe(trigger);
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledOnce();
    onlyWebLinks();
  });

  it('opens with actions alone', () => {
    render(<Tool status="done" title="Edited notes.md" actions={<button>View diff</button>} />);
    expect(screen.getByRole('button', { name: 'Edited notes.md' })).toBeTruthy();
  });

  it('marks a foreign call with its connector, read as words', () => {
    render(<Tool status="done" title="Searched issues" server="linear" input={INPUT} />);
    const chip = document.querySelector('[data-slot="tool-server"]') as HTMLElement;
    expect(chip.getAttribute('title')).toBe('Ran on the linear connector, outside this vault');
    expect(screen.getByRole('button', { name: 'Searched issues on linear' })).toBeTruthy();
  });

  it('highlights JSON for a theme the caller names, and draws other text plain', async () => {
    render(
      <Tool
        status="done"
        title="Read notes.md"
        input={INPUT}
        output="plain words"
        theme="dark"
        defaultOpen
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(highlight).toHaveBeenCalledOnce();
    expect(highlight).toHaveBeenCalledWith(
      '{\n  "path": "notes/a.md",\n  "limit": 20\n}',
      'json',
      'dark',
    );
    const input = document.querySelector('[data-slot="tool-input"] pre') as HTMLElement;
    expect(input.dataset.language).toBe('json');
    const output = document.querySelector('[data-slot="tool-output"] pre') as HTMLElement;
    expect(output.dataset.language).toBeUndefined();
  });

  it('draws JSON plain with no theme, and a huge payload plain with one', () => {
    const huge = JSON.stringify({ text: 'x'.repeat(30_000) });
    render(<Tool status="done" title="Read big.md" input={huge} theme="light" defaultOpen />);
    expect(highlight).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="tool-input"] pre')?.textContent).toContain(
      '"text": "xxx',
    );
  });

  it('hears a controlling caller', () => {
    const onOpenChange = vi.fn();
    render(
      <Tool
        status="done"
        title="Read notes.md"
        input={INPUT}
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Read notes.md' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(document.querySelector('[data-slot="tool-input"]')).toBeNull();
  });
});
