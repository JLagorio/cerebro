// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ComponentProps } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { EditorReadyInfo } from '@/editor/MarkdownEditor';
import { __resetOpenPages, flushOpenPages } from '@/editor/openPages';
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { DocPage } from './DocPage';

vi.mock('@/lib/ipc', { spy: true });
const editors = vi.hoisted(() => ({ infos: [] as EditorReadyInfo[] }));
vi.mock('@/editor/NoteBodyEditor', async (original) => {
  const mod = await original<typeof import('@/editor/NoteBodyEditor')>();
  return {
    ...mod,
    NoteBodyEditor: (props: ComponentProps<typeof mod.NoteBodyEditor>) =>
      createElement(mod.NoteBodyEditor, {
        ...props,
        onReady: (info: EditorReadyInfo) => {
          editors.infos.push(info);
          props.onReady?.(info);
        },
      }),
  };
});
const PATH = 'notes/blank-template-integration.md';
const TEMPLATE = 'templates/test-selected.md';
const VAULT = '/demo-vault';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

beforeAll(async () => {
  await import('@/editor/MarkdownEditor');
});
beforeEach(async () => {
  __resetOpenPages();
  vi.resetAllMocks();
  editors.infos = [];
  mock.resetMockFs();
  fs().set(PATH, '# Target\n\n');
  fs().set(TEMPLATE, '---\nstatus_note: chosen\n---\n# {{title}}\n\nSelected scaffold.\n');
  await useVaultStore.getState().openVault(VAULT);
  useUiStore.setState({ docPanelOpen: false, toasts: [] });
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.resetAllMocks();
});

it.each(['applied', 'refused'] as const)(
  'keeps the real editor owner and newer title while applying a template (%s)',
  async (outcome) => {
    render(<DocPage selection={{ kind: 'doc', path: PATH }} />);
    const button = await screen.findByRole('button', { name: /^Test selected$/ });
    const info = editors.infos[0];
    const editorNode = screen.getByTestId('markdown-editor');
    const title = info.editor.document.find((block) => block.type === 'heading')!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(ipc.applyBatch).mockImplementationOnce(async (vault, ops) => {
      await gate;
      if (outcome === 'refused') throw Error('refused');
      return mock.applyBatch(vault, ops);
    });
    fireEvent.click(button);
    await waitFor(() => expect(ipc.applyBatch).toHaveBeenCalledOnce());
    act(() => info.editor.updateBlock(title, { content: 'Title typed during template' }));
    try {
      await act(async () =>
        expect((await flushOpenPages()).unresolvedOwnerIds.length).toBeGreaterThan(0),
      );
      expect(ipc.saveNoteBody).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        release();
        await gate;
      });
    }
    if (outcome === 'applied')
      await waitFor(() => expect(info.serialize()).toContain('Selected scaffold.'));
    else await waitFor(() => expect(useUiStore.getState().toasts.length).toBeGreaterThan(0));
    await act(() => flushOpenPages());
    await waitFor(() => expect(fs().get(PATH)).toContain('# Title typed during template'));
    expect(screen.getByTestId('markdown-editor')).toBe(editorNode);
    expect(editors.infos).toHaveLength(1);
    expect(info.editor.document.some((block) => block.id === title.id)).toBe(true);
    if (outcome === 'applied') {
      expect(fs().get(PATH)).toContain('Selected scaffold.');
      expect(fs().get(PATH)).toContain('status_note: chosen');
    } else {
      expect(fs().get(PATH)).not.toContain('Selected scaffold.');
      expect(fs().get(PATH)).not.toContain('status_note: chosen');
    }
  },
);
