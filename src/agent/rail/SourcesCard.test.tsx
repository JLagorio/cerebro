// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { railSources, type RailSources } from '@/agent/elements/railSources';
import { applyEvent } from '@/agent/transcript';
import type { ChatMessage, ToolCall } from '@/agent/types';
import type { TranscriptStatus } from '@/agent/useConversations';
import { resetLayers } from '@/components/ui/layers';
import type { CitedSource } from '@/engine/ai/sources';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { RAIL_SOURCES_WORDS, SourcesCard, type SourcesCardProps } from './SourcesCard';

/** How often the card drew its section, to hold that a stream never does. */
const drawn = vi.hoisted(() => ({ sections: 0 }));

vi.mock('@/components/ai/Rail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ai/Rail')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    RailSection: (props: Parameters<typeof actual.RailSection>[0]) => {
      drawn.sections += 1;
      return createElement(actual.RailSection, props);
    },
  };
});

/**
 * The rail's Sources card (M92.6, Q15): five lines, the latest reply's
 * first, then "View all", whose layer (layers.ts) Escape closes, handing
 * focus back. A line jumps to the Sources line of the reply that used it and
 * stays in the canvas; its way out is a link for a web page and, for a vault
 * page, an open in the app that floats the conversation first (CV-16). A
 * list that may be short says why (CV-05), and with nothing listed it is not
 * recorded or unavailable, never None.
 */

const IDLE: TranscriptStatus = { state: 'idle' };
const UNREADABLE: TranscriptStatus = {
  state: 'unavailable',
  reason: 'unreadable',
  retentionDays: null,
};

const web = (n: number, turn = `t${n}`): CitedSource => ({
  source: { kind: 'url', url: `https://site${n}.example/page`, title: `Page ${n}`, via: 'search' },
  turn,
});
const page = (path: string, turn: string, title?: string): CitedSource => ({
  source:
    title === undefined
      ? { kind: 'vault', path, via: 'read' }
      : { kind: 'vault', path, title, via: 'read' },
  turn,
});
const ready = (...cited: CitedSource[]): RailSources => ({ state: 'ready', cited, missing: null });
/** `count` web sources, the latest reply's first, as railSources orders them. */
const many = (count: number) => ready(...Array.from({ length: count }, (_, at) => web(count - at)));

/**
 * The transcript beside the rail, as the panel's aside holds it: a row per
 * reply, each with the Sources line its turn draws, a fold over its list,
 * except the replies `bare` names.
 */
function Transcript({ turns, bare = [] }: { turns: readonly string[]; bare?: readonly string[] }) {
  return (
    <div>
      {turns.map((turn) => (
        <div key={turn} data-message-id={turn}>
          <p>The answer of {turn}.</p>
          {!bare.includes(turn) && (
            <div data-testid="turn-sources">
              <button type="button" aria-expanded="false">
                Sources of {turn}
              </button>
              <div hidden>
                <a href="https://hidden.example/">A source</a>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** What the transcript beside the card draws: the replies it holds rows
 *  for (every one the card cites, unless it says), and those of them that
 *  draw no Sources line. */
interface Drawn {
  turns?: readonly string[];
  bare?: readonly string[];
}

/** The card in the panel's aside, after the transcript it jumps into. */
function Aside({ props, drawn: { turns, bare } = {} }: { props: SourcesCardProps; drawn?: Drawn }) {
  const cited = [...new Set(props.sources.cited.map((line) => line.turn))];
  return (
    <aside>
      <Transcript turns={turns ?? cited} bare={bare} />
      <SourcesCard {...props} />
    </aside>
  );
}

function renderCard(sources: RailSources, over: Partial<SourcesCardProps> = {}, drawn?: Drawn) {
  const revealed: HTMLElement[] = [];
  const opened: { path: string; presentation: string }[] = [];
  const jump = vi.fn((go: () => void) => go());
  const props: SourcesCardProps = {
    sources,
    folded: false,
    jump,
    onOpenPath: (path) =>
      opened.push({ path, presentation: useUiStore.getState().aiPanelPresentation }),
    reveal: (element) => revealed.push(element),
    ...over,
  };
  const view = render(<Aside props={props} drawn={drawn} />);
  return { ...view, props, jump, revealed, opened };
}

const card = () => screen.getByTestId('rail-sources');
const cardLines = () => within(card()).queryAllByTestId('rail-source');
const viewAll = () => screen.getByTestId('rail-sources-view-all');
const layer = () => screen.queryByTestId('rail-sources-all');
/** The reply `turn` in the transcript, and its Sources line's fold. */
const reply = (turn: string) => document.querySelector<HTMLElement>(`[data-message-id="${turn}"]`)!;
const sourcesLine = (turn: string) => within(reply(turn)).getByTestId('turn-sources');
const sourcesFold = (turn: string) => within(reply(turn)).getByRole('button');

function call(id: string, name: string, over: Partial<ToolCall> = {}): ToolCall {
  return { id, name, input: '{}', output: 'ok', done: true, failed: false, ...over };
}
const asked = (id: string): ChatMessage => ({ id, role: 'user', text: 'Look it up', tools: [] });
const replied = (id: string, tools: ToolCall[], over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  text: '',
  tools,
  ...over,
});
const read = (id: string, path: string): ToolCall =>
  call(id, 'mcp__cerebro__get_note', { input: JSON.stringify({ path }) });

beforeEach(() => {
  useUiStore.setState({ aiPanelPresentation: 'canvas' });
  useVaultStore.setState({ entries: [] });
});

afterEach(() => {
  cleanup();
  resetLayers();
  vi.restoreAllMocks();
});

describe('SourcesCard', () => {
  it('lists five lines, the latest reply’s first, then View all', () => {
    renderCard(many(7));
    expect(card().dataset.state).toBe('ready');
    expect(within(card()).getByRole('button', { name: 'Sources 7' })).toBeTruthy();
    expect(cardLines().map((line) => line.dataset.turn)).toEqual(['t7', 't6', 't5', 't4', 't3']);
    expect(viewAll().textContent).toBe('View all (7)');
    expect(viewAll().getAttribute('aria-haspopup')).toBe('dialog');
    expect(viewAll().getAttribute('aria-expanded')).toBe('false');
    expect(layer()).toBeNull();
  });

  it('lists five or fewer whole, with nothing to view all of', () => {
    renderCard(many(5));
    expect(cardLines()).toHaveLength(5);
    expect(screen.queryByTestId('rail-sources-view-all')).toBeNull();
  });

  it('draws a conversation that drew on nothing as one quiet line', () => {
    renderCard({ state: 'empty', cited: [], missing: null });
    expect(card().dataset.state).toBe('empty');
    expect(within(card()).getByRole('heading', { level: 3 }).textContent).toBe('SourcesNone');
    expect(cardLines()).toHaveLength(0);
  });

  it('is partial on a failed transcript read, saying so over what it could list', () => {
    const thread = [asked('u1'), replied('a1', [read('r1', 'notes/plan.md')])];
    renderCard(railSources(thread, UNREADABLE));
    expect(card().dataset.state).toBe('partial');
    const missing = within(card()).getByTestId('rail-sources-missing');
    expect(missing.textContent).toBe(RAIL_SOURCES_WORDS.missing.transcript);
    expect(cardLines().map((line) => line.dataset.turn)).toEqual(['a1']);
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('is unavailable with nothing listed and the transcript unread, never None', () => {
    renderCard(railSources([asked('u1'), replied('a1', [])], UNREADABLE));
    expect(card().dataset.state).toBe('unavailable');
    const unavailable = within(card()).getByTestId('section-unavailable');
    expect(unavailable.textContent).toBe(
      `${RAIL_SOURCES_WORDS.unavailable}${RAIL_SOURCES_WORDS.unavailableDetail}`,
    );
    // Its heading line folds a body, as every card that has something to say.
    expect(within(card()).getByRole('button', { name: 'Sources' }).tabIndex).toBe(0);
    expect(card().textContent).not.toContain('None');
    expect(cardLines()).toHaveLength(0);
  });

  it('says not recorded, with why, where a reply lost its web results and nothing is listed', () => {
    const lost = call('f1', 'WebFetch', { input: '{"url":"https://example.com/a"}' });
    renderCard(railSources([asked('u1'), replied('a1', [lost])], IDLE));
    expect(card().dataset.state).toBe('not-recorded');
    expect(card().textContent).toContain(RAIL_SOURCES_WORDS.notRecorded);
    expect(screen.getByTestId('rail-sources-missing').dataset.missing).toBe('results');
    expect(screen.getByTestId('rail-sources-missing').textContent).toBe(
      RAIL_SOURCES_WORDS.missing.results,
    );
    expect(card().textContent).not.toContain('None');
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('says not recorded, with why, where a subagent’s steps were not kept', () => {
    const agent = call('ag', 'Agent', {
      subagent: {
        type: 'cerebro-researcher',
        description: 'Research the cutover',
        status: 'done',
        toolUses: 3,
        parts: [],
        tools: [],
      },
    });
    renderCard(railSources([asked('u1'), replied('a1', [agent])], IDLE));
    expect(card().dataset.state).toBe('not-recorded');
    expect(card().textContent).toContain(RAIL_SOURCES_WORDS.notRecorded);
    expect(screen.getByTestId('rail-sources-missing').textContent).toBe(
      RAIL_SOURCES_WORDS.missing.steps,
    );
    expect(card().textContent).not.toContain('None');
  });

  it('is partial, not not recorded, where the lines it has may be short', () => {
    const lost = call('f1', 'WebFetch', { input: '{"url":"https://example.com/a"}' });
    renderCard(
      railSources([asked('u1'), replied('a1', [read('r1', 'notes/plan.md'), lost])], IDLE),
    );
    expect(card().dataset.state).toBe('partial');
    expect(card().textContent).not.toContain(RAIL_SOURCES_WORDS.notRecorded);
    expect(screen.getByTestId('rail-sources-missing').dataset.missing).toBe('results');
    expect(cardLines().map((line) => line.dataset.turn)).toEqual(['a1']);
  });

  it('lists nothing a streaming turn met, and what a subagent found', () => {
    const agent = call('ag', 'Agent', {
      subagent: {
        type: 'cerebro-researcher',
        description: 'Read the plan',
        status: 'done',
        parts: [{ kind: 'tool', toolId: 'sub-r' }],
        tools: [read('sub-r', 'projects/cutover.md')],
      },
    });
    const streaming = replied('a2', [read('r2', 'notes/draft.md')], {
      text: 'Reading https://half.example/',
      streaming: true,
    });
    renderCard(railSources([asked('u1'), replied('a1', [agent]), asked('u2'), streaming], IDLE));
    expect(cardLines().map((line) => [line.textContent, line.dataset.turn])).toEqual([
      [`${RAIL_SOURCES_WORDS.jump}projects/cutover.md`, 'a1'],
    ]);
  });

  it('jumps to the Sources line of the reply that used a source, staying in the canvas', () => {
    const { jump, revealed, opened } = renderCard(ready(web(2), page('notes/plan.md', 't1')));
    const jumpTo = screen.getByRole('button', {
      name: 'Jump to the reply that used Page 2 site2.example',
    });
    expect(jumpTo.tabIndex).toBe(0);
    fireEvent.click(jumpTo);
    expect(jump).toHaveBeenCalledTimes(1);
    // Brought into view by the host's scroller, once, and its fold focused.
    expect(revealed).toEqual([sourcesLine('t2')]);
    expect(document.activeElement).toBe(sourcesFold('t2'));
    expect(opened).toEqual([]);
    expect(useUiStore.getState().aiPanelPresentation).toBe('canvas');
  });

  it('with no host scroller, scrolls the Sources line into view itself', () => {
    const scrolled: [Element, unknown][] = [];
    // jsdom lays nothing out, so it has no scrollIntoView of its own.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement, options: unknown) {
        scrolled.push([this, options]);
      },
    });
    try {
      renderCard(ready(web(1)), { reveal: undefined });
      fireEvent.click(within(cardLines()[0]).getByTestId('rail-source-jump'));
      expect(scrolled).toEqual([[sourcesLine('t1'), { block: 'center', behavior: 'auto' }]]);
      expect(document.activeElement).toBe(sourcesFold('t1'));
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('reveals a reply that draws no Sources line itself, and nothing for one not drawn', () => {
    // The transcript holds no row for the reply "gone".
    const { revealed } = renderCard(
      ready(web(2), web(1, 'gone')),
      {},
      {
        turns: ['t2'],
        bare: ['t2'],
      },
    );
    const [drawnReply, missingReply] = cardLines();
    const jumpTo = within(drawnReply).getByTestId('rail-source-jump');
    jumpTo.focus();
    fireEvent.click(jumpTo);
    expect(revealed).toEqual([reply('t2')]);
    // Nothing in the reply to focus: focus stays where it was.
    expect(document.activeElement).toBe(jumpTo);
    fireEvent.click(within(missingReply).getByTestId('rail-source-jump'));
    expect(revealed).toEqual([reply('t2')]);
  });

  it('opens a vault page in the app after the conversation floats, never through an href', () => {
    const { jump, revealed, opened } = renderCard(
      ready(page('notes/plan.md', 't1', 'Launch plan')),
    );
    const line = cardLines()[0];
    expect(line.querySelector('a[href]')).toBeNull();
    fireEvent.click(
      within(line).getByRole('button', { name: 'Open Launch plan (leaves full screen)' }),
    );
    expect(opened).toEqual([{ path: 'notes/plan.md', presentation: 'floating' }]);
    expect(jump).not.toHaveBeenCalled();
    expect(revealed).toEqual([]);
  });

  it('offers a web page as a link the shell hands to the browser', () => {
    renderCard(ready(web(1)));
    const link = screen.getByRole('link', { name: 'Open Page 1 (opens in a new tab)' });
    expect(link.getAttribute('href')).toBe('https://site1.example/page');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(link.tabIndex).toBe(0);
  });

  it('links no address that is not http(s), and opens no path outside the vault', () => {
    renderCard(
      ready(
        { source: { kind: 'url', url: 'javascript:alert(1)', via: 'text' }, turn: 't2' },
        page('../outside.md', 't1'),
      ),
    );
    expect(cardLines()).toHaveLength(2);
    expect(card().querySelector('a')).toBeNull();
    expect(screen.queryByTestId('rail-source-open')).toBeNull();
  });

  it('names a vault page by the title the vault holds for it, else by its path', () => {
    useVaultStore.setState({
      entries: [makeEntry({ path: 'notes/plan.md', title: 'Launch plan' })],
    });
    renderCard(ready(page('notes/plan.md', 't2'), page('notes/gone.md', 't1')));
    expect(cardLines().map((line) => line.textContent)).toEqual([
      `${RAIL_SOURCES_WORDS.jump}Launch plan`,
      `${RAIL_SOURCES_WORDS.jump}notes/gone.md`,
    ]);
  });

  it('opens every source in a layer, which Escape closes, handing focus back', () => {
    renderCard(many(7));
    fireEvent.click(viewAll());
    expect(viewAll().getAttribute('aria-expanded')).toBe('true');
    const all = layer()!;
    const dialog = screen.getByRole('dialog', { name: 'Sources 7' });
    expect(dialog.contains(all)).toBe(true);
    expect(viewAll().getAttribute('aria-controls')).toBe(dialog.id);
    expect(
      within(all)
        .getAllByTestId('rail-source')
        .map((line) => line.dataset.turn),
    ).toEqual(['t7', 't6', 't5', 't4', 't3', 't2', 't1']);
    // It holds the keyboard while open.
    expect(all.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(layer()).toBeNull();
    expect(document.activeElement).toBe(viewAll());
    expect(viewAll().getAttribute('aria-expanded')).toBe('false');
    expect(viewAll().hasAttribute('aria-controls')).toBe(false);
  });

  it('jumps from the layer into the aside’s transcript, closing the layer', () => {
    const { revealed } = renderCard(many(7));
    fireEvent.click(viewAll());
    fireEvent.click(within(layer()!).getAllByTestId('rail-source-jump')[6]);
    expect(layer()).toBeNull();
    expect(revealed).toEqual([sourcesLine('t1')]);
    expect(document.activeElement).toBe(sourcesFold('t1'));
  });

  it('opens no layer while folded, and closes the one open as the rail folds', () => {
    const { rerender, props } = renderCard(many(7));
    fireEvent.click(viewAll());
    expect(layer()).not.toBeNull();
    rerender(<Aside props={{ ...props, folded: true }} />);
    expect(layer()).toBeNull();
    rerender(<Aside props={props} />);
    expect(layer()).toBeNull();
    expect(viewAll().getAttribute('aria-expanded')).toBe('false');
  });

  it('makes every control a tab stop of its own, as WebKit needs', () => {
    renderCard(ready(web(7), page('notes/plan.md', 't6'), web(5), web(4), web(3), web(2), web(1)));
    const controls = card().querySelectorAll<HTMLElement>('button, a[href]');
    // The fold, five jumps, their ways out, and View all.
    expect(controls).toHaveLength(12);
    for (const control of controls) expect(control.tabIndex).toBe(0);
  });

  it('is never drawn again by a turn’s stream', () => {
    const JUMP = (go: () => void) => go();
    const OPEN = () => undefined;
    function Host({ messages }: { messages: ChatMessage[] }) {
      const sources = useMemo(() => railSources(messages, IDLE), [messages]);
      return <SourcesCard sources={sources} folded={false} jump={JUMP} onOpenPath={OPEN} />;
    }
    let streaming = replied('a2', [], { streaming: true });
    let messages = [
      asked('u1'),
      replied('a1', [read('r1', 'notes/plan.md')]),
      asked('u2'),
      streaming,
    ];
    const { rerender } = render(<Host messages={messages} />);
    const before = drawn.sections;
    for (let word = 0; word < 50; word += 1) {
      streaming = applyEvent(streaming, { kind: 'TextDelta', text: `word${word} ` }, 'live');
      messages = [...messages.slice(0, -1), streaming];
      rerender(<Host messages={messages} />);
    }
    expect(drawn.sections).toBe(before);
    expect(cardLines()).toHaveLength(1);
  });
});
