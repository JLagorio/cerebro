// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { FileTree } from './FileTree';

const ROOT = 'projects/guided-onboarding-ga';

/**
 * A template that declares `fill:` hands the new page to the assistant
 * (M17.10). The bubble it leaves names the act and the page (M52.4); the
 * pages-long prompt is what the agent is sent, not what the transcript shows.
 */
describe('FileTree template fill', () => {
  beforeEach(async () => {
    resetMockFs();
    window.localStorage.clear();
    useUiStore.setState({
      expandedFolders: {},
      treeOrder: {},
      toasts: [],
      agentPendingPrompt: null,
    });
    await useVaultStore.getState().openVault('/demo-vault');
  });
  afterEach(cleanup);

  it('asks for the fill under its label, about the page it made', async () => {
    const onOpen = vi.fn();
    render(<FileTree root={ROOT} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    fireEvent.change(screen.getByPlaceholderText('Page name'), {
      target: { value: 'Sprint PRD' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Template' }));
    fireEvent.click(screen.getByRole('option', { name: /prd/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(`${ROOT}/sprint-prd.md`));
    const pending = useUiStore.getState().agentPendingPrompt;
    expect(pending?.label).toBe('Fill from the template · Sprint PRD');
    expect(pending?.subject).toBe(`${ROOT}/sprint-prd.md`);
    expect(pending?.text).toContain('was just created from a template');
  });
});
