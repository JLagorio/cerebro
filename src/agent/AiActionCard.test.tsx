// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiActionCard,
  historyOf,
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
