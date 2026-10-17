// @vitest-environment jsdom
import { createPortal } from 'react-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PaneContext } from '@/stores/navStore';
import {
  PageNavigationContent,
  PageNavigationProvider,
  usePageNavigationControls,
  usePageNavigationSlot,
  type PageNavigationKind,
  type PageNavigationState,
} from './PageNavigation';

afterEach(cleanup);

function Navigation({ kind, label }: { kind: PageNavigationKind; label: string }) {
  const target = usePageNavigationSlot(kind);
  const controls = usePageNavigationControls(kind);
  const content = (
    <PageNavigationContent>
      <button data-page-navigation-item>{label}</button>
    </PageNavigationContent>
  );
  return (
    <>
      <button onClick={() => controls?.show()}>Show {label}</button>
      {target ? (
        createPortal(content, target)
      ) : (
        <div data-testid={`fallback-${label}`}>{content}</div>
      )}
    </>
  );
}

it('only the active matching pane owns the slot; other mounted pages keep local navigation', () => {
  const target = document.createElement('div');
  document.body.append(target);
  const state: PageNavigationState = {
    kind: 'inbox',
    paneId: 'p1',
    target,
    controls: { show: vi.fn(), hide: vi.fn() },
  };
  const tree = (value: PageNavigationState) => (
    <PageNavigationProvider value={value}>
      <PaneContext.Provider value="p1">
        <Navigation kind="inbox" label="first" />
      </PaneContext.Provider>
      <PaneContext.Provider value="p2">
        <Navigation kind="inbox" label="second" />
      </PaneContext.Provider>
      <PaneContext.Provider value="p1">
        <Navigation kind="settings" label="settings" />
      </PaneContext.Provider>
    </PageNavigationProvider>
  );
  const view = render(tree(state));
  expect(target.textContent).toBe('first');
  expect(screen.getByTestId('fallback-second').textContent).toBe('second');
  expect(screen.getByTestId('fallback-settings').textContent).toBe('settings');
  fireEvent.click(screen.getByText('Show first'));
  expect(state.controls.show).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText('first'));
  expect(state.controls.hide).toHaveBeenCalledOnce();
  view.rerender(tree({ ...state, paneId: 'p2' }));
  expect(target.textContent).toBe('second');
  expect(screen.getByTestId('fallback-first').textContent).toBe('first');
  view.rerender(tree({ ...state, kind: null }));
  expect(target.textContent).toBe('');
  target.remove();
});

it('a page rendered without a shell keeps its reachable navigation', () => {
  render(<Navigation kind="settings" label="General" />);
  expect(screen.getByTestId('fallback-General').textContent).toBe('General');
});
