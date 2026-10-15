import { beforeEach, expect, it, vi } from 'vitest';
import { createLibraryItem, libraryItemPlace } from './libraryActions';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { createNote } from '@/lib/ipc';
vi.mock('@/lib/ipc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ipc')>()),
  createNote: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(createNote).mockReset().mockResolvedValue('created.md');
  useVaultStore.setState({ vaultPath: '/v', rescan: vi.fn().mockResolvedValue(undefined) });
  useUiStore.setState({ toasts: [] });
});
it.each([
  [
    'agent',
    'records/agents',
    { type: 'Agent', slug: 'new-agent', description: '', paused: true },
    '# New agent\n\nStanding instructions for every run. Say what to read, what to produce, and what never to touch.\n',
  ],
  [
    'skill',
    'records/skills',
    { type: 'Skill', slug: 'new-skill', description: '' },
    '# New skill\n\nWhat should the assistant do when this is invoked? Write it as numbered steps.\n',
  ],
  ['template', 'templates', { type: null }, '# {{title}}\n\n<!-- New template -->\n'],
] as const)(
  'creates %s with the established bytes and destination',
  async (kind, folder, fm, body) => {
    expect(await createLibraryItem(kind)).toBe('created.md');
    expect(createNote).toHaveBeenCalledWith('/v', folder, `new-${kind}`, fm, body);
    expect(libraryItemPlace(kind, 'created.md')).toEqual(
      kind === 'agent'
        ? { kind: 'doc', path: 'created.md' }
        : { kind: 'library', tab: kind, path: 'created.md' },
    );
  },
);
it('returns null and says why a create failed', async () => {
  vi.mocked(createNote).mockRejectedValue(new Error('disk full'));
  expect(await createLibraryItem('agent')).toBeNull();
  expect(useUiStore.getState().toasts.at(-1)?.message).toBe("Couldn't create the agent");
});
it('never returns a destination in a vault switched away from during creation', async () => {
  vi.mocked(createNote).mockImplementation(async () => {
    useVaultStore.setState({ vaultPath: '/other' });
    return 'created.md';
  });
  expect(await createLibraryItem('skill')).toBeNull();
});
