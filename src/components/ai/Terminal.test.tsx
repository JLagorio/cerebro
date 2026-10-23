// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellResultData } from '@/engine/ai/types';
import { STEP_STATUS_WORDS } from './StepLine';
import { Terminal } from './Terminal';

/**
 * Terminal (M91.9): a command's line, opening onto the command as typed and
 * what it printed. Output arrives whole when the call returns, so a running
 * command has none yet, and says so.
 */

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

function shell(over: Partial<ShellResultData> = {}): ShellResultData {
  return {
    type: 'shell',
    stdout: '',
    stderr: '',
    interrupted: false,
    truncated: false,
    ...over,
  };
}

const slot = (name: string) =>
  document.querySelector(`[data-slot="${name}"]`) as HTMLElement | null;

describe('Terminal', () => {
  it('opens onto the command as typed, its output, and its error output ruled off', () => {
    render(
      <Terminal
        status="done"
        title="Ran pnpm lint"
        command="pnpm lint"
        result={shell({
          stdout: '\n> eslint .\n\nsrc/a.ts\n  1:1  error  no-unused-vars\n\n',
          stderr: ' ELIFECYCLE  Command failed with exit code 1.\n',
        })}
        defaultOpen
      />,
    );
    expect(slot('terminal-command')?.textContent).toBe('$ pnpm lint');
    expect(slot('terminal-command')?.querySelector('[aria-hidden="true"]')?.textContent).toBe('$ ');
    expect(slot('terminal-stdout')?.textContent).toBe(
      '> eslint .\n\nsrc/a.ts\n  1:1  error  no-unused-vars',
    );
    const stderr = slot('terminal-stderr') as HTMLElement;
    expect(stderr.className).toContain('cb-ai-terminal-stderr');
    expect(stderr.textContent).toBe('Error output:  ELIFECYCLE  Command failed with exit code 1.');
    expect(stderr.querySelector('.sr-only')?.textContent).toBe('Error output: ');
    expect(slot('terminal-output')?.dataset.variant).toBe('default');
  });

  it('reads escape codes and progress rewrites as the screen showed them', () => {
    render(
      <Terminal
        status="done"
        title="Ran pnpm test"
        result={shell({ stdout: '\u001b[32m✓\u001b[39m passed\r\nloading 10%\rloading 100%' })}
        defaultOpen
      />,
    );
    expect(slot('terminal-stdout')?.textContent).toBe('✓ passed\nloading 100%');
  });

  it('says the head of a cut output is gone', () => {
    render(
      <Terminal
        status="done"
        title="Ran pnpm test"
        command="pnpm test"
        result={shell({ stdout: 'm30.test.ts 10 passed', truncated: true })}
        defaultOpen
      />,
    );
    expect(slot('terminal-truncated')?.textContent).toBe('Showing the last part of the output');
  });

  it('marks a command the shell interrupted', () => {
    render(
      <Terminal
        status="failed"
        title="Failed to run pnpm dev"
        command="pnpm dev"
        result={shell({ stdout: 'ready on :5173', interrupted: true })}
        defaultOpen
      />,
    );
    expect(slot('terminal-interrupted')?.textContent).toBe('Interrupted before it finished');
  });

  it('has no output yet while it runs, and draws nothing that pretends to stream', () => {
    render(<Terminal status="running" title="Running pnpm test" command="pnpm test" />);
    const trigger = screen.getByRole('button', { name: 'Running pnpm test' });
    // Nothing printed yet: it does not open by itself.
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(slot('terminal-empty')?.textContent).toBe('No output yet');
    expect(document.querySelector('[data-slot="terminal-stdout"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy the output' })).toBeNull();
  });

  it('is a plain line while it runs with no command to show', () => {
    render(<Terminal status="running" title="Running pnpm test" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelector('[data-slot="trace-line"]')?.textContent).toBe(
      'Running pnpm test',
    );
  });

  it('opens by itself only while it runs with output to show', () => {
    const { rerender } = render(
      <Terminal
        status="running"
        title="Running pnpm build"
        command="pnpm build"
        result={shell({ stdout: 'compiling…' })}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Running pnpm build' }).getAttribute('aria-expanded'),
    ).toBe('true');
    rerender(
      <Terminal
        status="done"
        title="Ran pnpm build"
        command="pnpm build"
        result={shell({ stdout: 'compiled' })}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Ran pnpm build' }).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('tells no output from output nobody kept (CV-05)', () => {
    const { rerender } = render(
      <Terminal status="done" title="Ran true" command="true" result={shell()} defaultOpen />,
    );
    expect(slot('terminal-empty')?.textContent).toBe('No output');
    rerender(<Terminal status="done" title="Ran true" command="true" defaultOpen />);
    expect(slot('terminal-empty')?.textContent).toBe('Output not recorded');
    rerender(<Terminal status="failed" title="Failed to run true" command="true" defaultOpen />);
    expect(slot('terminal-empty')?.textContent).toBe('Output not recorded');
    expect(slot('terminal-output')?.dataset.variant).toBe('default');
    rerender(<Terminal status="not_run" title="Run git push" command="git push" defaultOpen />);
    expect(slot('terminal-empty')).toBeNull();
  });

  it('shows a failed call’s words, with no streams, on a danger ground', () => {
    render(
      <Terminal
        status="failed"
        title="Failed to run pnpm dev"
        command="pnpm dev"
        output="Command timed out after 2m 0s"
        defaultOpen
      />,
    );
    expect(slot('terminal-output')?.dataset.variant).toBe('destructive');
    expect(slot('terminal-stdout')?.textContent).toBe('Command timed out after 2m 0s');
  });

  it('copies what was printed', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(
      <Terminal
        status="done"
        title="Ran ls"
        command="ls"
        result={shell({ stdout: 'a.md\nb.md\n', stderr: 'warning: c.md\n' })}
        defaultOpen
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy the output' }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('a.md\nb.md\nwarning: c.md');
  });

  it('says a stopped turn’s words under its line', () => {
    render(<Terminal status="interrupted" title="Run pnpm test" command="pnpm test" />);
    expect(
      screen.getByRole('button', { name: `${STEP_STATUS_WORDS.interrupted}: Run pnpm test` }),
    ).toBeTruthy();
    expect(screen.getByText(STEP_STATUS_WORDS.interrupted as string)).toBeTruthy();
  });

  it('draws no link that leaves the web (CV-16)', () => {
    render(
      <Terminal
        status="done"
        title="Ran cat"
        command="cat notes/a.md"
        result={shell({ stdout: 'see https://example.com and notes/b.md' })}
        defaultOpen
      />,
    );
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});
