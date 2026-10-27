// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/ipc', { spy: true });
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import * as activation from '@/agent/activation';
import { chooseOption } from '@/test/chooseOption';
import { navSeed } from '@/test/navSeed';
import { renameKeepingLinks } from '@/app/renameActions';
import { PaneContext, useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useRenamePromptStore } from '@/stores/renamePromptStore';
import { DeletedDraftRecovery } from '@/editor/DeletedDraftRecoveryFace';
import { recoveryDrafts } from '@/editor/deletedDraftRecovery';
import { __resetOpenPages, flushOpenPages, registerSaveParticipant } from '@/editor/openPages';
import { retainedLibraryDraft, LibraryDraftOwner, libraryDraftKey } from './libraryDraftOwner';
import { LibraryPage } from './LibraryPage';
const VAULT = '/demo-vault';
const FROM = 'records/skills/identity-skill.md';
const TO = 'records/skills/moved-identity-skill.md';
const ORIGINAL =
  '---\ntype: Skill\ndescription: Original\n---\n\n# Identity skill\n\nOriginal instructions.\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const owner = (path: string) => retainedLibraryDraft(VAULT, path, 'p93');
beforeEach(async () => {
  __resetOpenPages();
  vi.clearAllMocks();
  mock.resetMockFs();
  fs().set(FROM, ORIGINAL);
  await useVaultStore.getState().openVault(VAULT);
  useNavStore.setState({
    active: 'p93',
    paneIds: ['p93'],
    focusOrder: ['p93'],
    stashed: {},
    selection: { kind: 'library', tab: 'skill', path: FROM },
    history: [navSeed({ kind: 'library', tab: 'skill', path: FROM })],
    historyIndex: 0,
  });
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.restoreAllMocks();
  useRenamePromptStore.getState().cancel();
});
const mount = () =>
  render(
    <PaneContext.Provider value="p93">
      <LibraryPage />
    </PaneContext.Provider>,
  );
const rename = () => renameKeepingLinks({ steps: [{ from: FROM, to: TO }], label: 'Moved skill' });
it.each(['landed', 'refused'] as const)(
  'keeps a late Library decision explicit while native rename is %s',
  async (result) => {
    mount();
    const input = await screen.findByLabelText('Instructions');
    await waitFor(() => expect(owner(FROM)).toBeDefined());
    const retained = owner(FROM)!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async (vault, from, to) => {
      await gate;
      if (result === 'refused') throw new Error('rename refused');
      return mock.renameNote(vault, from, to);
    });
    let pending!: ReturnType<typeof rename>;
    await act(async () => {
      pending = rename();
    });
    await waitFor(() => expect(native).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: 'Exact unsubmitted Library decision 😀' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(fs().get(FROM)).toBe(ORIGINAL);
    try {
      await act(async () => {
        expect((await flushOpenPages()).unresolvedOwnerIds).toHaveLength(1);
      });
    } finally {
      await act(async () => {
        release();
        await pending;
      });
    }
    const path = result === 'landed' ? TO : FROM;
    expect(owner(path)).toBe(retained);
    expect(await screen.findByLabelText('Instructions')).toHaveProperty(
      'value',
      'Exact unsubmitted Library decision 😀',
    );
    expect(fs().get(path)).toBe(ORIGINAL);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect(fs().get(path)).toContain('Exact unsubmitted Library decision 😀');
    expect(fs().has(result === 'landed' ? FROM : TO)).toBe(false);
  },
);
it('uses the moved path for a later unslugged schedule activation', async () => {
  const stamp = vi.spyOn(activation, 'stampActivation').mockResolvedValue(true);
  mount();
  await screen.findByLabelText('Instructions');
  await waitFor(() => expect(owner(FROM)).toBeDefined());
  await act(async () => {
    expect(await rename()).not.toBeNull();
  });
  chooseOption(await screen.findByLabelText('Repeat'), 'Every day');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Saved' });
  expect(stamp.mock.calls[0]?.[1]).toBe(TO);
  expect(fs().has(FROM)).toBe(false);
});
it('keeps late authored Library text when rename retitles disk and the existing hash guard refuses Save', async () => {
  mount();
  const input = await screen.findByLabelText('Instructions');
  await waitFor(() => expect(owner(FROM)).toBeDefined());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = vi.spyOn(ipc, 'applyBatch').mockImplementationOnce(async (vault, ops) => {
    await gate;
    return mock.applyBatch(vault, ops);
  });
  let pending!: ReturnType<typeof renameKeepingLinks>;
  await act(async () => {
    pending = renameKeepingLinks({
      steps: [{ from: FROM, to: TO }],
      retitle: { path: FROM, title: 'Retitled skill' },
      label: 'Retitled skill',
    });
  });
  await waitFor(() => expect(native).toHaveBeenCalled());
  fireEvent.change(input, { target: { value: 'Authored while title changed 😀' } });
  await act(async () => {
    release();
    await pending;
  });
  expect(await screen.findByLabelText('Instructions')).toHaveProperty(
    'value',
    'Authored while title changed 😀',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByTestId('library-stale');
  expect(fs().get(TO)).toBe(ORIGINAL.replace('# Identity skill', '# Retitled skill'));
  expect(screen.getByLabelText('Instructions')).toHaveProperty(
    'value',
    'Authored while title changed 😀',
  );
  expect(fs().has(FROM)).toBe(false);
});

it('admits the exposed Library form before a DOM input and leave can bypass its draft', async () => {
  const edits = vi.spyOn(LibraryDraftOwner.prototype, 'edit');
  type Observation = {
    selection: ReturnType<typeof useNavStore.getState>['selection'];
    registered: boolean;
    text: string | undefined;
  };
  let observed: Observation | null = null;
  const observer = new MutationObserver(() => {
    const input = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Instructions"],textarea#skill-instructions',
    );
    if (!input) return;
    observer.disconnect();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(input, 'Exposed admission draft 😀');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const registered = owner(FROM) !== undefined;
    const edited = edits.mock.contexts.at(-1) as LibraryDraftOwner | undefined;
    const text = edited?.snapshot().latestDraft;
    useNavStore.getState().navigate({ kind: 'home' });
    observed = { selection: useNavStore.getState().selection, registered, text };
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    mount();
    await waitFor(() => expect(observed).not.toBeNull());
    const actual = observed as Observation | null;
    expect(actual!.text).toContain('Exposed admission draft 😀');
    expect(actual).toMatchObject({
      registered: true,
      selection: { kind: 'library', path: FROM },
    });
    expect(fs().get(FROM)).toBe(ORIGINAL);
  } finally {
    observer.disconnect();
  }
});

it.each(['landed', 'refused', 'cancelled'] as const)(
  'repair1 defers a late Library destination form: %s',
  async (outcome) => {
    mount();
    await screen.findByLabelText('Instructions');
    await waitFor(() => expect(owner(FROM)).toBeDefined());
    const original = owner(FROM)!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async (vault, from, to) => {
      await gate;
      if (outcome === 'refused') throw new Error('move refused');
      return mock.renameNote(vault, from, to);
    });
    let pending!: ReturnType<typeof rename>;
    await act(async () => {
      pending = rename();
    });
    await waitFor(() => expect(native).toHaveBeenCalled());
    await act(async () => cleanup());
    act(() => {
      const entry = useVaultStore.getState().entries.find((entry) => entry.path === FROM)!;
      useVaultStore.setState((state) => ({ entries: [...state.entries, { ...entry, path: TO }] }));
      useNavStore.setState({ selection: { kind: 'library', tab: 'skill', path: TO } });
    });
    const reads = vi.spyOn(ipc, 'readNoteSource');
    const view = mount();
    try {
      await act(async () => {});
      expect(screen.queryByLabelText('Instructions')).toBeNull();
      expect(screen.getByRole('status').textContent).toContain('moving');
      expect(reads.mock.calls.filter(([, path]) => path === TO)).toHaveLength(0);
      if (outcome === 'cancelled') view.unmount();
    } finally {
      await act(async () => {
        release();
        await pending;
      });
    }
    if (outcome === 'landed') {
      expect(await screen.findByLabelText('Instructions')).toHaveProperty(
        'value',
        original.draft.kind === 'skill' ? original.draft.value.instructions : '',
      );
      expect(owner(TO)).toBe(original);
    } else if (outcome === 'cancelled') {
      await act(async () => {});
      expect(reads.mock.calls.filter(([, path]) => path === TO)).toHaveLength(0);
      expect(owner(TO)).toBe(original);
    } else {
      await waitFor(() => expect(screen.queryByLabelText('Instructions')).toBeNull());
      fireEvent.click(await screen.findByText('Identity skill'));
      await screen.findByLabelText('Instructions');
      expect(owner(FROM)).toBe(original);
      expect(owner(TO)).toBeUndefined();
      expect(fs().has(TO)).toBe(false);
    }
  },
);

it('repair1 retains a pre-authored late Library handle with isolated recovery actions and no automatic Save', async () => {
  mount();
  await screen.findByLabelText('Instructions');
  await waitFor(() => expect(owner(FROM)).toBeDefined());
  const original = owner(FROM)!;
  const source = await ipc.readNoteSource(VAULT, FROM);
  const entry = { ...original.entry, path: TO };
  const late = new LibraryDraftOwner(libraryDraftKey(VAULT, TO, 'p93'), entry, 'skill', source);
  if (late.draft.kind !== 'skill') throw new Error('wrong draft');
  late.edit('Separate authored Name', {
    kind: 'skill',
    value: { ...late.draft.value, instructions: 'Exact separate Library decision 😀' },
  });
  const exact = JSON.stringify({ name: late.name, draft: late.draft });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const native = vi.spyOn(ipc, 'renameNote').mockImplementationOnce(async (vault, from, to) => {
    await gate;
    return mock.renameNote(vault, from, to);
  });
  const batches = vi.spyOn(ipc, 'applyBatch');
  let pending!: ReturnType<typeof rename>;
  await act(async () => {
    pending = rename();
  });
  await waitFor(() => expect(native).toHaveBeenCalled());
  try {
    act(() => {
      expect(registerSaveParticipant(late).admission.kind).toBe('deferred');
    });
    await act(() => late.save());
    expect(batches).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      release();
      await pending;
    });
  }
  expect(owner(TO)).toBe(original);
  act(() => {
    const readmitted = registerSaveParticipant(late);
    expect({
      admission: readmitted.admission.kind,
      canonicalSource: owner(TO) === original,
    }).toEqual({ admission: 'deferred', canonicalSource: true });
  });
  expect(owner(TO)).toBe(original);
  expect(fs().get(TO)).toBe(ORIGINAL);
  const ref = recoveryDrafts({ vaultId: VAULT, path: TO })[0].ref;
  const clipboard = vi.spyOn(ipc, 'writeClipboard').mockResolvedValue();
  render(<DeletedDraftRecovery vaultId={VAULT} path={TO} fallback={null} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy value' }));
  await waitFor(() => expect(clipboard).toHaveBeenCalledWith(exact));
  expect(recoveryDrafts({ vaultId: VAULT, path: TO })[0].ref.instanceId).toBe(ref.instanceId);
  fireEvent.click(screen.getByRole('button', { name: 'Discard this draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard permanently' }));
  await waitFor(() => expect(recoveryDrafts({ vaultId: VAULT, path: TO })).toHaveLength(0));
  expect(owner(TO)).toBe(original);
  expect(original.name).toBe('Identity skill');
  expect(fs().get(TO)).toBe(ORIGINAL);
  await act(() => late.save());
  expect(batches).not.toHaveBeenCalled();
});
