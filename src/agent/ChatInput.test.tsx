import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ChatInput } from './ChatInput';
import { chipId, type ContextChip } from './contextChips';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

const skillEntry = (title: string) => {
  const stem = title.toLowerCase().replace(/\s+/g, '-');
  return makeEntry({
    path: `records/skills/${stem}.md`,
    filename: `${stem}.md`,
    folder: 'records/skills',
    title,
    type: 'Skill',
    properties: { description: `${title} description` },
    snippet: 'instructions',
  });
};

function Harness({
  onSubmit = () => undefined,
  onAttach,
  attached,
}: {
  onSubmit?: () => void;
  onAttach?: (chip: ContextChip) => void;
  attached?: string[];
}) {
  const [value, setValue] = useState('');
  return (
    <ChatInput
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      onAttach={onAttach}
      attached={attached}
    />
  );
}

const box = () => screen.getByLabelText('Message the assistant') as HTMLTextAreaElement;

describe('ChatInput slash completion (M13.1)', () => {
  beforeEach(() => {
    useVaultStore.setState({
      entries: [skillEntry('Weekly review'), skillEntry('Risk sweep')],
    });
  });

  it('opens on /, narrows, completes, and CLOSES — Enter then sends', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.change(box(), { target: { value: '/' } });
    expect(screen.getByTestId('skill-menu')).toBeTruthy();
    fireEvent.change(box(), { target: { value: '/we' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('/weekly-review ');
    // The review's second major: the menu used to stay open on a stale caret
    // and swallow Enter-to-send forever. Closed means the next Enter submits.
    expect(screen.queryByTestId('skill-menu')).toBeNull();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  // M15: Escape dismisses the MENU and leaves the draft byte-for-byte alone.
  // It used to append a space (slash) or `]]` (wikilink) — rewriting what you
  // typed, in the wikilink case at the end of the message rather than at the
  // caret.
  it('Escape closes the skill menu without touching the draft', () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '/we' } });
    expect(screen.getByTestId('skill-menu')).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box().value).toBe('/we');
    expect(screen.queryByTestId('skill-menu')).toBeNull();
    // Still dismissed as the token grows — a dismissal that reopened on the
    // next keystroke would not be one.
    fireEvent.change(box(), { target: { value: '/wee' } });
    expect(screen.queryByTestId('skill-menu')).toBeNull();
  });

  it('Escape closes the wikilink menu without completing the link', () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: 'compare [[risk' } });
    expect(screen.getByTestId('wikilink-menu')).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box().value).toBe('compare [[risk');
    expect(screen.queryByTestId('wikilink-menu')).toBeNull();
    // A LATER `[[` is a different anchor, so completion still works after a
    // dismissal.
    fireEvent.change(box(), { target: { value: 'compare [[risk and [[weekly' } });
    expect(screen.getByTestId('wikilink-menu')).toBeTruthy();
  });

  it('an @ menu is not offered when there is nowhere for a chip to go', () => {
    // A menu whose choices do nothing is worse than no menu. Chip rows need an
    // `onAttach`; agent rows do not (M33b.6), and this vault holds none.
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '@risk' } });
    expect(screen.queryByTestId('attach-menu')).toBeNull();
  });

  it('a highlight arrowed in the slash menu cannot leak into the wikilink menu', () => {
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '/' } });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Escape' });
    fireEvent.change(box(), { target: { value: '[[risk sweep' } });
    // The review's first major: with the stale index this threw on Enter when
    // the wikilink menu had fewer rows than the slash menu had.
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('[[Risk sweep]]');
  });
});

/**
 * `@` attaches (M17.6b) — the explicit control M17.6's chips were missing.
 *
 * Different in kind from the other two tokens, which is the whole reason it
 * exists: `[[` and `/` put something in the MESSAGE, `@` puts something in the
 * CONTEXT and leaves no text behind.
 */
describe('ChatInput @ attachment (M17.6b)', () => {
  const record = makeEntry({
    path: 'work/ship-beta.md',
    filename: 'ship-beta.md',
    folder: 'work',
    title: 'Ship the beta',
    type: 'Work item',
  });

  beforeEach(() => {
    useVaultStore.setState({ entries: [record], views: [], collections: [] });
  });

  it('attaches the record and takes the token back out of the draft', () => {
    const onAttach = vi.fn();
    render(<Harness onAttach={onAttach} />);
    fireEvent.change(box(), { target: { value: 'summarise @ship' } });
    expect(screen.getByTestId('attach-menu')).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'Enter' });

    expect(onAttach).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'record', path: 'work/ship-beta.md' }),
    );
    // What `@` produces is a chip. Leaving `@ship` in the prose would say the
    // same thing twice, and the second copy is the one the agent misreads.
    expect(box().value).toBe('summarise ');
    expect(screen.queryByTestId('attach-menu')).toBeNull();
  });

  it('ignores an @ inside a word, so an email address is not a context menu', () => {
    render(<Harness onAttach={vi.fn()} />);
    fireEvent.change(box(), { target: { value: 'mail josef@ship' } });
    expect(screen.queryByTestId('attach-menu')).toBeNull();
  });

  it('does not offer something already attached', () => {
    const chip: ContextChip = {
      kind: 'record',
      path: 'work/ship-beta.md',
      label: 'Ship the beta',
      type: 'Work item',
    };
    render(<Harness onAttach={vi.fn()} attached={[chipId(chip)]} />);
    fireEvent.change(box(), { target: { value: '@ship' } });
    expect(screen.queryByTestId('attach-menu')).toBeNull();
  });

  it('Escape closes it without touching the draft', () => {
    render(<Harness onAttach={vi.fn()} />);
    fireEvent.change(box(), { target: { value: '@ship' } });
    expect(screen.getByTestId('attach-menu')).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box().value).toBe('@ship');
    expect(screen.queryByTestId('attach-menu')).toBeNull();
  });

  it('offers surfaces as well as records — a List has no [[ ]] to name it with', () => {
    useVaultStore.setState({
      entries: [record],
      collections: [],
      views: [
        {
          id: 'roadmap',
          collection: null,
          project: null,
          path: 'roadmap.list.yml',
          definition: {
            name: 'Roadmap',
            icon: null,
            color: null,
            order: null,
            source: { type: null, project: null },
            views: [],
          },
        },
      ],
    });
    const onAttach = vi.fn();
    render(<Harness onAttach={onAttach} />);
    fireEvent.change(box(), { target: { value: '@road' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onAttach).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'place', label: 'Roadmap' }),
    );
  });
});

/**
 * `@` also ADDRESSES (M33b.6).
 *
 * The one row in this menu that completes instead of consuming, and the
 * exception earns itself: a recipient is not context. `send` reads it back out
 * of the message text, and leaving `@release-scout` in the prose is what makes
 * the transcript show who a turn went to.
 *
 * An affordance, never a suggestion: these rows exist only once a person has
 * pressed `@`. Nothing volunteers an agent at anyone.
 */
describe('ChatInput @ addressing (M33b.6)', () => {
  const scout = makeEntry({
    path: 'records/agents/scout.md',
    filename: 'scout.md',
    folder: 'records/agents',
    title: 'Release scout',
    type: 'Agent',
    properties: { slug: 'release-scout' } as never,
  });

  beforeEach(() => {
    useVaultStore.setState({ entries: [scout], views: [], collections: [] });
  });

  it('completes the handle into the message rather than taking it away', () => {
    const onAttach = vi.fn();
    render(<Harness onAttach={onAttach} />);
    fireEvent.change(box(), { target: { value: '@rel' } });
    expect(screen.getByTestId('attach-menu')).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'Enter' });

    expect(box().value).toBe('@release-scout ');
    // A recipient is not a chip: routing reads the text, and a chip would put
    // who the turn went to somewhere the transcript never shows.
    expect(onAttach).not.toHaveBeenCalled();
  });

  it('finds an agent by its title as well as its handle', () => {
    render(<Harness onAttach={vi.fn()} />);
    fireEvent.change(box(), { target: { value: 'ask @scout' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe('ask @release-scout ');
  });

  it('does not offer the same agent twice, as a page and as a recipient', () => {
    // Addressing already carries everything attaching the record would have —
    // its brief, its memory, its scope — so the record row would be a
    // duplicate that does less.
    render(<Harness onAttach={vi.fn()} />);
    fireEvent.change(box(), { target: { value: '@rel' } });
    const labels = screen
      .getByTestId('attach-menu')
      .querySelectorAll<HTMLElement>('button > span:first-of-type');
    expect([...labels].map((el) => el.textContent)).toEqual(['@release-scout']);
  });

  it('is offered even where a chip has nowhere to go', () => {
    // Unlike the chip rows, an address needs no attachment point — it is only
    // text in the draft.
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '@rel' } });
    expect(screen.getByTestId('attach-menu')).toBeTruthy();
  });

  it('closes on completion, so the next Enter sends', () => {
    // The trailing space is what closes it: the `@` fragment ends at the first
    // space, so a completed handle is prose. Without that, Enter would keep
    // re-picking the row instead of sending the message — the same trap the
    // slash menu had.
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} onAttach={vi.fn()} />);
    fireEvent.change(box(), { target: { value: '@rel' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(screen.queryByTestId('attach-menu')).toBeNull();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
