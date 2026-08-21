import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuickOpen } from '@/app/QuickOpen';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { fixtureVault } from '@/test/factories';

afterEach(cleanup);

const PLACEHOLDER = 'Search notes, lists, types, and places…';

describe('QuickOpen', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ quickOpenVisible: true });
  });

  it('ranks an exact title prefix above a mid-title match', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'guided');
    const options = screen.getAllByRole('option');
    // The ask row is pinned above every match (M42.5, the DS ask-bar
    // contract); 'Guided onboarding' (prefix match) must rank first among
    // the MATCHES — and carry the default highlight, so Enter still means
    // "open the thing I named".
    expect(options[0].textContent).toContain('Ask the assistant');
    expect(options[0].getAttribute('aria-selected')).toBe('false');
    expect(options[1].textContent).toContain('Guided onboarding');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
  });

  it('the ask row hands the words to the assistant panel (M42.5)', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'why is onboarding stalling');
    await user.click(screen.getByRole('option', { name: /Ask the assistant/ }));
    expect(useUiStore.getState().aiPanelOpen).toBe(true);
    expect(useUiStore.getState().agentPendingPrompt).toEqual({
      text: 'why is onboarding stalling',
      subject: null,
    });
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
  });

  it('Enter opens the top result and closes the palette', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'guided{Enter}');
    // M12.5: a legacy project.md is an ordinary record now — panel over its
    // folder's Collection, never a page of its own.
    expect(useNavStore.getState().selection).toEqual({
      kind: 'collection',
      folder: 'projects/onboarding',
    });
    expect(useUiStore.getState().detailPath).toBe('projects/onboarding/project.md');
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
  });

  it('picking an item opens its detail over its containing Collection', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'wire');
    // [0] is the pinned ask row (M42.5); the best match sits under it.
    await user.click(screen.getAllByRole('option')[1]);
    // M12.5: containment still gives the backdrop, but the backdrop is the
    // folder's Collection — the project page is gone.
    expect(useNavStore.getState().selection).toEqual({
      kind: 'collection',
      folder: 'projects/onboarding',
    });
    expect(useUiStore.getState().detailPath).toBe('projects/onboarding/items/fld-2.md');
  });

  // M12.1: every typed entry is a record. A Person has no project, so its
  // backdrop is its type screen, and it opens in the panel — never in Docs.
  it('picking a record without a project lands on its type screen with the panel', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ detailPath: null });
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'ana');
    // [0] is the pinned ask row (M42.5); the best match sits under it.
    await user.click(screen.getAllByRole('option')[1]);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'type',
      name: 'Person',
    });
    expect(useUiStore.getState().detailPath).toBe('people/ana-rios.md');
  });

  // It used to restate the placeholder verbatim ~50px under itself and offer
  // nothing to press.
  it('offers the places on an empty query instead of restating the placeholder', () => {
    render(<QuickOpen />);
    expect(screen.queryByText('Type to search notes, lists, types, and places to go.')).toBeNull();
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    expect(options.map((o) => o.textContent).join(' ')).toContain('Home');
  });

  it('hints the keys in the dialog footer', () => {
    render(<QuickOpen />);
    expect(screen.getByText('↑↓ navigate · ↵ open · esc close')).toBeTruthy();
  });

  it('Enter on the empty query opens the first place', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), '{Enter}');
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
  });

  // Two adjacent spans in the identical mono style read as one phrase: a
  // record key and a type name were typographically indistinguishable.
  it('gives the record key and the kind label distinct treatments', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'guided');
    // [1]: the pinned ask row above it has no key chip to measure (M42.5).
    const spans = [...screen.getAllByRole('option')[1].querySelectorAll('span')];
    const mono = spans.filter((s) => s.className.includes('font-mono'));
    expect(mono).toHaveLength(1);
    const kind = spans[spans.length - 1];
    expect(kind.className).not.toContain('font-mono');
    // fixed-width column so the category aligns down the list
    expect(kind.className).toContain('w-[84px]');
  });

  it('renders a type target count in words rather than a bare number chip', async () => {
    const user = userEvent.setup();
    render(<QuickOpen />);
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'person');
    const rows = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    // The type target used to carry a bare "4" in a mono chip, styled exactly
    // like a record key.
    expect(rows.some((t) => /\d+ records?Type$/.test(t))).toBe(true);
  });
});
