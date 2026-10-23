// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOVER_OPEN_MS, HoverCard, resetHoverCards } from '@/components/ui/HoverCard';
import { resetLayers } from '@/components/ui/layers';
import { buildFileTree } from '@/engine/ai/fileTree';
import type { SourceRef, TodoItem } from '@/engine/ai/types';
import { Checkpoint } from './Checkpoint';
import { Confirmation, ConfirmationSubject } from './Confirmation';
import { FileTree } from './FileTree';
import { InlineCitation } from './InlineCitation';
import { Plan } from './Plan';
import { Queue, QueueItem, QueueItemAction, QueueList, QueueSection, TodoQueue } from './Queue';
import { Sources } from './Sources';
import { Trace } from './Trace';

/**
 * The trace's results' rails (M91.9b, plan §3.3): no element links anywhere
 * but the web (CV-16), none adds a window or document keydown listener of its
 * own (CV-47) — the hover card a citation opens adds its own, and only its
 * own — every line with a status says it in words, every icon named exists,
 * and the stylesheet spends DS tokens and the hover token only.
 */

beforeEach(() => {
  vi.useFakeTimers();
  resetHoverCards();
  resetLayers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const TODOS: TodoItem[] = [
  { content: 'Read the notes', status: 'completed', activeForm: 'Reading the notes' },
  { content: 'Draft the summary', status: 'in_progress', activeForm: 'Drafting the summary' },
  { content: 'Send it', status: 'pending' },
  { content: 'Wait for review', status: 'in_review' },
];

/** Sources a careless reader could turn into links that leave the web. */
const SOURCES: SourceRef[] = [
  { kind: 'url', url: 'https://pnpm.io/cli/create', title: 'pnpm create', via: 'search' },
  { kind: 'url', url: 'javascript:alert(1)', title: 'Trap', via: 'text' },
  { kind: 'url', url: 'notes/plan.md', via: 'text' },
  { kind: 'vault', path: 'notes/plan.md', title: 'The plan', via: 'read' },
  { kind: 'vault', path: '../secrets.md', via: 'read' },
];

const TREE = buildFileTree([
  { path: 'notes/plan.md', kind: 'modified', additions: 3, deletions: 1 },
  { path: 'assets/logo.png', kind: 'added', additions: null, deletions: null },
  { path: 'notes/gone.md', kind: 'deleted', additions: 0, deletions: 4 },
  {
    path: 'notes/new.md',
    kind: 'renamed',
    previousPath: 'notes/old.md',
    additions: 1,
    deletions: 0,
  },
]);

/** Every element of the group, as a turn and its dock draw them. */
function Gallery() {
  return (
    <>
      <Trace>
        <Plan todos={TODOS} isStreaming defaultOpen />
        <Sources sources={SOURCES} onOpenPath={() => undefined} defaultOpen />
      </Trace>
      <p>
        The plan is in the vault.{' '}
        <InlineCitation sources={SOURCES} onOpenPath={() => undefined}>
          <button type="button">The plan</button>
        </InlineCitation>
      </p>
      <FileTree
        tree={TREE}
        onOpenPath={() => undefined}
        actions={(file) => <button type="button">View diff of {file.name}</button>}
      />
      <Checkpoint turn="your message “Plan the launch”" onBranch={() => undefined} />
      <TodoQueue todos={TODOS} isStreaming />
      <Queue render={<section aria-label="Up next" />}>
        <QueueSection label="Up next" collapsible={false} headingLevel={3}>
          <QueueList>
            <QueueItem
              title="Then publish it"
              actions={<QueueItemAction aria-label="Remove from Up next">x</QueueItemAction>}
            />
          </QueueList>
        </QueueSection>
      </Queue>
      <Confirmation
        state="pending"
        icon="shield-question-mark"
        title="Run this command?"
        approve={[{ label: 'Allow once', onClick: () => undefined }]}
        deny={{
          onDeny: () => undefined,
          reason: { label: 'Tell the agent why (optional)' },
        }}
      >
        <ConfirmationSubject>git push</ConfirmationSubject>
      </Confirmation>
    </>
  );
}

/** The keydown listeners added to window and document while `run` runs.
 *  The spies pass every call through. */
function keydownsDuring(run: () => void): number {
  const onWindow = vi.spyOn(window, 'addEventListener');
  const onDocument = vi.spyOn(document, 'addEventListener');
  try {
    run();
    return [...onWindow.mock.calls, ...onDocument.mock.calls].filter(([type]) => type === 'keydown')
      .length;
  } finally {
    onWindow.mockRestore();
    onDocument.mockRestore();
  }
}

let at = 0;
function hover(el: Element) {
  at += 7;
  act(() => {
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, screenX: at, screenY: at }));
  });
  act(() => {
    vi.advanceTimersByTime(HOVER_OPEN_MS);
  });
}

describe('keys (CV-47)', () => {
  it('adds no window or document keydown listener, drawn and used', () => {
    const added = keydownsDuring(() => {
      render(<Gallery />);
      fireEvent.click(screen.getByRole('button', { name: /^In progress: Plan/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Used 5 sources' }));
      fireEvent.click(screen.getByRole('button', { name: /^notes/ }));
      fireEvent.click(screen.getByRole('button', { name: /^Branch from here, after / }));
      fireEvent.click(screen.getByRole('button', { name: '3 to do' }));
      const reason = screen.getByRole('textbox', { name: 'Tell the agent why (optional)' });
      fireEvent.change(reason, { target: { value: 'Not now' } });
      fireEvent.keyDown(reason, { key: 'Enter' });
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    });
    expect(added).toBe(0);
  });

  it('opening a citation adds only what its HoverCard adds', () => {
    render(
      <HoverCard label="Bare" content={() => <p>Bare</p>}>
        {({ ref }) => (
          <button type="button" ref={ref}>
            Bare
          </button>
        )}
      </HoverCard>,
    );
    const bare = keydownsDuring(() => hover(screen.getByRole('button', { name: 'Bare' })));
    cleanup();
    resetHoverCards();
    resetLayers();
    render(<Gallery />);
    const opened = keydownsDuring(() => hover(screen.getByRole('button', { name: 'The plan' })));
    expect(screen.getByRole('group', { name: '5 sources' })).toBeTruthy();
    expect(bare).toBeGreaterThan(0);
    expect(opened).toBe(bare);
  });
});

describe('links (CV-16)', () => {
  it('draws no link to anywhere but the web, open or closed', () => {
    render(<Gallery />);
    hover(screen.getByRole('button', { name: 'The plan' }));
    const links = [...document.querySelectorAll('a')];
    // The one web source, in the list and in the card.
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute('href') ?? '', link.outerHTML).toMatch(/^https?:\/\//);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.textContent).toContain('(opens in a new tab)');
    }
    // The trap is named, in the list and in the card, as text.
    const traps = screen.getAllByText('Trap');
    expect(traps).toHaveLength(2);
    for (const trap of traps) expect(trap.closest('a')).toBeNull();
  });
});

describe('status words (§3.3)', () => {
  it('every line with a status says it in words', () => {
    render(<Gallery />);
    const lines = document.querySelectorAll<HTMLElement>('[data-slot="trace-line"][data-status]');
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      const copy = line.cloneNode(true) as HTMLElement;
      for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
      expect(copy.textContent, line.outerHTML).toMatch(/^(?:In progress|To do|Done|In review): /);
    }
  });

  it('every todo line says its status, with or without a status of its own', () => {
    render(<Gallery />);
    const todos = document.querySelectorAll<HTMLElement>('[data-todo]');
    expect(todos.length).toBe(TODOS.length * 2);
    for (const todo of todos) {
      expect(todo.querySelector('.sr-only')?.textContent, todo.outerHTML).toMatch(/\w: $/);
    }
  });
});

describe('icons', () => {
  it('names only icons that exist', () => {
    render(<Gallery />);
    hover(screen.getByRole('button', { name: 'The plan' }));
    expect(document.querySelectorAll('[data-unknown-icon]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-icon]').length).toBeGreaterThan(10);
  });
});

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const ELEMENTS = [
  'Plan.tsx',
  'Queue.tsx',
  'Sources.tsx',
  'InlineCitation.tsx',
  'FileTree.tsx',
  'Checkpoint.tsx',
  'Confirmation.tsx',
];

describe('ported files', () => {
  it.each([...ELEMENTS, 'trace-results.css'])('%s carries the MIT notice', (name) => {
    const head = read(name).split('\n')[0];
    expect(head).toMatch(/Ported from shadcn\/ui at 25af02b, MIT.*THIRD_PARTY_NOTICES\.md/);
  });

  it.each(ELEMENTS)('%s imports the group’s stylesheet', (name) => {
    expect(read(name)).toContain("import './trace-results.css';");
  });
});

describe('trace-results.css', () => {
  const css = strip(read('trace-results.css'));
  /** A duration written as a number rather than spent from a token. */
  const LITERAL_DURATION = /(?<![\w-])\d*\.?\d+m?s\b/;
  const DEFINED = [
    css,
    ...[
      'trace-steps.css',
      'trace.css',
      'foundation.css',
      'code-block.css',
      '../../styles/index.css',
    ].map((path) => strip(read(path))),
  ].join('\n');

  it('spends the hover token, never a duration of its own', () => {
    const motion = [...css.matchAll(/(?:transition|animation)[\w-]*:([^;]+);/g)].map((m) => m[1]);
    expect(motion.length).toBeGreaterThan(0);
    for (const value of motion) {
      expect(value).toMatch(/var\(--motion-hover\)/);
      expect(value).not.toMatch(LITERAL_DURATION);
      expect(value).not.toMatch(/\ball\b/);
    }
    expect(css).not.toMatch(/\banimation[\w-]*:/);
  });

  it('paints with DS tokens only', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
  });

  it.each(ELEMENTS)('%s draws only with classes a stylesheet defines', (file) => {
    const used = new Set(read(file).match(/\bcb-ai-[a-z][a-z-]*/g) ?? []);
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(DEFINED, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
  });
});
