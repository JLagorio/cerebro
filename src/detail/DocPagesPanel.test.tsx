// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocPages } from '@/engine/docPages';
import { makeEntry } from '@/engine/testHelpers';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { DocPagesFloatingButton, DocPagesPanel } from './DocPagesPanel';

const main = makeEntry({
  path: 'inbox/handbook/handbook.md',
  filename: 'handbook.md',
  folder: 'inbox/handbook',
  title: 'Handbook',
});
const extra = makeEntry({
  path: 'inbox/handbook/onboarding.md',
  filename: 'onboarding.md',
  folder: 'inbox/handbook',
  title: 'Onboarding',
});
const pages: DocPages = { folder: 'inbox/handbook', main, pages: [main, extra] };

describe('DocPagesPanel', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ docPagesOpen: true });
  });
  afterEach(cleanup);

  it('lists every page and navigates on click', () => {
    const navigate = vi.fn();
    useNavStore.setState({ navigate });
    render(<DocPagesPanel pages={pages} activePath={main.path} onAddPage={vi.fn()} />);
    const rows = screen.getAllByTestId('doc-pages-row');
    expect(rows.map((r) => r.textContent)).toEqual(['Handbook', 'Onboarding']);
    fireEvent.click(rows[1]);
    expect(navigate).toHaveBeenCalledWith({ kind: 'doc', path: extra.path });
  });

  it('collapses through the header button and reopens from the floating icon', () => {
    render(<DocPagesPanel pages={pages} activePath={main.path} onAddPage={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide pages' }));
    expect(useUiStore.getState().docPagesOpen).toBe(false);
    cleanup();
    render(<DocPagesFloatingButton />);
    fireEvent.click(screen.getByTestId('doc-pages-floating'));
    expect(useUiStore.getState().docPagesOpen).toBe(true);
  });

  it('offers Add page', () => {
    const onAddPage = vi.fn();
    render(<DocPagesPanel pages={pages} activePath={main.path} onAddPage={onAddPage} />);
    fireEvent.click(screen.getByRole('button', { name: /Add page/ }));
    expect(onAddPage).toHaveBeenCalled();
  });
});
