// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/mermaid/FullScreenDiagramEditor', async () => {
  const { CodeOverlay } = await import('@/mermaid/CodeOverlay');
  return {
    FullScreenDiagramEditor: ({
      code,
      onChangeCode,
    }: {
      code: string;
      onChangeCode: (text: string) => void;
    }) => <CodeOverlay code={code} onChangeCode={onChangeCode} onClose={() => {}} />,
  };
});
import * as ipc from '@/lib/ipc';
import { sha256Hex } from '@/lib/sha256';
import { retainedDocumentOwner } from './openPages';
import { DiagramPage } from '@/pages/DiagramPage';
import { CanvasPage } from '@/pages/CanvasPage';
import { WhiteboardView } from '@/views/WhiteboardView';
import { buildSchema } from '@/engine/schema';
import type { Presentation } from '@/engine/types';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { __resetOpenPages, flushOpenPages } from './openPages';
import { recoveryDrafts, recoveryBundle } from './deletedDraftRecovery';
const canvas = vi.hoisted(() => ({
  editor: null as import('@/engine/scene/editor').SceneEditor | null,
}));
vi.mock('@/whiteboard/useCanvasFile', async (original) => {
  const mod = await original<typeof import('@/whiteboard/useCanvasFile')>();
  return {
    ...mod,
    useCanvasFile: (path: string) => {
      const file = mod.useCanvasFile(path);
      if (file.state === 'ready') canvas.editor = file.editor;
      return file;
    },
  };
});
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const vault = '/demo-vault';
const base: Presentation = { type: 'whiteboard', group: [], sort: [], columns: [] };
beforeEach(async () => {
  resetMockFs();
  __resetOpenPages();
  await useVaultStore.getState().openVault(vault);
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.restoreAllMocks();
});
it.each(['diagram page', 'embedded diagram'] as const)(
  '%s recovers Auto-update-off source after scan loses its target',
  async (host) => {
    const path = 'diagrams/recovery-host.mmd';
    fs().set(path, 'graph TD\r\n A-->B\r\n');
    await useVaultStore.getState().rescan();
    const view = render(
      host === 'diagram page' ? (
        <DiagramPage selection={{ kind: 'diagram', path }} />
      ) : (
        <WhiteboardView
          entries={[]}
          schema={buildSchema([])}
          presentation={{ ...base, whiteboard: { file: path } }}
          host={{ folder: '', viewName: 'Recovered' }}
        />
      ),
    );
    const input = await screen.findByRole('textbox', { name: 'Mermaid source' });
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-update' }));
    fireEvent.change(input, { target: { value: 'graph TD\n  [exact invalid 😀' } });
    const before = recoveryDrafts({ vaultId: vault, path })[0];
    expect(Object.values(before.payload.children).map((text) => JSON.parse(text).text)).toContain(
      'graph TD\n  [exact invalid 😀',
    );
    await act(async () => {
      fs().delete(path);
      await useVaultStore.getState().rescan();
    });
    await screen.findByTestId('deleted-draft-recovery');
    const after = recoveryDrafts({ vaultId: vault, path })[0];
    expect(after.ref.instanceId).toBe(before.ref.instanceId);
    expect(recoveryBundle(after)).toContain('[exact invalid 😀');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Discard this draft' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard permanently' }));
    view.unmount();
    await act(() => flushOpenPages());
    expect(recoveryDrafts({ vaultId: vault, path })).toEqual([]);
    expect(fs().has(path)).toBe(false);
  },
);
it.each(['canvas page', 'embedded canvas'] as const)(
  '%s exposes separately retained inspector data through its missing host',
  async (host) => {
    const path = 'boards/recovery-host.canvas';
    fs().set(
      path,
      JSON.stringify({
        nodes: [{ id: 'a', type: 'text', text: 'Card', x: 0, y: 0, width: 100, height: 60 }],
        edges: [],
        keep: 'unknown',
      }),
    );
    await useVaultStore.getState().rescan();
    const view = render(
      host === 'canvas page' ? (
        <CanvasPage selection={{ kind: 'diagram', path }} />
      ) : (
        <WhiteboardView
          entries={[]}
          schema={buildSchema([])}
          presentation={{ ...base, whiteboard: { file: path } }}
          host={{ folder: '', viewName: 'Recovered' }}
        />
      ),
    );
    await screen.findByTestId('wb-input');
    act(() => canvas.editor!.select(['n:a']));
    const width = await screen.findByRole('textbox', { name: 'W' });
    fireEvent.change(width, { target: { value: 'invalid width' } });
    const before = recoveryDrafts({ vaultId: vault, path })[0];
    await act(async () => {
      fs().delete(path);
      await useVaultStore.getState().rescan();
    });
    await screen.findByTestId('deleted-draft-recovery');
    const after = recoveryDrafts({ vaultId: vault, path })[0];
    expect(after.ref.instanceId).toBe(before.ref.instanceId);
    expect(JSON.parse(after.payload.body!.text).keep).toBe('unknown');
    expect(after.payload.children['canvas-fields']).toContain('invalid width');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Discard this draft' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard permanently' }));
    view.unmount();
    await act(() => flushOpenPages());
    expect(fs().has(path)).toBe(false);
    expect(recoveryDrafts({ vaultId: vault, path })).toEqual([]);
  },
);
it.each(['diagram page', 'embedded diagram'] as const)(
  '%s retains restored choices and adopts an explicitly selected fresh outside version',
  async (host) => {
    const path = 'diagrams/restored-choice.mmd',
      baseCode = 'graph TD\r\n A-->B\r\n',
      outside = 'graph TD\r\n Outside-->Restored\r\n';
    fs().set(path, baseCode);
    await useVaultStore.getState().rescan();
    render(
      host === 'diagram page' ? (
        <DiagramPage selection={{ kind: 'diagram', path }} />
      ) : (
        <WhiteboardView
          entries={[]}
          schema={buildSchema([])}
          presentation={{ ...base, whiteboard: { file: path } }}
          host={{ folder: '', viewName: 'Recovered' }}
        />
      ),
    );
    const input = await screen.findByRole('textbox', { name: 'Mermaid source' });
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-update' }));
    fireEvent.change(input, { target: { value: 'graph TD\n [retained choice' } });
    await act(async () => {
      fs().delete(path);
      await useVaultStore.getState().rescan();
    });
    await screen.findByText(/original file is missing/i);
    const before = recoveryDrafts({ vaultId: vault, path })[0];
    await act(async () => {
      fs().set(path, outside);
      await useVaultStore.getState().rescan();
    });
    expect(screen.getByTestId('deleted-draft-recovery')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
    await screen.findByRole('button', { name: 'Use restored file' });
    expect(recoveryDrafts({ vaultId: vault, path })[0].ref.instanceId).toBe(before.ref.instanceId);
    expect(fs().get(path)).toBe(outside);
    fireEvent.click(screen.getByRole('button', { name: 'Use restored file' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Mermaid source' })).toHaveProperty(
        'value',
        outside.replace(/\r\n/g, '\n'),
      ),
    );
    expect(screen.queryByTestId('deleted-draft-recovery')).toBeNull();
    expect(fs().get(path)).toBe(outside);
  },
);
it.each(['changed', 'deleted', 'edited'] as const)(
  'a raw restored choice refuses %s data without overwriting or recreating the target',
  async (change) => {
    const path = 'diagrams/adversarial-choice.mmd',
      outside = 'graph TD\n Outside-->Restored\n';
    fs().set(path, 'graph TD\n A-->B\n');
    await useVaultStore.getState().rescan();
    render(<DiagramPage selection={{ kind: 'diagram', path }} />);
    const input = await screen.findByRole('textbox', { name: 'Mermaid source' });
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-update' }));
    fireEvent.change(input, { target: { value: 'graph TD\n [retained choice' } });
    await act(async () => {
      fs().delete(path);
      await useVaultStore.getState().rescan();
    });
    await screen.findByText(/original file is missing/i);
    await act(async () => {
      fs().set(path, outside);
      await useVaultStore.getState().rescan();
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
    await screen.findByRole('button', { name: 'Use my draft' });
    if (change === 'deleted') fs().delete(path);
    else if (change === 'changed') fs().set(path, 'graph TD\n Newer-->Outside\n');
    else {
      const { retainedDocumentOwner } = await import('./openPages');
      act(() =>
        retainedDocumentOwner(recoveryDrafts({ vaultId: vault, path })[0].ref.key)!.edit(
          'newer exact local draft',
        ),
      );
    }
    fireEvent.click(screen.getByRole('button', { name: 'Use my draft' }));
    await screen.findByText(
      change === 'deleted' ? /Could not read the restored source/ : /draft changed/i,
    );
    const kept = recoveryDrafts({ vaultId: vault, path })[0];
    expect(kept.requiresRecovery).toBe(true);
    expect(kept.payload.body!.text).toContain(
      change === 'edited' ? 'newer exact local draft' : '[retained choice',
    );
    expect(fs().get(path)).toBe(
      change === 'deleted'
        ? undefined
        : change === 'changed'
          ? 'graph TD\n Newer-->Outside\n'
          : outside,
    );
  },
);

it('raw Use my draft guards a native outside update, remains held on refusal and cannot retry unguarded', async () => {
  const path = 'diagrams/dispatch-choice.mmd',
    outside = 'graph TD\n Outside-->Restored\n',
    newer = 'graph TD\n Newer-->Outside\n';
  fs().set(path, 'graph TD\n A-->B\n');
  await useVaultStore.getState().rescan();
  render(<DiagramPage selection={{ kind: 'diagram', path }} />);
  const input = await screen.findByRole('textbox', { name: 'Mermaid source' });
  fireEvent.click(screen.getByRole('switch', { name: 'Auto-update' }));
  fireEvent.change(input, { target: { value: 'graph TD\n [retained choice' } });
  await act(async () => {
    fs().delete(path);
    await useVaultStore.getState().rescan();
  });
  await screen.findByText(/original file is missing/i);
  await act(async () => {
    fs().set(path, outside);
    await useVaultStore.getState().rescan();
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
  await screen.findByRole('button', { name: 'Use my draft' });
  const realSave = ipc.saveNote;
  const write = vi
    .spyOn(ipc, 'saveNote')
    .mockImplementationOnce((vault, path, body, expectHash) => {
      fs().set(path, newer);
      return realSave(vault, path, body, expectHash);
    });
  fireEvent.click(screen.getByRole('button', { name: 'Use my draft' }));
  await waitFor(() =>
    expect(recoveryDrafts({ vaultId: vault, path })[0].state.failure).not.toBeNull(),
  );
  expect(write).toHaveBeenCalledWith(
    vault,
    path,
    'graph TD\n [retained choice',
    sha256Hex(outside),
  );
  expect(fs().get(path)).toBe(newer);
  const draft = recoveryDrafts({ vaultId: vault, path })[0];
  expect(draft.requiresRecovery).toBe(true);
  expect(draft.payload.body!.text).toContain('[retained choice');
  await act(async () => {
    expect((await retainedDocumentOwner(draft.ref.key)!.retry()).kind).toBe('blocked');
  });
  expect(write).toHaveBeenCalledOnce();
});
it('raw Use my draft advances the version guard only from the writer acknowledgement', async () => {
  const path = 'diagrams/ack-choice.mmd',
    outside = 'graph TD\n Outside-->Restored\n',
    mine = 'graph TD\n [retained choice';
  fs().set(path, 'graph TD\n A-->B\n');
  await useVaultStore.getState().rescan();
  render(<DiagramPage selection={{ kind: 'diagram', path }} />);
  const input = await screen.findByRole('textbox', { name: 'Mermaid source' });
  fireEvent.click(screen.getByRole('switch', { name: 'Auto-update' }));
  fireEvent.change(input, { target: { value: mine } });
  await act(async () => {
    fs().delete(path);
    await useVaultStore.getState().rescan();
  });
  await screen.findByText(/original file is missing/i);
  await act(async () => {
    fs().set(path, outside);
    await useVaultStore.getState().rescan();
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
  await screen.findByRole('button', { name: 'Use my draft' });
  const write = vi.spyOn(ipc, 'saveNote');
  fireEvent.click(screen.getByRole('button', { name: 'Use my draft' }));
  await waitFor(() => expect(fs().get(path)).toBe(mine));
  expect(write).toHaveBeenCalledWith(vault, path, mine, sha256Hex(outside));
  const current = await screen.findByRole('textbox', { name: 'Mermaid source' });
  fireEvent.change(current, { target: { value: 'graph TD\n Latest-->Mine' } });
  await act(() => flushOpenPages());
  expect(fs().get(path)).toBe('graph TD\n Latest-->Mine');
  expect(write).toHaveBeenLastCalledWith(vault, path, 'graph TD\n Latest-->Mine', sha256Hex(mine));
});
it.each(['canvas page', 'embedded canvas'] as const)(
  '%s keeps recovery release reachable when a restored scan clears its ordinary missing flag',
  async (host) => {
    const path = 'boards/restored-hold.canvas',
      source = JSON.stringify({
        nodes: [{ id: 'a', type: 'text', text: 'Card', x: 0, y: 0, width: 100, height: 60 }],
        edges: [],
      });
    fs().set(path, source);
    await useVaultStore.getState().rescan();
    render(
      host === 'canvas page' ? (
        <CanvasPage selection={{ kind: 'diagram', path }} />
      ) : (
        <WhiteboardView
          entries={[]}
          schema={buildSchema([])}
          presentation={{ ...base, whiteboard: { file: path } }}
          host={{ folder: '', viewName: 'Recovered' }}
        />
      ),
    );
    await screen.findByTestId('wb-input');
    act(() => canvas.editor!.select(['n:a']));
    fireEvent.change(await screen.findByRole('textbox', { name: 'W' }), {
      target: { value: 'invalid retained width' },
    });
    await act(async () => {
      fs().delete(path);
      await useVaultStore.getState().rescan();
    });
    await screen.findByText(/original file is missing/i);
    const before = recoveryDrafts({ vaultId: vault, path })[0];
    await act(async () => {
      fs().set(path, source);
      await useVaultStore.getState().rescan();
    });
    expect(screen.getByTestId('deleted-draft-recovery')).toBeTruthy();
    expect(recoveryDrafts({ vaultId: vault, path })[0].ref.instanceId).toBe(before.ref.instanceId);
    fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
    await screen.findByTestId('wb-input');
    expect(screen.queryByTestId('deleted-draft-recovery')).toBeNull();
    expect(canvas.editor).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'W' })).toHaveProperty(
      'value',
      'invalid retained width',
    );
    expect(fs().get(path)).toBe(source);
  },
);

it.each(['canvas page', 'embedded canvas'] as const)(
  'independent: %s preserves recovery until restored content is actually read',
  async (host) => {
    const path = 'boards/independent-restored-read.canvas';
    const source = JSON.stringify({
      nodes: [{ id: 'a', type: 'text', text: 'Card', x: 0, y: 0, width: 100, height: 60 }],
      edges: [],
    });
    fs().set(path, source);
    await useVaultStore.getState().rescan();
    render(
      host === 'canvas page' ? (
        <CanvasPage selection={{ kind: 'diagram', path }} />
      ) : (
        <WhiteboardView
          entries={[]}
          schema={buildSchema([])}
          presentation={{ ...base, whiteboard: { file: path } }}
          host={{ folder: '', viewName: 'Independent' }}
        />
      ),
    );
    await screen.findByTestId('wb-input');
    act(() => canvas.editor!.select(['n:a']));
    fireEvent.change(await screen.findByRole('textbox', { name: 'W' }), {
      target: { value: 'invalid independent width' },
    });
    await act(async () => {
      fs().delete(path);
      await useVaultStore.getState().rescan();
    });
    await screen.findByText(/original file is missing/i);
    const before = recoveryDrafts({ vaultId: vault, path })[0];
    await act(async () => {
      fs().set(path, source);
      await useVaultStore.getState().rescan();
    });
    const read = vi
      .spyOn(ipc, 'readCanvasFile')
      .mockRejectedValue(Error('independent unavailable restored canvas'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
    await waitFor(() => expect(read).toHaveBeenCalled());
    await waitFor(() => expect(recoveryDrafts({ vaultId: vault, path })[0].busy).toBe(false));
    const after = recoveryDrafts({ vaultId: vault, path })[0];
    expect(after.ref.instanceId).toBe(before.ref.instanceId);
    expect(after.payload.children['canvas-fields']).toContain('invalid independent width');
    expect(fs().get(path)).toBe(source);
    expect(screen.queryByTestId('deleted-draft-recovery')).not.toBeNull();
    expect(after.requiresRecovery).toBe(true);
  },
);

it.each(['canvas page', 'embedded canvas'] as const)(
  '%s keeps opaque recovery through a second actual reconciliation read failure',
  async (host) => {
    const path = 'boards/second-recovery-read.canvas';
    const source = JSON.stringify({
      nodes: [{ id: 'a', type: 'text', text: 'Card', x: 0, y: 0, width: 100, height: 60 }],
      edges: [],
    });
    fs().set(path, source);
    await useVaultStore.getState().rescan();
    render(
      host === 'canvas page' ? (
        <CanvasPage selection={{ kind: 'diagram', path }} />
      ) : (
        <WhiteboardView
          entries={[]}
          schema={buildSchema([])}
          presentation={{ ...base, whiteboard: { file: path } }}
          host={{ folder: '', viewName: 'Second read' }}
        />
      ),
    );
    await screen.findByTestId('wb-input');
    act(() => canvas.editor!.select(['n:a']));
    fireEvent.change(await screen.findByRole('textbox', { name: 'W' }), {
      target: { value: 'opaque second-read width' },
    });
    await act(async () => {
      fs().delete(path);
      await useVaultStore.getState().rescan();
    });
    await screen.findByText(/original file is missing/i);
    const before = recoveryDrafts({ vaultId: vault, path })[0];
    await act(async () => {
      fs().set(path, source);
      await useVaultStore.getState().rescan();
    });
    const original = ipc.readCanvasFile;
    const read = vi
      .spyOn(ipc, 'readCanvasFile')
      .mockImplementationOnce(original)
      .mockRejectedValue(Error('actual reconciliation unavailable'));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(recoveryDrafts({ vaultId: vault, path })[0].busy).toBe(false));
    const after = recoveryDrafts({ vaultId: vault, path })[0];
    expect(after.requiresRecovery).toBe(true);
    expect(after.ref.instanceId).toBe(before.ref.instanceId);
    expect(after.payload.children['canvas-fields']).toContain('opaque second-read width');
    expect(screen.getByTestId('deleted-draft-recovery')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy recovery data' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard this draft' })).toBeTruthy();
    expect(fs().get(path)).toBe(source);
  },
);
it('a new opaque child during actual canvas reconciliation cannot be admitted by an older read', async () => {
  const path = 'boards/changed-during-read.canvas';
  const source = JSON.stringify({
    nodes: [{ id: 'a', type: 'text', text: 'Card', x: 0, y: 0, width: 100, height: 60 }],
    edges: [],
  });
  fs().set(path, source);
  await useVaultStore.getState().rescan();
  render(<CanvasPage selection={{ kind: 'diagram', path }} />);
  await screen.findByTestId('wb-input');
  act(() => canvas.editor!.select(['n:a']));
  fireEvent.change(await screen.findByRole('textbox', { name: 'W' }), {
    target: { value: 'invalid before read' },
  });
  await act(async () => {
    fs().delete(path);
    await useVaultStore.getState().rescan();
  });
  await screen.findByText(/original file is missing/i);
  await act(async () => {
    fs().set(path, source);
    await useVaultStore.getState().rescan();
  });
  const original = ipc.readCanvasFile;
  const result = await original(vault, path);
  let finish!: (value: typeof result) => void;
  const read = vi
    .spyOn(ipc, 'readCanvasFile')
    .mockImplementationOnce(original)
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  fireEvent.click(await screen.findByRole('button', { name: 'Reload restored page' }));
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThanOrEqual(2));
  const { registerBoardDraft } = await import('@/whiteboard/pendingText');
  const stop = registerBoardDraft(
    { editor: canvas.editor!, id: 'newer-child' },
    { prepare: () => false, snapshot: () => 'newer opaque exact child' },
  );
  await act(async () => {
    finish(result);
  });
  const after = recoveryDrafts({ vaultId: vault, path })[0];
  expect(after.requiresRecovery).toBe(true);
  expect(after.payload.children['canvas-fields']).toContain('newer opaque exact child');
  expect(screen.getByTestId('deleted-draft-recovery')).toBeTruthy();
  expect(fs().get(path)).toBe(source);
  stop();
});
