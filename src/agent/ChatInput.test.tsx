import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';

const ipc = vi.hoisted(() => ({
  canPickFiles: vi.fn(() => false),
  pickFiles: vi.fn(async () => [] as string[]),
}));

vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  ...ipc,
}));

import { ChatInput } from './ChatInput';
import type { FileSource } from './attachments';
import { PromptInput } from '@/components/ai/PromptInput';
import { useEscapeLayer } from '@/components/ui/Popover';
import { chipId, fileChip, type ContextChip } from './contextChips';
import { composerFiles, type PendingView } from './elements/attachments';
import { NO_DROP_ZONE } from '@/engine/osDrop';
import { makeEntry } from '@/engine/testHelpers';
import { mockDrop } from '@/lib/mockDropped';
import { retainOsDropRouter } from '@/lib/osDrop';
import { useOpenLogStore } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
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

/** The composer's text sits in a Prompt Input, whose send it is (M91.12a). */
function Harness({
  onSubmit = () => undefined,
  onAttach,
  attached,
  files,
  onAttachFiles,
  onRemoveFile,
}: {
  onSubmit?: () => void;
  onAttach?: (chip: ContextChip) => void;
  attached?: string[];
  files?: ReturnType<typeof composerFiles>;
  onAttachFiles?: (sources: readonly FileSource[]) => void;
  onRemoveFile?: (id: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <PromptInput onSubmit={onSubmit}>
      <ChatInput
        value={value}
        onChange={setValue}
        onAttach={onAttach}
        attached={attached}
        files={files}
        onAttachFiles={onAttachFiles}
        onRemoveFile={onRemoveFile}
      />
    </PromptInput>
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

  // M52 — verified at 1100 with a concept's side panel open as a drawer: the
  // textarea took Escape in React's bubble phase, after the drawer's layer
  // had taken it on window capture, so the drawer closed and the menu stayed.
  // Beside a record, the same Escape closed the record.
  it('Escape closes the menu before any surface behind it', () => {
    const onBehind = vi.fn();
    function Behind() {
      useEscapeLayer(onBehind);
      return null;
    }
    render(
      <>
        <Behind />
        <Harness />
      </>,
    );
    fireEvent.change(box(), { target: { value: 'see [[risk' } });
    expect(screen.getByTestId('wikilink-menu')).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByTestId('wikilink-menu')).toBeNull();
    expect(onBehind).not.toHaveBeenCalled();
    // Closed, it is off the stack: the next Escape is the drawer's.
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(onBehind).toHaveBeenCalledTimes(1);
    expect(box().value).toBe('see [[risk');
  });

  it('an @ menu is not offered when there is nowhere for a chip to go', () => {
    // A menu whose choices do nothing is worse than no menu. Chip rows need an
    // `onAttach`; agent rows do not (M33b.6), and this vault holds none.
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '@risk' } });
    expect(screen.queryByTestId('attach-menu')).toBeNull();
  });

  it('an external context append ignores the focused textarea caret from its previous value', () => {
    const props = { onChange: vi.fn(), onAttach: vi.fn() };
    const { rerender } = render(
      <PromptInput onSubmit={vi.fn()}>
        <ChatInput {...props} value="Help me with" />
      </PromptInput>,
    );
    box().focus();
    box().setSelectionRange(0, 0);
    // Add context appends to the draft; focus may return before React commits
    // the new value. That old caret cannot identify a token in the new text.
    rerender(
      <PromptInput onSubmit={vi.fn()}>
        <ChatInput {...props} value="Help me with @" />
      </PromptInput>,
    );
    expect(screen.getByTestId('attach-menu')).toBeTruthy();
    expect(box().value).toBe('Help me with @');
  });

  it('native typing completes context at its actual caret without consuming later prose', () => {
    const onAttach = vi.fn();
    render(<Harness onAttach={onAttach} />);
    box().focus();
    fireEvent.change(box(), {
      target: { value: 'Please @risk tomorrow', selectionStart: 12, selectionEnd: 12 },
    });
    expect(screen.getByTestId('attach-menu')).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(box().value).toBe('Please  tomorrow');
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
    expect(box().value).toBe('[[risk-sweep]]');
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

// M59.3 — every menu here ranks through the one name ranker: the match tier
// first, then your own recent opens within it.
describe('ChatInput ranking (M59.3)', () => {
  const labels = (testid: string) =>
    [...screen.getByTestId(testid).querySelectorAll('button')].map(
      (b) => b.querySelector('span')?.textContent ?? '',
    );

  beforeEach(() => {
    useOpenLogStore.setState({ logs: {}, saved: true });
  });

  it('[[ ranks the note you opened first within its tier', () => {
    useVaultStore.setState({
      vaultPath: '/v',
      entries: [
        makeEntry({ path: 'notes/plan-a.md', title: 'Plan a' }),
        makeEntry({ path: 'notes/plan-b.md', title: 'Plan b' }),
        makeEntry({ path: 'notes/replan.md', title: 'Replan' }),
      ],
    });
    useOpenLogStore.getState().record('/v', 'notes/plan-b.md');
    useOpenLogStore.getState().record('/v', 'notes/replan.md');
    render(<Harness />);
    fireEvent.change(box(), { target: { value: 'see [[plan' } });
    expect(labels('wikilink-menu')).toEqual(['Plan b', 'Plan a', 'Replan']);
  });

  it('calls an untyped note a Page', () => {
    useVaultStore.setState({ entries: [makeEntry({ path: 'notes/plan.md', title: 'Plan' })] });
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '[[pl' } });
    expect(screen.getByTestId('wikilink-menu').textContent).toContain('Page');
    expect(screen.getByTestId('wikilink-menu').textContent).not.toContain('Note');
  });

  it('/ offers a word-boundary skill match after the prefix matches', () => {
    useVaultStore.setState({
      entries: [skillEntry('Risk sweep'), skillEntry('Sweep inbox'), skillEntry('Weekly review')],
    });
    render(<Harness />);
    fireEvent.change(box(), { target: { value: '/sweep' } });
    expect(labels('skill-menu')).toEqual(['/sweep-inbox', '/risk-sweep']);
  });
});

// Folded onto the assistant's button, the composer stays mounted with its
// draft. A completion menu there would sit on the layer stack, unseen, and
// swallow the page's next Escape: suspended, none opens.
describe('ChatInput while suspended', () => {
  it('opens no menu for the draft, and the same draft opens it once shown', () => {
    useVaultStore.setState({ entries: [skillEntry('Risk sweep')] });
    const props = { value: 'compare [[risk', onChange: () => undefined };
    const { rerender } = render(
      <PromptInput onSubmit={() => undefined}>
        <ChatInput {...props} suspended />
      </PromptInput>,
    );
    expect(screen.queryByTestId('wikilink-menu')).toBeNull();
    rerender(
      <PromptInput onSubmit={() => undefined}>
        <ChatInput {...props} />
      </PromptInput>,
    );
    expect(screen.getByTestId('wikilink-menu')).toBeTruthy();
  });
});

// M91.12a — the text is a Prompt Input's: its Enter sends and Shift+Enter
// breaks the line, an IME composition's keys are the composition's own, and
// no form stands between the field and anything portalled out of it.
describe('ChatInput in its Prompt Input (M91.12a)', () => {
  beforeEach(() => {
    useVaultStore.setState({
      entries: [skillEntry('Weekly review'), skillEntry('Risk sweep')],
      views: [],
      collections: [],
    });
  });

  it('is the Prompt Input’s field, by its name and its placeholder, and no form', () => {
    const onSubmit = vi.fn();
    const { container } = render(<Harness onSubmit={onSubmit} />);
    expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toBe(box());
    expect(box().dataset.slot).toBe('prompt-input-textarea');
    expect(box().placeholder).toBe('Ask about this vault…');
    expect(box().rows).toBe(1);
    expect(box().parentElement?.dataset.slot).toBe('prompt-input-body');
    expect(container.querySelector('form')).toBeNull();
    fireEvent.change(box(), { target: { value: 'First line' } });
    expect(fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('sends nothing on an Enter that ends an IME composition', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.change(box(), { target: { value: 'にほんご' } });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 });
    fireEvent.compositionStart(box());
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(box());
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('lets a composition keep its Enter and arrows while a menu is open', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.change(box(), { target: { value: '/' } });
    const rows = () => [...screen.getByTestId('skill-menu').querySelectorAll('button')];
    const first = rows()[0].querySelector('span')?.textContent;
    expect(rows()[0].className).toContain('bg-cortex-50');
    fireEvent.compositionStart(box());
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box(), { key: 'Tab', keyCode: 229 });
    // No row was picked or moved to, and nothing was sent.
    expect(box().value).toBe('/');
    expect(rows()[0].className).toContain('bg-cortex-50');
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(box());
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(box().value).toBe(`${first} `);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

/**
 * M91.17 — files from outside the vault: drawn as Attachments above the
 * text, and taken from `@`'s Attach a file row, a drop on the composer and a
 * paste. The panel copies them in on send; this hands them over.
 */
describe('ChatInput files (M91.17)', () => {
  const record = makeEntry({
    path: 'work/ship-beta.md',
    filename: 'ship-beta.md',
    folder: 'work',
    title: 'Ship the beta',
    type: 'Work item',
  });
  const waiting = (over: Partial<PendingView> = {}): PendingView => ({
    id: 'pending:7',
    label: 'Q3 report.pdf',
    fileKind: 'pdf',
    state: 'waiting',
    ...over,
  });

  beforeEach(() => {
    useVaultStore.setState({ entries: [record], views: [], collections: [] });
    useUiStore.setState({ toasts: [] });
    ipc.canPickFiles.mockReturnValue(false);
    ipc.pickFiles.mockReset();
    ipc.pickFiles.mockResolvedValue([]);
  });

  it('draws each file as an Attachment above the text: its name, its kind, a remove', () => {
    const onRemoveFile = vi.fn();
    render(
      <Harness
        files={composerFiles([fileChip('attachments/brief.docx')], [waiting()])}
        onRemoveFile={onRemoveFile}
      />,
    );
    const list = screen.getByRole('list', { name: 'Attached files' });
    // Across the pill, in the Prompt Input's header, never in the text's body.
    expect(list.parentElement?.dataset.slot).toBe('prompt-input-header');
    const [docx, pdf] = within(list).getAllByRole('listitem');
    expect(docx.dataset.testid).toBe('composer-attachment');
    expect(docx.dataset.path).toBe('attachments/brief.docx');
    expect(docx.dataset.state).toBe('done');
    expect(docx.querySelector('[data-slot="attachment-preview"]')?.getAttribute('data-kind')).toBe(
      'document',
    );
    expect(within(docx).getByText('brief.docx')).toBeTruthy();
    expect(pdf.dataset.state).toBe('idle');
    expect(pdf.dataset.path).toBeUndefined();
    expect(within(pdf).getByText('Q3 report.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Q3 report.pdf from context' }));
    expect(onRemoveFile).toHaveBeenCalledWith('pending:7');
    fireEvent.click(screen.getByRole('button', { name: 'Remove brief.docx from context' }));
    expect(onRemoveFile).toHaveBeenLastCalledWith('file:attachments/brief.docx');
  });

  it('draws an attached image in the vault through FileThumb, never an img of its own (CV-61)', () => {
    render(<Harness files={composerFiles([fileChip('attachments/diagram.png')], [])} />);
    const chip = screen.getByTestId('composer-attachment');
    expect(within(chip).getByTestId('file-thumb').dataset.path).toBe('attachments/diagram.png');
    expect(chip.querySelector('img')).toBeNull();
  });

  it('draws no files row with nothing attached, and holds a copying file’s remove', () => {
    const onRemoveFile = vi.fn();
    const { rerender } = render(<Harness onRemoveFile={onRemoveFile} />);
    expect(screen.queryByRole('list', { name: 'Attached files' })).toBeNull();
    rerender(
      <Harness
        files={composerFiles([], [waiting({ state: 'copying' })])}
        onRemoveFile={onRemoveFile}
      />,
    );
    expect(screen.getByTestId('composer-attachment').dataset.state).toBe('uploading');
    const remove = screen.getByRole('button', { name: 'Remove Q3 report.pdf from context' });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers Attach a file last in @, only where files can be taken', () => {
    const { rerender } = render(<Harness onAttach={vi.fn()} />);
    fireEvent.change(box(), { target: { value: '@' } });
    const labels = () =>
      [...screen.getByTestId('attach-menu').querySelectorAll('button')].map(
        (b) => b.querySelector('span')?.textContent,
      );
    expect(labels()).not.toContain('Attach a file…');
    rerender(<Harness onAttach={vi.fn()} onAttachFiles={vi.fn()} />);
    // The first row is still a chip row, and the file row comes last.
    expect(labels()[0]).not.toBe('Attach a file…');
    expect(labels().at(-1)).toBe('Attach a file…');
    expect(screen.getByTestId('attach-menu').textContent).toContain('Files');
  });

  it('closes @ on a word nothing answers to, so Enter still sends', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} onAttach={vi.fn()} onAttachFiles={vi.fn()} />);
    fireEvent.change(box(), { target: { value: 'ask @zzz' } });
    expect(screen.queryByTestId('attach-menu')).toBeNull();
    fireEvent.change(box(), { target: { value: 'ask @upl' } });
    expect(screen.getByTestId('attach-menu').textContent).toContain('Attach a file…');
  });

  it('opens the browser’s picker where there is no native one, and hands over what was chosen', () => {
    const onAttachFiles = vi.fn();
    render(<Harness onAttach={vi.fn()} onAttachFiles={onAttachFiles} />);
    const input = screen.getByTestId('composer-file-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.change(box(), { target: { value: 'read @attach' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(click).toHaveBeenCalledOnce();
    // The token is consumed, as a chip row's is.
    expect(box().value).toBe('read ');
    expect(ipc.pickFiles).not.toHaveBeenCalled();
    const file = new File(['%PDF'], 'brief.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onAttachFiles).toHaveBeenCalledWith([file]);
  });

  it('opens the native picker in the desktop app, and does nothing when it is cancelled', async () => {
    ipc.canPickFiles.mockReturnValue(true);
    ipc.pickFiles.mockResolvedValueOnce(['/outside/report.pdf']).mockResolvedValueOnce([]);
    const onAttachFiles = vi.fn();
    render(<Harness onAttach={vi.fn()} onAttachFiles={onAttachFiles} />);
    for (let i = 0; i < 2; i += 1) {
      fireEvent.change(box(), { target: { value: '@file' } });
      await act(async () => {
        fireEvent.keyDown(box(), { key: 'Enter' });
      });
    }
    expect(ipc.pickFiles).toHaveBeenCalledTimes(2);
    expect(onAttachFiles).toHaveBeenCalledOnce();
    expect(onAttachFiles).toHaveBeenCalledWith(['/outside/report.pdf']);
  });

  it('says why when the native picker could not open', async () => {
    ipc.canPickFiles.mockReturnValue(true);
    ipc.pickFiles.mockRejectedValueOnce(new Error('the dialog is busy'));
    render(<Harness onAttach={vi.fn()} onAttachFiles={vi.fn()} />);
    fireEvent.change(box(), { target: { value: '@file' } });
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' });
    });
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
      "Couldn't choose files — the dialog is busy",
    ]);
  });

  it('takes a drop anywhere on the composer through the OS drop router', async () => {
    const onAttachFiles = vi.fn();
    const { container } = render(<Harness onAttachFiles={onAttachFiles} />);
    const pill = container.querySelector('[data-slot="prompt-input"]') as HTMLElement;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => pill });
    act(() =>
      mockDrop({
        at: { x: 4, y: 4 },
        files: [{ path: '/outside/a.pdf', content: '%PDF' }],
        hold: true,
      }),
    );
    // Over it, the pill says it takes files.
    expect(container.querySelector('.cb-chat-drop')?.textContent).toBe('Drop to attach');
    await act(async () =>
      mockDrop({ at: { x: 4, y: 4 }, files: [{ path: '/outside/a.pdf', content: '%PDF' }] }),
    );
    expect(onAttachFiles).toHaveBeenCalledWith(['/outside/a.pdf']);
    expect(container.querySelector('.cb-chat-drop')).toBeNull();
  });

  it('is no drop zone where files cannot be taken', async () => {
    // The app keeps the router listening with no zone, so the drop explains.
    const release = retainOsDropRouter();
    const { container } = render(<Harness />);
    const pill = container.querySelector('[data-slot="prompt-input"]') as HTMLElement;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => pill });
    await act(async () =>
      mockDrop({ at: { x: 4, y: 4 }, files: [{ path: '/outside/a.pdf', content: '%PDF' }] }),
    );
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([NO_DROP_ZONE]);
    release();
  });

  it('takes a pasted file, and leaves a paste of text to the text', () => {
    const onAttachFiles = vi.fn();
    render(<Harness onAttachFiles={onAttachFiles} />);
    const shot = new File(['png'], 'shot.png', { type: 'image/png' });
    const pasted = fireEvent.paste(box(), {
      clipboardData: { files: [shot], types: ['Files'], getData: () => '' },
    });
    expect(pasted).toBe(false);
    expect(onAttachFiles).toHaveBeenCalledWith([shot]);
    const typed = fireEvent.paste(box(), {
      clipboardData: { files: [], types: ['text/plain'], getData: () => 'words' },
    });
    expect(typed).toBe(true);
    expect(onAttachFiles).toHaveBeenCalledOnce();
  });
});
