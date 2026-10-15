import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import type { Entry } from '@/engine/types';
import { answerText, completeSuggestion, type ViewSuggestion } from '@/engine/viewSuggestion';
import { serializeViewList } from '@/engine/views';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { ViewSuggestionCard } from './ViewSuggestionCard';
import { TranscriptRows } from './toolRenderers';
import type { ToolCall } from './types';

const { accept, clicked } = vi.hoisted(() => ({ accept: vi.fn(), clicked: vi.fn() }));
vi.mock('@/app/viewSuggestionActions', () => ({ acceptViewSuggestion: accept }));
vi.mock('@/views/ViewCanvas', () => ({
  ViewCanvas: ({ entries }: { entries: Entry[] }) => (
    <button onClick={clicked} onKeyDown={clicked}>
      {entries.map((e) => e.title).join(', ')}
    </button>
  ),
}));
const suggestion: ViewSuggestion = {
  database: 'Reading',
  view: {
    name: 'High ratings',
    filters: { all: [{ field: 'rating', op: 'gte', value: 4 }] },
    presentation: { type: 'table' },
  },
  reasoning: 'Keep the most useful books in view.',
};
const doc = () =>
  makeEntry({
    path: 'types/reading.md',
    title: 'Reading',
    type: 'Type',
    properties: { fields: { rating: 'number' } },
  });
const page = () => makeEntry({ path: 'notes/plan.md', title: 'Plan', type: 'Doc' });
const records = () => [
  makeEntry({ path: 'books/a.md', title: 'Alpha', type: 'Reading', properties: { rating: 5 } }),
  makeEntry({ path: 'books/b.md', title: 'Beta', type: 'Reading', properties: { rating: 2 } }),
];
const tool = (over: Partial<ToolCall> = {}): ToolCall => ({
  id: 'suggest-1',
  name: 'mcp__cerebro__suggest_view',
  input: '{}',
  output: answerText(suggestion),
  done: true,
  failed: false,
  ...over,
});
const card = () => screen.getByTestId('view-suggestion-card');

beforeEach(() => {
  accept.mockReset().mockResolvedValue('high-ratings');
  clicked.mockReset();
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entriesVault: '/demo-vault',
    status: 'ready',
    entries: [doc(), page(), ...records()],
  });
  useNavStore.setState({ selection: { kind: 'doc', path: 'notes/plan.md' } });
  useUiStore.setState({ detailPath: null });
});
afterEach(cleanup);

describe('ViewSuggestionCard', () => {
  it('previews live records without navigating on mount', () => {
    render(<ViewSuggestionCard tool={tool()} />);
    expect(card().textContent).toContain('Suggested view');
    expect(card().textContent).toContain('Table · Reading');
    expect(card().textContent).toContain('Live preview · 1 of 2 records');
    expect(card().textContent).toContain(suggestion.reasoning);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'notes/plan.md' });
    act(() =>
      useVaultStore.setState({
        entries: [doc(), page(), ...records().map((e) => ({ ...e, properties: { rating: 5 } }))],
      }),
    );
    expect(card().textContent).toContain('Live preview · 2 of 2 records');
  });
  it('preview clicks and keys reach no interaction or patch', () => {
    render(<ViewSuggestionCard tool={tool()} />);
    const preview = screen.getByTestId('view-suggestion-preview');
    expect(preview.querySelector('[inert]')).not.toBeNull();
    const button = preview.querySelector('button')!;
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.dragStart(button);
    expect(clicked).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    expect(useUiStore.getState().detailPath).toBeNull();
  });
  it('only one Add can be in flight, then the button becomes usable', async () => {
    let finish!: (value: string | null) => void;
    accept.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<ViewSuggestionCard tool={tool()} />);
    const add = screen.getByRole('button', { name: 'Add as a tab' });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(accept).toHaveBeenCalledOnce();
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(accept).toHaveBeenCalledWith({
      database: 'Reading',
      view: completeSuggestion(suggestion),
      placeOn: undefined,
    });
    await act(async () => finish(null));
    expect((add as HTMLButtonElement).disabled).toBe(false);
  });
  it('Place names the current eligible page', async () => {
    render(<ViewSuggestionCard tool={tool()} />);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Add and place on “Plan”' })),
    );
    expect(accept.mock.calls[0][0].placeOn).toBe('notes/plan.md');
  });
  it.each([
    ['types/reading.md', 'Type'],
    ['knowledge/plan.md', 'Concept'],
    ['library/a.md', 'Agent'],
    ['library/s.md', 'Skill'],
    ['notes/plan.mmd', null],
  ] as const)('offers no Place on %s', (path, type) => {
    useVaultStore.setState({ entries: [doc(), makeEntry({ path, type }), ...records()] });
    useNavStore.setState({ selection: { kind: 'doc', path } });
    render(<ViewSuggestionCard tool={tool()} />);
    expect(screen.queryByRole('button', { name: /Add and place/ })).toBeNull();
  });
  it('run-detail cards permit Add but never placement', () => {
    render(<TranscriptRows tools={[tool()]} streaming={false} onOpenPath={vi.fn()} readOnly />);
    expect(screen.getByRole('button', { name: 'Add as a tab' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Add and place/ })).toBeNull();
  });
  it('an equivalent saved view derives Added even when renamed', () => {
    const saved = {
      ...completeSuggestion(suggestion),
      id: 'keep',
      name: 'Favourites',
      icon: 'book',
    };
    useVaultStore.setState({
      entries: [
        makeEntry({
          ...doc(),
          properties: { ...doc().properties, views: serializeViewList([saved]) },
        }),
        ...records(),
      ],
    });
    render(<ViewSuggestionCard tool={tool()} />);
    expect(card().getAttribute('data-state')).toBe('added');
    expect(card().textContent).toContain('Added as “Favourites”');
    expect(screen.queryByRole('button', { name: 'Add as a tab' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Reading' }));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'type',
      name: 'Reading',
      view: 'keep',
    });
  });
  it('a removed field names the problem and disables Add', () => {
    useVaultStore.setState({
      entries: [makeEntry({ ...doc(), properties: { fields: { score: 'number' } } }), page()],
    });
    render(<ViewSuggestionCard tool={tool()} />);
    expect(card().getAttribute('data-state')).toBe('problems');
    expect(card().textContent).toContain('This view no longer fits Reading.');
    expect(
      (screen.getByRole('button', { name: 'Add as a tab' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it('a missing database says gone', () => {
    useVaultStore.setState({ entries: [page()] });
    render(<ViewSuggestionCard tool={tool()} />);
    expect(card().textContent).toContain('Reading is gone, so this view has nowhere to go.');
    expect(screen.queryByRole('button', { name: 'Add as a tab' })).toBeNull();
  });
  it('malformed old output is unavailable', () => {
    render(<ViewSuggestionCard tool={tool({ output: 'old answer' })} />);
    expect(card().textContent).toContain(
      "This suggestion can't be shown any more. Ask again if you still want it.",
    );
  });
  it('a failed vault read is unavailable, never an empty preview', () => {
    useVaultStore.setState({ status: 'error' });
    render(<ViewSuggestionCard tool={tool()} />);
    expect(card().getAttribute('data-state')).toBe('unavailable');
    expect(screen.queryByTestId('view-suggestion-preview')).toBeNull();
  });
  it.each(['failed', 'running', 'interrupted'] as const)(
    '%s suggestion remains an action step',
    (state) => {
      render(
        <TranscriptRows
          tools={[tool({ failed: state === 'failed', done: state === 'failed' })]}
          streaming={state === 'running'}
          onOpenPath={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('view-suggestion-card')).toBeNull();
      expect(screen.getByTestId('action-card').getAttribute('data-status')).toBe(state);
    },
  );
});
