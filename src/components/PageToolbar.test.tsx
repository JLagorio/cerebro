// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MouseEvent } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Crumb,
  CrumbSeparator,
  PANEL_HEAD_CHROME,
  PageToolbar,
  PanelButtons,
  SAVE_LABEL,
  SaveState,
} from './PageToolbar';

/** The one action bar documents, records and Inbox captures share. */

afterEach(cleanup);

describe('PageToolbar', () => {
  it('lays the crumbs and their status at the start, the actions pill at the end', () => {
    const { container } = render(
      <PageToolbar
        testId="bar"
        crumbs={<span>Where</span>}
        status={<span>Saved</span>}
        actions={<button>Act</button>}
      />,
    );
    const bar = screen.getByTestId('bar');
    expect(container.firstElementChild).toBe(bar);
    expect(bar.className).toBe('cb-document-toolbar');
    const [start, end] = [...bar.children];
    expect([start.className, end.className]).toEqual(['cb-document-start', 'cb-document-end']);
    expect(start.firstElementChild?.className).toBe('cb-document-breadcrumbs');
    expect(start.firstElementChild?.textContent).toBe('Where');
    expect(start.textContent).toBe('WhereSaved');
    expect([...end.children].map((c) => c.className)).toEqual(['cb-document-actions']);
    expect(end.textContent).toBe('Act');
  });

  it('leads the end with Close while a panel is open, and hands over the actions to measure', () => {
    const onClose = vi.fn();
    const actionsRef = vi.fn();
    render(
      <PageToolbar
        testId="bar"
        crumbs={<span>Where</span>}
        actions={<button>Act</button>}
        onClosePanel={onClose}
        actionsRef={actionsRef}
      />,
    );
    const end = screen.getByTestId('bar').children[1];
    const close = screen.getByRole('button', { name: 'Close panel' });
    expect(end.firstElementChild).toBe(close);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(actionsRef).toHaveBeenCalledWith(end.querySelector('.cb-document-actions'));
  });

  it("hands keyboard focus to the open panel's button as Close takes the panel away", () => {
    render(
      <PageToolbar
        crumbs={<span>Where</span>}
        actions={
          <>
            {/* A favorited page's star is pressed too, and comes first. */}
            <button type="button" aria-pressed="true">
              Remove from favorites
            </button>
            <PanelButtons shown="comments" onToggle={() => undefined} comments={0} />
          </>
        }
        onClosePanel={() => undefined}
      />,
    );
    const close = screen.getByRole('button', { name: 'Close panel' });
    close.focus();
    fireEvent.click(close);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Comments' }));
  });

  it('leaves focus alone when Close is pressed with nothing focused', () => {
    render(
      <PageToolbar
        crumbs={<span>Where</span>}
        actions={<PanelButtons shown="details" onToggle={() => undefined} comments={0} />}
        onClosePanel={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(document.activeElement).toBe(document.body);
  });

  it('draws no Close while no panel is open', () => {
    render(<PageToolbar crumbs={<span>Where</span>} actions={<button>Act</button>} />);
    expect(screen.queryByRole('button', { name: 'Close panel' })).toBeNull();
  });

  // The page fits its side panel to the actions plus this much, so it has to
  // be what the frame's CSS draws beside them: the end's inset each side, and
  // Close (a small IconButton, 24px) with the end's gap after it.
  it("counts in PANEL_HEAD_CHROME exactly what the frame's CSS draws around the actions", () => {
    const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');
    const rule = (css: string, selector: string) => {
      const at = css.indexOf(`${selector} {`);
      if (at < 0) throw new Error(`no rule ${selector}`);
      return css.slice(at, css.indexOf('}', at));
    };
    const px = (block: string, prop: string) => {
      const m = new RegExp(`\\n\\s*${prop}:\\s*([^;]+);`).exec(block);
      if (m === null) throw new Error(`no ${prop}`);
      return m[1]
        .trim()
        .split(/\s+/)
        .map((v) => parseFloat(v));
    };
    const frame = read('pageFrame.css');
    const end = px(
      rule(frame, '.cb-page-frame > .cb-document-toolbar > .cb-document-end'),
      'padding',
    );
    const open = px(
      rule(frame, '.cb-page-frame[data-panel] > .cb-document-toolbar > .cb-document-end'),
      'padding-left',
    );
    const [gap] = px(rule(read('pageToolbar.css'), '.cb-document-start,\n.cb-document-end'), 'gap');
    // padding: 0 <right> 0 <left>; open, the left inset is Close's own.
    const right = end[1];
    expect(open[0] + 24 + gap + right).toBe(PANEL_HEAD_CHROME);
  });
});

describe('Crumb', () => {
  it('is a button when it leads somewhere, handing the click to its caller', () => {
    const opened = vi.fn<(event: MouseEvent<HTMLButtonElement>) => HTMLElement>(
      (event) => event.currentTarget,
    );
    render(<Crumb label="Inbox" icon="inbox" title="Show captures" onClick={opened} />);
    const crumb = screen.getByRole('button', { name: 'Inbox' });
    expect(crumb.title).toBe('Show captures');
    fireEvent.click(crumb);
    // The opener a caller can hand focus back to is the crumb itself.
    expect(opened).toHaveReturnedWith(crumb);
  });

  it('is text when it only says where you are, strong for the page itself', () => {
    render(
      <>
        <Crumb label="Pages" icon="library" />
        <Crumb label="Kickoff" icon="file-text" strong />
      </>,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Pages').parentElement?.className).toContain('text-n-500');
    expect(screen.getByText('Kickoff').parentElement?.className).toContain('font-medium');
  });

  it("draws a page's own glyph in place of the lucide icon", () => {
    render(<Crumb label="Spec" icon="file-text" glyph={<span data-testid="glyph" />} />);
    expect(screen.getByTestId('glyph')).toBeTruthy();
    expect(document.querySelector('[data-icon="file-text"]')).toBeNull();
  });

  it('separates with a chevron', () => {
    const { container } = render(<CrumbSeparator />);
    expect(container.querySelector('[data-icon="chevron-right"]')).not.toBeNull();
  });
});

describe('SaveState', () => {
  it('says nothing while idle, and the state otherwise', () => {
    const { rerender } = render(<SaveState state="idle" />);
    expect(screen.queryByTestId('doc-save-state')).toBeNull();
    for (const state of ['dirty', 'saving', 'saved'] as const) {
      rerender(<SaveState state={state} />);
      const label = screen.getByTestId('doc-save-state');
      expect(label.textContent).toBe(SAVE_LABEL[state]);
      expect(label.title).toMatch(/^Saves automatically — .+ to save now$/);
    }
    rerender(<SaveState state="failed" />);
    const failed = screen.getByTestId('doc-save-state');
    expect(failed.textContent).toBe("Couldn't save");
    expect(failed.hasAttribute('title')).toBe(false);
    expect(failed.className).toContain('text-danger-600');
  });
});

describe('PanelButtons', () => {
  const pressed = () =>
    screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.getAttribute('aria-label'));

  it('offers History, Comments and Details, in that order, each naming its panel', () => {
    const onToggle = vi.fn();
    render(<PanelButtons shown={null} onToggle={onToggle} comments={0} />);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'History',
      'Comments',
      'Details',
    ]);
    expect(pressed()).toEqual([]);
    for (const [name, panel] of [
      ['History', 'history'],
      ['Comments', 'comments'],
      ['Details', 'details'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(onToggle).toHaveBeenLastCalledWith(panel);
    }
  });

  it('presses the button of the panel on screen, and only that one', () => {
    const { rerender } = render(
      <PanelButtons shown="comments" onToggle={() => undefined} comments={0} />,
    );
    expect(pressed()).toEqual(['Comments']);
    rerender(<PanelButtons shown="details" onToggle={() => undefined} comments={0} />);
    expect(pressed()).toEqual(['Details']);
    // Names stay put: pressed is said by aria-pressed, not by a new label.
    expect(screen.getByRole('button', { name: 'Details' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('counts open comments beside the icon, said rather than named', () => {
    const { rerender } = render(
      <PanelButtons shown={null} onToggle={() => undefined} comments={2} />,
    );
    const button = screen.getByRole('button', { name: 'Comments' });
    expect(screen.getByTestId('doc-panel-comment-count').textContent).toBe('2');
    const said = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(said?.textContent).toBe('2 open comments');
    rerender(<PanelButtons shown={null} onToggle={() => undefined} comments={0} />);
    expect(screen.queryByTestId('doc-panel-comment-count')).toBeNull();
    expect(screen.getByRole('button', { name: 'Comments' }).hasAttribute('aria-describedby')).toBe(
      false,
    );
  });

  it('offers no Comments on a page that takes none', () => {
    render(<PanelButtons shown={null} onToggle={() => undefined} comments={null} />);
    expect(screen.queryByRole('button', { name: 'Comments' })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});
