import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockRoots, seedKnowledgeDir, seedRoot } from '@/lib/mockRoots';
import { useRootsStore } from '@/stores/rootsStore';
import { RootMountDialog } from './RootMountDialog';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState({ roots: [], expanded: {}, children: {}, open: null, docs: [] });
});

describe('RootMountDialog', () => {
  it('renders the refusal instead of closing when a second knowledge root is mounted', async () => {
    seedRoot({ path: '/vault', label: 'vault', knowledge: true });
    seedKnowledgeDir('/repos/brain');
    await useRootsStore.getState().loadRoots();
    const onClose = vi.fn();

    render(<RootMountDialog pickPath={async () => '/repos/brain'} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('mount-choose'));

    const refusal = await screen.findByTestId('mount-refusal');
    expect(refusal.textContent).toContain('vault');
    expect(refusal.getAttribute('data-code')).toBe('knowledge_root_exists');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the refusal when the same folder is mounted twice', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    await useRootsStore.getState().loadRoots();

    render(<RootMountDialog pickPath={async () => '/repos/alpha'} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('mount-choose'));

    const refusal = await screen.findByTestId('mount-refusal');
    expect(refusal.getAttribute('data-code')).toBe('already_mounted');
  });

  it('closes on a successful mount', async () => {
    const onClose = vi.fn();
    render(<RootMountDialog pickPath={async () => '/repos/alpha'} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('mount-choose'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useRootsStore.getState().roots).toHaveLength(1);
  });

  it('does nothing when the picker is cancelled', async () => {
    const onClose = vi.fn();
    render(<RootMountDialog pickPath={async () => null} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('mount-choose'));

    await waitFor(() => expect(useRootsStore.getState().roots).toHaveLength(0));
    expect(onClose).not.toHaveBeenCalled();
  });
});
