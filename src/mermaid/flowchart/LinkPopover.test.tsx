import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { LinkPopover } from './LinkPopover';

/** Minimal Entry shape — only the fields resolveTarget and this surface read. */
const entry = (path: string, title: string, filename: string, folder: string): Entry =>
  ({
    path,
    filename,
    folder,
    project: null,
    title,
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '',
    modifiedAt: '',
    parseError: null,
  }) satisfies Entry;

const LINK_ENTRIES: Entry[] = [
  entry('projects/atlas/project.md', 'Atlas', 'project.md', 'projects/atlas'),
  entry('notes/atlas-retro.md', 'Atlas retro', 'atlas-retro.md', 'notes'),
  entry('notes/other.md', 'Other note', 'other.md', 'notes'),
];

describe('LinkPopover', () => {
  it('typing a URL offers a URL link', async () => {
    const onPick = vi.fn();
    render(
      <LinkPopover
        entries={LINK_ENTRIES}
        current={null}
        contested={false}
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText('Link target'), 'https://example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Link to URL' }));
    expect(onPick).toHaveBeenCalledWith('https://example.com');
  });

  it('typing text searches records and picks a vault path', async () => {
    const onPick = vi.fn();
    render(
      <LinkPopover
        entries={LINK_ENTRIES}
        current={null}
        contested={false}
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText('Link target'), 'atlas');
    // resolveTarget's folder rule makes "atlas" hit the project; substring
    // matches follow. Pick the retro note.
    await userEvent.click(screen.getByRole('button', { name: 'Link to Atlas retro' }));
    expect(onPick).toHaveBeenCalledWith('notes/atlas-retro.md');
  });

  // The exact hit comes FIRST, so Enter — and the eye — land on the record the
  // vault's own resolution rule would have picked, not on whatever sorts first.
  it('Enter takes the top match once a query has narrowed the list', async () => {
    const onPick = vi.fn();
    render(
      <LinkPopover
        entries={LINK_ENTRIES}
        current={null}
        contested={false}
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText('Link target'), 'atlas{Enter}');
    expect(onPick).toHaveBeenCalledWith('projects/atlas/project.md');
  });

  it('Enter on an empty box picks nothing', async () => {
    const onPick = vi.fn();
    render(
      <LinkPopover
        entries={LINK_ENTRIES}
        current={null}
        contested={false}
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText('Link target'), '{Enter}');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('shows the current target with a clear action', async () => {
    const onPick = vi.fn();
    render(
      <LinkPopover
        entries={LINK_ENTRIES}
        current="notes/other.md"
        contested={false}
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('without entries, record search is absent but URL entry still works', async () => {
    const onPick = vi.fn();
    render(
      <LinkPopover
        entries={undefined}
        current={null}
        contested={false}
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText('Link target'), 'atlas');
    expect(screen.queryByRole('button', { name: 'Link to Atlas' })).toBeNull();
    await userEvent.clear(screen.getByLabelText('Link target'));
    await userEvent.type(screen.getByLabelText('Link target'), 'https://a.b');
    await userEvent.click(screen.getByRole('button', { name: 'Link to URL' }));
    expect(onPick).toHaveBeenCalledWith('https://a.b');
  });

  it('a query nothing matches says so instead of showing an empty list', async () => {
    render(
      <LinkPopover
        entries={LINK_ENTRIES}
        current={null}
        contested={false}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText('Link target'), 'zzzz');
    expect(screen.getByText('No records match "zzzz"')).toBeTruthy();
  });

  // `contested` is the honest half of a half-measure: a click statement we do
  // NOT own also writes this slot, so what renders may not be `current` and a
  // clear cannot fully clear. A control that offered "Remove link" without
  // saying so would be lying (nodeLinks' own words).
  it('a contested link says the editor is not the only writer', () => {
    render(
      <LinkPopover
        entries={LINK_ENTRIES}
        current="notes/other.md"
        contested
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('mermaid-link-contested').textContent).toContain('click');
  });

  // A node linked ONLY by a variant we do not own has NO nodeLinks entry at
  // all, so `current` is null while the picture is very much linked. Reading
  // "absent" as "unlinked" is the trap; saying so out loud is the fix.
  it('a link we do not own at all is reported, not silently ignored', () => {
    render(
      <LinkPopover
        entries={LINK_ENTRIES}
        current={null}
        contested
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    const note = screen.getByTestId('mermaid-link-contested').textContent ?? '';
    expect(note).toContain('cannot be edited here');
    // Nothing to remove: a clear would touch lines we do not own.
    expect(screen.queryByRole('button', { name: 'Remove link' })).toBeNull();
  });

  it('opens with the target box focused, like the other node popovers', () => {
    render(
      <LinkPopover
        entries={LINK_ENTRIES}
        current={null}
        contested={false}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Link target');
  });

  it('focus is trapped: Tab from the last control returns into the popover', async () => {
    render(
      <LinkPopover
        entries={LINK_ENTRIES}
        current="notes/other.md"
        contested={false}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    const surface = screen.getByTestId('mermaid-link-popover');
    screen.getByLabelText('Link target').focus();
    for (let i = 0; i < 8; i += 1) {
      await userEvent.tab();
      expect(surface.contains(document.activeElement), `after ${i + 1} tabs`).toBe(true);
    }
  });
});
