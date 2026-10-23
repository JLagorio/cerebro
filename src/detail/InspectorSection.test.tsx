// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneContext } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { InspectorSection } from './InspectorSection';

/** One folding section of the inspector's Details: the person's fold, kept
 *  by id, and a reveal that unfolds it and brings it into view once. */

beforeEach(() => {
  window.localStorage.removeItem('cerebro.inspectorCollapsed');
  window.localStorage.removeItem('cerebro.inspectorExpanded');
  useUiStore.setState({ inspectorCollapsed: [], inspectorExpanded: [], inspectorReveal: null });
});
afterEach(cleanup);

const section = () => screen.getByRole('region', { name: /^Links/ });

describe('InspectorSection', () => {
  it('names itself by its header, says its count, and keeps actions outside the fold', () => {
    const add = vi.fn();
    render(
      <InspectorSection
        id="links"
        label="Links"
        count={3}
        actions={
          <button type="button" onClick={add}>
            Add link
          </button>
        }
      >
        <p>Rows</p>
      </InspectorSection>,
    );
    expect(section().dataset.section).toBe('links');
    const toggle = within(section()).getByRole('button', { expanded: true });
    expect(toggle.textContent).toBe('Links3');
    expect(toggle.getAttribute('aria-controls')).toBe(screen.getByText('Rows').parentElement?.id);
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(add).toHaveBeenCalledTimes(1);
    // The action is beside the toggle, never inside it, and folds nothing.
    expect(toggle.contains(screen.getByRole('button', { name: 'Add link' }))).toBe(false);
    expect(useUiStore.getState().inspectorCollapsed).toEqual([]);
  });

  it('draws no count when it is given none', () => {
    render(
      <InspectorSection id="links" label="Links">
        <p>Rows</p>
      </InspectorSection>,
    );
    expect(section().querySelector('.cb-inspector-section-count')).toBeNull();
  });

  it('scrolls into view once per reveal, never again on a later mount', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { unmount } = render(
      <InspectorSection id="links" label="Links">
        <p>Rows</p>
      </InspectorSection>,
    );
    act(() => useUiStore.getState().revealInspectorSection('knowledge'));
    expect(scroll).not.toHaveBeenCalled();
    act(() => useUiStore.getState().revealInspectorSection('links'));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(section());
    unmount();
    // Details chosen again later: the ask was answered, so it stays put.
    render(
      <InspectorSection id="links" label="Links">
        <p>Rows</p>
      </InspectorSection>,
    );
    expect(scroll).toHaveBeenCalledTimes(1);
    // Asked again, it answers again.
    act(() => useUiStore.getState().revealInspectorSection('links'));
    expect(scroll).toHaveBeenCalledTimes(2);
    scroll.mockRestore();
  });

  // Two panes can each show a page's inspector: the strip that asked names
  // its own pane, so the section beside it scrolls and the other pane's stays.
  it('answers a reveal only in the pane that asked', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    render(
      <>
        <PaneContext.Provider value="p0">
          <InspectorSection id="knowledge" label="Knowledge left">
            <p>Left</p>
          </InspectorSection>
        </PaneContext.Provider>
        <PaneContext.Provider value="p1">
          <InspectorSection id="knowledge" label="Knowledge right">
            <p>Right</p>
          </InspectorSection>
        </PaneContext.Provider>
      </>,
    );
    act(() => useUiStore.getState().revealInspectorSection('knowledge', 'p1'));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(screen.getByRole('region', { name: 'Knowledge right' }));
    act(() => useUiStore.getState().revealInspectorSection('knowledge', 'p0'));
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(scroll.mock.contexts[1]).toBe(screen.getByRole('region', { name: 'Knowledge left' }));
    scroll.mockRestore();
  });

  it('starts folded when asked, and remembers the person opening it', () => {
    const { unmount } = render(
      <InspectorSection id="access" label="Access" defaultOpen={false} summary="2 can change it">
        <p>Rows</p>
      </InspectorSection>,
    );
    const toggle = () => screen.getByRole('button', { name: 'Access' });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect((screen.getByText('Rows').parentElement as HTMLElement).hidden).toBe(true);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(useUiStore.getState().inspectorExpanded).toEqual(['access']);
    expect(window.localStorage.getItem('cerebro.inspectorExpanded')).toBe('["access"]');
    unmount();
    // Another page: the opening is the person's, so it holds.
    render(
      <InspectorSection id="access" label="Access" defaultOpen={false}>
        <p>Rows</p>
      </InspectorSection>,
    );
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle());
    expect(useUiStore.getState().inspectorExpanded).toEqual([]);
    expect(useUiStore.getState().inspectorCollapsed).toEqual(['access']);
  });

  it('says its summary on the header, open or folded, without renaming its toggle', () => {
    render(
      <InspectorSection id="access" label="Access" summary="1 of 2 agents can change it">
        <p>Rows</p>
      </InspectorSection>,
    );
    const toggle = screen.getByRole('button', { name: 'Access' });
    const summary = screen.getByText('1 of 2 agents can change it');
    expect(summary.getAttribute('aria-hidden')).toBe('true');
    expect(toggle.getAttribute('aria-describedby')).toBe(summary.id);
    fireEvent.click(toggle);
    expect(screen.getByText('1 of 2 agents can change it')).toBeTruthy();
  });

  it('is a plain heading when it holds nothing to unfold', () => {
    render(<InspectorSection id="links" label="Links" summary="None" />);
    expect(screen.queryByRole('button')).toBeNull();
    const heading = screen.getByRole('heading', { name: /^Links/ });
    expect(heading.textContent).toBe('LinksNone');
    expect(section().hasAttribute('data-empty')).toBe(true);
  });

  it('unfolds a folded-by-default section on a reveal', () => {
    render(
      <InspectorSection id="access" label="Access" defaultOpen={false}>
        <p>Rows</p>
      </InspectorSection>,
    );
    act(() => useUiStore.getState().revealInspectorSection('access'));
    expect(screen.getByRole('button', { name: 'Access' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });
});
