// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { readNote } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { KnowledgeLog } from './KnowledgeLog';

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return { ...actual, readNote: vi.fn() };
});

// The corpus's day, so a heading's distance from it is fixed.
vi.mock('@/lib/templates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/templates')>('@/lib/templates');
  return { ...actual, todayIso: () => '2026-07-28' };
});

afterEach(cleanup);

const log = makeEntry({
  path: 'knowledge/log.md',
  filename: 'log.md',
  folder: 'knowledge',
  title: 'Log',
});

describe('KnowledgeLog (M49.6)', () => {
  it('a bundle with no log says nothing has been logged', async () => {
    useVaultStore.setState({ vaultPath: '/vault', entries: [] });
    vi.mocked(readNote).mockRejectedValue(new Error('no such file'));
    render(<KnowledgeLog onOpenConcept={() => undefined} />);
    expect(await screen.findByText('Nothing logged yet')).toBeTruthy();
  });

  it('a log that exists and could not be read is unavailable, never "nothing logged"', async () => {
    useVaultStore.setState({ vaultPath: '/vault', entries: [log] });
    vi.mocked(readNote).mockRejectedValue(new Error('EACCES'));
    render(<KnowledgeLog onOpenConcept={() => undefined} />);
    expect(await screen.findByTestId('section-unavailable')).toBeTruthy();
    expect(screen.queryByText('Nothing logged yet')).toBeNull();
  });

  // M52.3 — "Deprecated … was replaced by …" said one change in two words.
  it('calls a deprecation whose concept something newer retired "Replaced"', async () => {
    const pilot = makeEntry({ path: 'knowledge/systems/pilot.md', filename: 'pilot.md' });
    const guarantee = makeEntry({
      path: 'knowledge/systems/guarantee.md',
      filename: 'guarantee.md',
      properties: { supersedes: '/systems/pilot.md' },
    });
    const webinar = makeEntry({ path: 'knowledge/metrics/webinar.md', filename: 'webinar.md' });
    useVaultStore.setState({ vaultPath: '/vault', entries: [log, pilot, guarantee, webinar] });
    vi.mocked(readNote).mockResolvedValue(
      [
        '## 2026-07-27',
        '* **Deprecation**: [The pilot](/systems/pilot.md) was replaced by [The guarantee](/systems/guarantee.md).',
        '* **Deprecation**: Marked [Webinar attendance](/metrics/webinar.md) deprecated.',
      ].join('\n'),
    );
    render(<KnowledgeLog onOpenConcept={() => undefined} />);
    await waitFor(() => expect(screen.getAllByTestId('log-entry')).toHaveLength(2));
    const labels = screen.getAllByTestId('log-entry-label').map((l) => l.textContent);
    expect(labels).toEqual(['Replaced', 'Deprecated']);
    // The kind is unchanged — only the word a reader sees.
    expect(screen.getAllByTestId('log-entry').map((e) => e.dataset.kind)).toEqual([
      'deprecation',
      'deprecation',
    ]);
  });

  // M52.5 — the log keeps the words written on the day; a link to a concept
  // names it as it is titled now, and what was logged is its hover.
  it('names a linked concept by its title now, and what was logged on hover', async () => {
    const cutover = makeEntry({
      path: 'knowledge/playbooks/cutover.md',
      filename: 'cutover.md',
      title: 'Cutover',
      properties: { title: 'Warehouse cutover: go-live and rollback' },
    });
    useVaultStore.setState({ vaultPath: '/vault', entries: [log, cutover] });
    vi.mocked(readNote).mockResolvedValue(
      [
        '## 2026-07-28',
        '* **Creation**: [Warehouse cutover](/playbooks/cutover.md) — a draft.',
        '* **Creation**: [Elsewhere](/playbooks/gone.md) — not a concept.',
      ].join('\n'),
    );
    render(<KnowledgeLog onOpenConcept={() => undefined} />);
    const links = await screen.findAllByTestId('log-concept-link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Warehouse cutover: go-live and rollback',
      'Elsewhere',
    ]);
    expect(links[0].getAttribute('title')).toBe('Logged as "Warehouse cutover"');
    // A link nothing answers keeps the log's own words, and no hover.
    expect(links[1].getAttribute('title')).toBeNull();
  });

  // M52.5 — the day as the table's Updated says it; the ISO date on hover.
  it('heads each day in words, with the date itself on hover', async () => {
    useVaultStore.setState({ vaultPath: '/vault', entries: [log] });
    vi.mocked(readNote).mockResolvedValue(
      [
        '## 2026-07-28',
        '* **Creation**: one.',
        '## 2026-07-27',
        '* **Creation**: two.',
        '## 2026-07-20',
        '* **Creation**: three.',
      ].join('\n'),
    );
    render(<KnowledgeLog onOpenConcept={() => undefined} />);
    await waitFor(() => expect(screen.getAllByTestId('log-day')).toHaveLength(3));
    const heads = screen.getAllByTestId('log-day').map((d) => d.querySelector('time'));
    expect(heads.map((t) => t?.textContent)).toEqual(['Today', 'Yesterday', '8d ago']);
    expect(heads.map((t) => t?.getAttribute('title'))).toEqual([
      '2026-07-28',
      '2026-07-27',
      '2026-07-20',
    ]);
    // Sentence case, as every label on the page.
    expect(screen.getAllByTestId('log-entry-label')[0].className).not.toContain('uppercase');
  });

  it('re-reads when the log changes', async () => {
    useVaultStore.setState({ vaultPath: '/vault', entries: [log] });
    vi.mocked(readNote).mockResolvedValue('');
    const before = vi.mocked(readNote).mock.calls.length;
    render(<KnowledgeLog onOpenConcept={() => undefined} />);
    await waitFor(() => expect(vi.mocked(readNote).mock.calls.length).toBe(before + 1));
    useVaultStore.setState({ entries: [{ ...log, modifiedAt: '2026-09-27T10:00:00Z' }] });
    await waitFor(() => expect(vi.mocked(readNote).mock.calls.length).toBe(before + 2));
  });
});
