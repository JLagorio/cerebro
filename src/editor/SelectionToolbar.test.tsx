// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ContextType, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '@blocknote/core/locales';
import { ComponentsContext, getFormattingToolbarItems } from '@blocknote/react';
import { PageCommentsContext } from './PageCommentsContext';
import {
  AiToolbarButtons,
  canDownloadFile,
  blockMenuItems,
  formattingToolbarItems,
  PRESETS,
  UNCARRIED_ACTIONS,
} from './SelectionToolbar';

/**
 * M18 — the AI controls you can see.
 *
 * The toolbar itself is BlockNote's, so whether it APPEARS is BlockNote's
 * question and is asked where BlockNote actually runs (e2e/agent.spec.ts).
 * What is worth pinning here is the contract the buttons carry: a preset is a
 * pre-written instruction, and the button's behaviour has to live in that
 * string rather than in a code path named after the label.
 */
describe('PRESETS', () => {
  it('carries a real instruction, not the label on the button', () => {
    // If a preset's behaviour lived anywhere but this string, nobody could
    // predict what a button does or change it without touching the editor.
    for (const preset of PRESETS) {
      expect(preset.instruction.length).toBeGreaterThan(20);
      expect(preset.instruction).not.toBe(preset.label);
    }
  });

  it('starts with the two everyone actually wants', () => {
    // The writing-actions menu retains its established order when the toolbar
    // collapses its entry to one Ask AI action.
    expect(PRESETS.slice(0, 2).map((p) => p.label)).toEqual(['Improve writing', 'Make it shorter']);
  });

  it('tells the model what to preserve, not only what to change', () => {
    // The failure mode of a one-word instruction is a rewrite that also
    // changes the voice, drops a caveat, or reformats the markdown — and each
    // of those lands as a hunk the user has to reject one at a time.
    const improve = PRESETS.find((p) => p.label === 'Improve writing');
    expect(improve?.instruction).toMatch(/keep|preserve/i);
    const grammar = PRESETS.find((p) => p.label === 'Fix spelling & grammar');
    expect(grammar?.instruction).toMatch(/nothing else/i);
  });

  it('has a unique label per preset, since the label is the React key', () => {
    expect(new Set(PRESETS.map((p) => p.label)).size).toBe(PRESETS.length);
  });
});

/*
 * M55.4, M55.15 — every control the editor offers keeps what it does through a
 * save. `markdown.test.ts` measures each action; this holds the menus to it.
 */
describe('formattingToolbarItems', () => {
  it("is BlockNote's toolbar without the actions a save drops", () => {
    const blockNote = getFormattingToolbarItems().map((item) => String(item.key));
    const keys = formattingToolbarItems().map((item) => String(item.key));
    for (const key of [
      'filePreviewButton',
      'underlineStyleButton',
      'colorStyleButton',
      'textAlignLeftButton',
      'textAlignCenterButton',
      'textAlignRightButton',
      'tableCellMergeButton',
    ]) {
      expect(blockNote).toContain(key);
      expect(keys).not.toContain(key);
    }
    expect(keys).toEqual(blockNote.filter((key) => !(key in UNCARRIED_ACTIONS)));
    expect(keys).toEqual(expect.arrayContaining(['boldStyleButton', 'createLinkButton']));
  });
});

describe('blockMenuItems', () => {
  it('offers Delete, and no colours or table header toggles', () => {
    const items = blockMenuItems(en);
    expect(items.map((item) => item.key)).toEqual([
      'turnIntoItem',
      'duplicateBlockItem',
      'moveBlockUpItem',
      'moveBlockDownItem',
      'removeBlockItem',
    ]);
    for (const key of ['blockColorsItem', 'tableRowHeaderItem', 'tableColumnHeaderItem']) {
      expect(UNCARRIED_ACTIONS[key], key).toBeTruthy();
    }
  });
});

/**
 * M70.2b — Comment sits on the same bar, after the AI group, and only where a
 * page provides PageCommentsContext. BlockNote's Mantine button is swapped for
 * a plain one: what is pinned here is the gate and the call, not Mantine.
 */
describe('the Comment button', () => {
  afterEach(cleanup);

  const components = {
    FormattingToolbar: {
      Button: ({
        children,
        label,
        onClick,
        ...rest
      }: {
        children?: ReactNode;
        label?: string;
        onClick?: () => void;
        'data-testid'?: string;
      }) => (
        <button
          type="button"
          aria-label={label}
          data-testid={rest['data-testid']}
          onClick={onClick}
        >
          {children}
        </button>
      ),
    },
  } as unknown as ContextType<typeof ComponentsContext>;

  const bar = (start?: () => void) => (
    <ComponentsContext.Provider value={components}>
      {start === undefined ? (
        <AiToolbarButtons onAsk={() => undefined} />
      ) : (
        <PageCommentsContext.Provider value={{ start }}>
          <AiToolbarButtons onAsk={() => undefined} />
        </PageCommentsContext.Provider>
      )}
    </ComponentsContext.Provider>
  );

  it('is absent without PageCommentsContext, as on the record peek', () => {
    render(bar());
    expect(screen.getByTestId('selection-ask-ai')).toBeTruthy();
    expect(screen.queryByTestId('selection-comment')).toBeNull();
  });

  it('shows inside the context, keeps the selection on mousedown, and calls start', () => {
    const start = vi.fn();
    render(bar(start));
    const button = screen.getByTestId('selection-comment');
    expect(button.getAttribute('aria-label')).toBe('Comment');
    // A default mousedown would move the selection off the text first.
    expect(fireEvent.mouseDown(button)).toBe(false);
    fireEvent.click(button);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('places Promote after Comment and preserves the selected checklist on mousedown', () => {
    const promote = vi.fn();
    render(
      <ComponentsContext.Provider value={components}>
        <PageCommentsContext.Provider value={{ start: vi.fn() }}>
          <AiToolbarButtons onAsk={() => undefined} onPromote={promote} />
        </PageCommentsContext.Provider>
      </ComponentsContext.Provider>,
    );
    const button = screen.getByTestId('selection-promote');
    expect(fireEvent.mouseDown(button)).toBe(false);
    fireEvent.click(button);
    expect(promote).toHaveBeenCalledTimes(1);
    const buttons = screen.getAllByRole('button');
    expect(buttons.indexOf(button)).toBeGreaterThan(
      buttons.indexOf(screen.getByTestId('selection-comment')),
    );
  });
});

it('offers Download only for web URLs, never a local attachment or media scheme', () => {
  for (const url of [
    '/attachments/a.pdf',
    '../a.png',
    'attachments/b.zip',
    'cerebro-file://root/0/a.png',
    '',
    undefined,
  ])
    expect(canDownloadFile(url)).toBe(false);
  expect(canDownloadFile('https://example.com/file.pdf')).toBe(true);
});
