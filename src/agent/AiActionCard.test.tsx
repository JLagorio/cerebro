// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiActionCard,
  DEFERRED,
  formatSize,
  historyOf,
  INTERRUPTED,
  isWrite,
  NO_REVERT,
  toolIcon,
  toolLabel,
  toolPath,
  type GitHistory,
} from '@/agent/AiActionCard';
import type { ToolCall } from '@/agent/types';
import { resolveIcon } from '@/components/ui/Icon';
import { agentFacingOps, POLICY } from '@/lib/policy/table';
import { TOOLS } from '@/lib/policy/tools';

describe('toolLabel', () => {
  it('strips the MCP namespace and humanizes', () => {
    expect(toolLabel('mcp__cerebro__write_concept')).toBe('write concept');
  });

  it('leaves native CLI tool names alone', () => {
    expect(toolLabel('Bash')).toBe('Bash');
    expect(toolLabel('WebFetch')).toBe('WebFetch');
  });

  it('names a connector tool by its server (M56.8)', () => {
    expect(toolLabel('mcp__gmail__search_threads')).toBe('gmail · search threads');
    expect(toolLabel('mcp__claude-ai-drive__read_file')).toBe('claude-ai-drive · read file');
    expect(toolLabel('mcp__cerebro__get_note')).toBe('get note');
  });
});

describe('toolIcon', () => {
  it('covers both vocabularies the CLI mixes in one transcript', () => {
    expect(toolIcon('Bash')).toBe('terminal');
    expect(toolIcon('mcp__cerebro__search_notes')).toBe('search');
  });

  it('falls back rather than rendering nothing', () => {
    expect(toolIcon('SomethingNew')).toBe('wrench');
  });

  it('draws every tool the manifest names with its own icon, never the wrench (M54.2)', () => {
    // Rows, the generated proposal tools and the CLI's built-ins: each icon
    // must be one lucide draws, or the card would show the dashed fallback.
    const named: [tool: string, icon: string][] = [
      ...TOOLS.tools.map((row): [string, string] => [`mcp__cerebro__${row.name}`, row.icon]),
      ...agentFacingOps(POLICY).map((op): [string, string] => [
        `mcp__cerebro__${TOOLS.generated.prefix}${op}`,
        TOOLS.generated.icon,
      ]),
      ...TOOLS.cli_tools.map((tool): [string, string] => [tool.name, tool.icon]),
    ];
    for (const [tool, icon] of named) {
      expect(resolveIcon(icon).Comp, `${tool}: ${icon}`).not.toBeNull();
      expect(toolIcon(tool), tool).toBe(icon);
    }
  });
});

describe('isWrite', () => {
  // A write shown as a read is the one classification error that matters —
  // it is the card whose path stays visible and that offers a diff.
  it('names the tools that change the vault', () => {
    for (const t of [
      'Write',
      'Edit',
      'mcp__cerebro__create_note',
      'mcp__cerebro__write_concept',
      'mcp__cerebro__edit_note',
    ]) {
      expect(isWrite(t)).toBe(true);
    }
    for (const t of ['Read', 'Grep', 'mcp__cerebro__search_notes', 'mcp__cerebro__open_note']) {
      expect(isWrite(t)).toBe(false);
    }
  });

  it('reads the manifest’s renderer: MultiEdit and NotebookEdit are writes, proposals are not', () => {
    expect(isWrite('MultiEdit')).toBe(true);
    expect(isWrite('NotebookEdit')).toBe(true);
    // A proposal and a commit write through the ledger, with no path to show
    // or diff, and the manifest gives a shell call no target: each stays a
    // step.
    for (const t of [
      'mcp__cerebro__propose_create_belief',
      'mcp__cerebro__commit_proposals',
      'Bash',
    ]) {
      expect(isWrite(t), t).toBe(false);
    }
  });
});

describe('toolPath', () => {
  it('finds the path a tool touched', () => {
    expect(toolPath('{"path":"knowledge/x.md"}')).toBe('knowledge/x.md');
    expect(toolPath('{"file_path":"/a/b.md"}')).toBe('/a/b.md');
    expect(toolPath('{"query":"at risk"}')).toBe('at risk');
  });

  it('is quiet on malformed or empty input', () => {
    expect(toolPath(null)).toBeNull();
    expect(toolPath('not json')).toBeNull();
    expect(toolPath('{"unrelated":1}')).toBeNull();
  });
});

describe('historyOf', () => {
  it('says nothing until git status is read, then git or none', () => {
    expect(historyOf(false, false)).toBeUndefined();
    expect(historyOf(false, true)).toBeUndefined();
    expect(historyOf(true, true)).toBe('git');
    expect(historyOf(true, false)).toBe('none');
  });
});

describe('a write card and the vault’s history (M55.5)', () => {
  afterEach(cleanup);

  const call = (name: string, over: Partial<ToolCall> = {}): ToolCall => ({
    id: 't-1',
    name,
    input: JSON.stringify({ path: 'notes/plan.md' }),
    output: 'Edited notes/plan.md: 1 edit; nothing outside the quoted text changed.',
    done: true,
    failed: false,
    ...over,
  });

  /** The card for `tool`, expanded, offered a diff as the panel offers one. */
  function expanded(tool: ToolCall, history: GitHistory | undefined) {
    render(
      <AiActionCard
        tool={tool}
        onOpenPath={() => undefined}
        onViewDiff={() => undefined}
        history={history}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /notes\/plan\.md/ }));
  }

  it('without git history, says it cannot revert and offers no diff', () => {
    expanded(call('mcp__cerebro__edit_note'), 'none');
    expect(screen.getByTestId('action-no-revert').textContent).toBe(NO_REVERT);
    expect(NO_REVERT).toBe(
      "Cerebro found no git history for this vault, so it can't revert this change.",
    );
    expect(screen.queryByTestId('action-view-diff')).toBeNull();
  });

  it('with git history, offers the diff and no such line', () => {
    expanded(call('mcp__cerebro__edit_note'), 'git');
    expect(screen.getByTestId('action-view-diff')).toBeTruthy();
    expect(screen.queryByTestId('action-no-revert')).toBeNull();
  });

  it('while the history is unknown, claims neither', () => {
    render(<AiActionCard tool={call('mcp__cerebro__edit_note')} onOpenPath={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /notes\/plan\.md/ }));
    expect(screen.queryByTestId('action-no-revert')).toBeNull();
    expect(screen.queryByTestId('action-view-diff')).toBeNull();
  });

  it('never says it on a read card, or on a write that failed', () => {
    expanded(call('mcp__cerebro__get_note'), 'none');
    expect(screen.queryByTestId('action-no-revert')).toBeNull();
    cleanup();
    expanded(
      call('mcp__cerebro__edit_note', { failed: true, output: 'Nothing was written.' }),
      'none',
    );
    expect(screen.queryByTestId('action-no-revert')).toBeNull();
  });

  it('draws edit_note as a write with its own icon', () => {
    expect(isWrite('mcp__cerebro__edit_note')).toBe(true);
    expect(toolIcon('mcp__cerebro__edit_note')).toBe('replace');
    expect(resolveIcon('replace').Comp).not.toBeNull();
  });
});

describe('a card’s status and its whole payload (M56.8)', () => {
  afterEach(cleanup);

  const call = (over: Partial<ToolCall> = {}): ToolCall => ({
    id: 't-1',
    name: 'mcp__cerebro__get_note',
    input: JSON.stringify({ path: 'notes/plan.md' }),
    output: 'the first part…',
    done: true,
    failed: false,
    ...over,
  });

  const card = () => screen.getByTestId('action-card');
  const open = () => fireEvent.click(screen.getByRole('button', { name: /notes\/plan\.md/ }));

  it('reads an unfinished call on a stopped turn as interrupted, and stops spinning', () => {
    render(
      <AiActionCard
        tool={call({ done: false, output: null })}
        status="interrupted"
        onOpenPath={() => undefined}
      />,
    );
    expect(card().getAttribute('data-status')).toBe('interrupted');
    expect(screen.getByTestId('action-interrupted').textContent).toBe(INTERRUPTED);
    expect(INTERRUPTED).toBe('Interrupted, may have completed');
    expect(card().querySelector('.animate-spin')).toBeNull();
  });

  it('spins only while the call runs', () => {
    render(
      <AiActionCard
        tool={call({ done: false, output: null })}
        status="running"
        onOpenPath={() => undefined}
      />,
    );
    expect(card().getAttribute('data-status')).toBe('running');
    expect(card().querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByTestId('action-interrupted')).toBeNull();
  });

  it('leaves a held call to its deferred words, never interrupted (M57.1)', () => {
    const held = call({ done: false, output: null, deferred: true });
    // Read off the call alone, a held call is not run, never interrupted.
    render(<AiActionCard tool={held} onOpenPath={() => undefined} />);
    expect(card().getAttribute('data-status')).toBe('not_run');
    expect(screen.getByTestId('action-deferred').textContent).toBe(DEFERRED.not_run);
    expect(screen.queryByTestId('action-interrupted')).toBeNull();
    cleanup();
    render(<AiActionCard tool={held} status="waiting" onOpenPath={() => undefined} />);
    expect(screen.getByTestId('action-deferred').textContent).toBe('Waiting for your answer');
    expect(card().querySelector('.animate-spin')).toBeNull();
  });

  it('reads its status off the call when no row gives one', () => {
    render(<AiActionCard tool={call({ failed: true })} onOpenPath={() => undefined} />);
    expect(card().getAttribute('data-status')).toBe('failed');
    expect(card().getAttribute('data-renderer')).toBe('step');
  });

  it('shows the whole payload in place of the preview', () => {
    const whole = 'the whole result, every line of it';
    render(
      <AiActionCard
        tool={call({
          payload: { output: whole, outputBytes: whole.length, outputTruncated: false },
        })}
        onOpenPath={() => undefined}
      />,
    );
    open();
    expect(screen.getByTestId('action-output').textContent).toBe(whole);
    expect(screen.queryByTestId('action-cut')).toBeNull();
  });

  it('says how much the 256 KB cap left out', () => {
    render(
      <AiActionCard
        tool={call({
          payload: {
            input: '{"path":"notes/plan.md","body":"cut',
            inputBytes: 3 * 1024 * 1024,
            inputTruncated: true,
          },
        })}
        onOpenPath={() => undefined}
      />,
    );
    open();
    expect(screen.getByTestId('action-input').textContent).toBe(
      '{"path":"notes/plan.md","body":"cut',
    );
    expect(screen.getByTestId('action-cut').textContent).toBe('Showing the first 256 KB of 3 MB.');
    // The output had no payload: its preview stands.
    expect(screen.getByTestId('action-output').textContent).toBe('the first part…');
  });

  it('words a size the way the cut note does', () => {
    expect(formatSize(900)).toBe('900 bytes');
    expect(formatSize(300 * 1024)).toBe('300 KB');
    expect(formatSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});

describe('foreign connector cards', () => {
  afterEach(cleanup);

  it('names the server separately and never offers a vault diff', () => {
    const tool: ToolCall = {
      id: 'foreign',
      name: 'mcp__claude_ai_Gmail__edit_note',
      input: '{"path":"notes/plan.md"}',
      output: 'Done',
      done: true,
      failed: false,
    };
    render(
      <AiActionCard
        tool={tool}
        onOpenPath={() => undefined}
        onViewDiff={() => undefined}
        history="git"
      />,
    );
    const card = screen.getByTestId('action-card');
    expect(card.getAttribute('data-external')).toBe('true');
    expect(card.getAttribute('data-server')).toBe('claude_ai_Gmail');
    expect(card.getAttribute('data-write')).toBe('false');
    expect(card.getAttribute('data-renderer')).toBe('step');
    expect(screen.getByTestId('action-server').textContent).toBe('claude_ai_Gmail');
    expect(screen.getByTestId('action-server').title).toBe(
      'Ran on the claude_ai_Gmail connector, outside this vault',
    );
    expect(toolIcon(tool.name)).toBe('plug');
    expect(resolveIcon('plug').Comp).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /edit note/ }));
    expect(screen.queryByTestId('action-view-diff')).toBeNull();
    expect(card.className).not.toContain('bg-cortex-50');
  });

  it.each(['mcp__cerebro__get_note', 'Bash'])('keeps %s local', (name) => {
    render(
      <AiActionCard
        tool={{ id: 'local', name, input: null, output: 'Done', done: true, failed: false }}
        onOpenPath={() => undefined}
      />,
    );
    expect(screen.queryByTestId('action-server')).toBeNull();
    expect(screen.getByTestId('action-card').hasAttribute('data-external')).toBe(false);
    expect(screen.getByTestId('action-card').hasAttribute('data-server')).toBe(false);
  });
});

describe('a checked create landing', () => {
  afterEach(cleanup);
  it('opens the returned suffix path and never treats a failed reply as a landing', () => {
    const opened: string[] = [];
    const tool: ToolCall = {
      id: 'create',
      name: 'create_canvas',
      input: '{"folder":"boards","slug":"plan"}',
      output: '{"path":"boards/plan-2.canvas"}',
      done: true,
      failed: false,
    };
    const view = render(<AiActionCard tool={tool} onOpenPath={(path) => opened.push(path)} />);
    fireEvent.click(screen.getByRole('button', { name: /boards\/plan-2.canvas/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(opened).toEqual(['boards/plan-2.canvas']);
    view.rerender(
      <AiActionCard tool={{ ...tool, failed: true }} onOpenPath={(path) => opened.push(path)} />,
    );
    expect(screen.queryByText('boards/plan-2.canvas', { selector: 'span' })).toBeNull();
  });
});
