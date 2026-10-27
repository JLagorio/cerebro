import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { __resetOpenPages, flushOpenPages, unresolvedOpenPages } from '@/editor/openPages';
import { emptyMockVault, scanVault } from '@/lib/mockIpc';
import * as ipc from '@/lib/ipc';
import { PaneContext, useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { LibraryPage } from './LibraryPage';

const path = 'records/skills/retain.md';
const original =
  '---\ntype: Skill\nslug: retain\ndescription: Original\n---\n\n# Retain\n\nOriginal instructions.\n';
const disk = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const scan = async () => useVaultStore.setState({ entries: await scanVault('/vault') });
const open = () => useNavStore.setState({ selection: { kind: 'library', tab: 'skill', path } });
beforeEach(async () => {
  __resetOpenPages();
  useNavStore.getState().reset();
  emptyMockVault();
  disk().set(path, original);
  useVaultStore.setState({ vaultPath: '/vault', entriesVault: '/vault', rescan: scan });
  await scan();
  open();
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.restoreAllMocks();
});

it('retains the exact composite draft across blocked leave and unmount/reopen without granting it', async () => {
  const view = render(<LibraryPage />);
  fireEvent.change(await screen.findByLabelText('Instructions'), {
    target: { value: 'Unsubmitted instructions' },
  });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Private draft title' } });
  const report = await flushOpenPages();
  expect(report.unresolvedOwnerIds).toHaveLength(1);
  expect(report.outcomes[0]).toMatchObject({ kind: 'blocked', reason: 'choice' });
  expect(disk().get(path)).toBe(original);
  view.unmount();
  expect(unresolvedOpenPages()[0].latestDraft).toContain('Unsubmitted instructions');
  render(<LibraryPage />);
  expect(await screen.findByLabelText('Instructions')).toHaveProperty(
    'value',
    'Unsubmitted instructions',
  );
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Private draft title');
  fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
  await waitFor(() => expect(unresolvedOpenPages()).toHaveLength(0));
  expect(disk().get(path)).toBe(original);
});

it('keeps newer edits unresolved while acknowledging only the explicit Save generation', async () => {
  const realBatch = ipc.applyBatch;
  let release!: () => void;
  vi.spyOn(ipc, 'applyBatch').mockImplementationOnce(async (...args) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return realBatch(...args);
  });
  render(<LibraryPage />);
  const input = await screen.findByLabelText('Instructions');
  fireEvent.change(input, { target: { value: 'First explicit decision' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  fireEvent.change(input, { target: { value: 'Newer unsubmitted text' } });
  await act(async () => release());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false),
  );
  expect(disk().get(path)).toContain('First explicit decision');
  expect(unresolvedOpenPages()[0].latestDraft).toContain('Newer unsubmitted text');
  expect(input).toHaveProperty('value', 'Newer unsubmitted text');
});

it('retains a failed atomic write and retries without another edit or partial metadata', async () => {
  vi.spyOn(ipc, 'applyBatch').mockRejectedValueOnce(new Error('disk full'));
  render(<LibraryPage />);
  fireEvent.change(await screen.findByLabelText('Instructions'), {
    target: { value: 'Retry these exact bytes' },
  });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Retry save' });
  expect(disk().get(path)).toBe(original);
  expect(unresolvedOpenPages()[0].latestDraft).toContain('Retry these exact bytes');
  fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
  await screen.findByRole('button', { name: 'Saved' });
  expect(disk().get(path)).toContain('# Renamed\n\nRetry these exact bytes\n');
  expect(unresolvedOpenPages()).toHaveLength(0);
});

it('keeps a deleted target recoverable without silently recreating its file', async () => {
  render(<LibraryPage />);
  fireEvent.change(await screen.findByLabelText('Instructions'), {
    target: { value: 'Keep after deletion' },
  });
  disk().delete(path);
  await act(scan);
  expect(screen.getByLabelText('Instructions')).toHaveProperty('value', 'Keep after deletion');
  expect(screen.getByRole('button', { name: 'Copy draft' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(unresolvedOpenPages()).toHaveLength(1));
  expect(disk().has(path)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
  expect(unresolvedOpenPages()).toHaveLength(0);
});

it('retains a failed activation boundary and Retry repairs it without rewriting the saved bytes', async () => {
  const activation = await import('@/agent/activation');
  const { chooseOption } = await import('@/test/chooseOption');
  vi.spyOn(activation, 'stampActivation').mockResolvedValueOnce(false).mockResolvedValue(true);
  render(<LibraryPage />);
  await screen.findByLabelText('Instructions');
  chooseOption(screen.getByLabelText('Repeat'), 'Every day');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Retry save' });
  const saved = disk().get(path);
  expect(saved).toContain('schedule: daily 09:00');
  expect(unresolvedOpenPages()).toHaveLength(1);
  vi.spyOn(ipc, 'applyBatch').mockRejectedValue(new Error('Retry must only repair activation'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
  await screen.findByRole('button', { name: 'Saved' });
  expect(disk().get(path)).toBe(saved);
  expect(unresolvedOpenPages()).toHaveLength(0);
});

it('does not overwrite an outside change while retrying a saved schedule boundary', async () => {
  const activation = await import('@/agent/activation');
  const { chooseOption } = await import('@/test/chooseOption');
  vi.spyOn(activation, 'stampActivation').mockResolvedValue(false);
  render(<LibraryPage />);
  await screen.findByLabelText('Instructions');
  chooseOption(screen.getByLabelText('Repeat'), 'Every day');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Retry save' });
  const outside = `${disk().get(path)}\nOutside edit after body and metadata saved.\n`;
  disk().set(path, outside);
  fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
  await screen.findByTestId('library-stale');
  expect(disk().get(path)).toBe(outside);
  expect(unresolvedOpenPages()[0].latestDraft).toContain('daily 09:00');
});

it('retires an A→B→A save origin before any write and retains the same draft on reopen', async () => {
  const view = render(<LibraryPage />);
  fireEvent.change(await screen.findByLabelText('Instructions'), {
    target: { value: 'Keep in vault A' },
  });
  const read = ipc.readNoteSource;
  let release!: () => void;
  vi.spyOn(ipc, 'readNoteSource').mockImplementationOnce(async (...args) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return read(...args);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  act(() => useVaultStore.setState({ vaultPath: '/other' }));
  act(() => useVaultStore.setState({ vaultPath: '/vault' }));
  await act(async () => release());
  expect(disk().get(path)).toBe(original);
  view.unmount();
  render(<LibraryPage />);
  expect(await screen.findByLabelText('Instructions')).toHaveProperty('value', 'Keep in vault A');
  expect(unresolvedOpenPages()).toHaveLength(1);
});

it('retains template fill, type and body together and copies them without submitting a fill grant', async () => {
  const template = 'templates/retained.md';
  const bytes = '---\nfill: Original fill\n---\n\n# {{title}}\n';
  disk().set(template, bytes);
  await scan();
  useNavStore.setState({ selection: { kind: 'library', tab: 'template', path: template } });
  const view = render(<LibraryPage />);
  fireEvent.change(await screen.findByLabelText('Template body'), {
    target: { value: '# {{title}}\n\nDraft body' },
  });
  fireEvent.change(screen.getByLabelText('Fill prompt'), {
    target: { value: 'Unsubmitted fill permission' },
  });
  expect((await flushOpenPages()).unresolvedOwnerIds).toHaveLength(1);
  expect(disk().get(template)).toBe(bytes);
  view.unmount();
  render(<LibraryPage />);
  expect(await screen.findByLabelText('Fill prompt')).toHaveProperty(
    'value',
    'Unsubmitted fill permission',
  );
  let copied = '';
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Copy draft' }));
  await screen.findByRole('button', { name: 'Copied draft' });
  expect(JSON.parse(copied)).toEqual({
    name: '{{title}}',
    draft: {
      kind: 'template',
      value: { type: '', fill: 'Unsubmitted fill permission', body: '# {{title}}\n\nDraft body' },
    },
  });
  expect(unresolvedOpenPages()).toHaveLength(1);
  expect(disk().get(template)).toBe(bytes);
});

it('an acknowledged batch remains saved when its rescan fails', async () => {
  render(<LibraryPage />);
  fireEvent.change(await screen.findByLabelText('Instructions'), {
    target: { value: 'Written before refresh failed' },
  });
  act(() =>
    useVaultStore.setState({
      rescan: async () => {
        throw new Error('refresh unavailable');
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Saved' });
  expect(disk().get(path)).toContain('Written before refresh failed');
  expect(unresolvedOpenPages()).toHaveLength(0);
});

it('Save mine anyway reapplies a saved draft after a later outside edit, still with a checked batch', async () => {
  const activation = await import('@/agent/activation');
  const { chooseOption } = await import('@/test/chooseOption');
  vi.spyOn(activation, 'stampActivation').mockResolvedValueOnce(false).mockResolvedValue(true);
  render(<LibraryPage />);
  await screen.findByLabelText('Instructions');
  chooseOption(screen.getByLabelText('Repeat'), 'Every day');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Retry save' });
  disk().set(path, `${disk().get(path)}\nOutside text to explicitly replace.\n`);
  fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
  await screen.findByTestId('library-stale');
  fireEvent.click(screen.getByRole('button', { name: 'Save mine anyway' }));
  await screen.findByRole('button', { name: 'Saved' });
  expect(disk().get(path)).not.toContain('Outside text to explicitly replace.');
  expect(disk().get(path)).toContain('Original instructions.');
});

it('keeps distinct composite owners for the same file in two panes', async () => {
  const first = useNavStore.getState().active;
  useNavStore.getState().setPaneCapacity(4);
  const second = useNavStore.getState().openPane({ kind: 'home' }).pane;
  useNavStore.setState({ selection: { kind: 'library', tab: 'skill', path } });
  expect(second).not.toBe(first);
  const left = render(
    <PaneContext value={first}>
      <LibraryPage />
    </PaneContext>,
  );
  const right = render(
    <PaneContext value={second}>
      <LibraryPage />
    </PaneContext>,
  );
  fireEvent.change(await within(left.container).findByLabelText('Instructions'), {
    target: { value: 'Left private decision' },
  });
  fireEvent.change(await within(right.container).findByLabelText('Instructions'), {
    target: { value: 'Right private decision' },
  });
  expect(unresolvedOpenPages()).toHaveLength(2);
  left.unmount();
  right.unmount();
  const reopenedLeft = render(
    <PaneContext value={first}>
      <LibraryPage />
    </PaneContext>,
  );
  const reopenedRight = render(
    <PaneContext value={second}>
      <LibraryPage />
    </PaneContext>,
  );
  expect(await within(reopenedLeft.container).findByLabelText('Instructions')).toHaveProperty(
    'value',
    'Left private decision',
  );
  expect(await within(reopenedRight.container).findByLabelText('Instructions')).toHaveProperty(
    'value',
    'Right private decision',
  );
  expect(disk().get(path)).toBe(original);
});

it('reports a failed native clipboard recovery without discarding the composite draft', async () => {
  vi.spyOn(ipc, 'writeClipboard').mockRejectedValueOnce(new Error('Clipboard unavailable'));
  render(<LibraryPage />);
  fireEvent.change(await screen.findByLabelText('Instructions'), {
    target: { value: 'Still recoverable after Copy fails' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Copy draft' }));
  await screen.findByText("Couldn't copy. Your draft is retained.");
  expect(unresolvedOpenPages()[0].latestDraft).toContain('Still recoverable after Copy fails');
  expect(disk().get(path)).toBe(original);
});

it('loading a newer disk version cannot discard edits typed after the explicit load decision', async () => {
  render(<LibraryPage />);
  const instructions = await screen.findByLabelText('Instructions');
  fireEvent.change(instructions, { target: { value: 'Old unsaved draft' } });
  disk().set(path, `${original}\nOutside version.\n`);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByTestId('library-stale');
  const realRead = ipc.readNoteSource;
  let release!: () => void;
  vi.spyOn(ipc, 'readNoteSource').mockImplementationOnce(async (...args) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return realRead(...args);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Load the new version' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  fireEvent.change(instructions, { target: { value: 'New decision made during the read' } });
  await act(async () => release());
  expect(instructions).toHaveProperty('value', 'New decision made during the read');
  expect(unresolvedOpenPages()[0].latestDraft).toContain('New decision made during the read');
});

it.each([
  ['Retain', 'Renamed'],
  ['A later authored title', 'A later authored title'],
])(
  'keeps name/body decisions coherent across acknowledgement and Retry (%s)',
  async (typedHeading, finalHeading) => {
    const realBatch = ipc.applyBatch;
    let release!: () => void;
    vi.spyOn(ipc, 'applyBatch').mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return realBatch(...args);
    });
    render(<LibraryPage />);
    const body = await screen.findByLabelText('Instructions');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    fireEvent.change(body, {
      target: { value: `# ${typedHeading}\n\nNewer body while rename waits.\n` },
    });
    await act(async () => release());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false),
    );
    expect(disk().get(path)).toContain('# Renamed');
    expect(unresolvedOpenPages()[0].latestDraft).toContain('Newer body while rename waits.');
    vi.mocked(ipc.applyBatch).mockRejectedValueOnce(new Error('Retry this newer generation'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Retry save' });
    expect(disk().get(path)).toContain('# Renamed');
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect(disk().get(path)).toContain(`# ${finalHeading}\n\nNewer body while rename waits.\n`);
    expect(body).toHaveProperty('value', `# ${finalHeading}\n\nNewer body while rename waits.\n`);
    expect(screen.getByLabelText('Name')).toHaveProperty('value', finalHeading);
    expect(unresolvedOpenPages()).toHaveLength(0);
  },
);

it.each([
  { edits: [], finalName: 'Authored title', label: 'untouched Name' },
  { edits: ['Newer Name'], finalName: 'Newer Name', label: 'independently edited Name' },
  {
    edits: ['Temporary Name', 'Retain'],
    finalName: 'Retain',
    label: 'Name edited back to its old value',
  },
])('reconciles authored H1 acknowledgement with $label', async ({ edits, finalName }) => {
  const realBatch = ipc.applyBatch;
  let release!: () => void;
  vi.spyOn(ipc, 'applyBatch').mockImplementationOnce(async (...args) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return realBatch(...args);
  });
  render(<LibraryPage />);
  const body = await screen.findByLabelText('Instructions');
  const name = screen.getByLabelText('Name');
  fireEvent.change(body, { target: { value: '# Authored title\n\nFirst body.\n' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(release).toBeTypeOf('function'));
  const newerBody = '# Authored title\n\nNewer prose while saving.\n';
  fireEvent.change(body, { target: { value: newerBody } });
  for (const value of edits) fireEvent.change(name, { target: { value } });
  await act(async () => release());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false),
  );
  expect(disk().get(path)).toContain('# Authored title\n\nFirst body.\n');
  expect(body).toHaveProperty('value', newerBody);
  expect(name).toHaveProperty('value', finalName);
  expect(unresolvedOpenPages()).toHaveLength(1);
  expect(JSON.parse(unresolvedOpenPages()[0].latestDraft)).toMatchObject({
    name: finalName,
    draft: { value: { instructions: newerBody } },
  });
  vi.mocked(ipc.applyBatch).mockRejectedValueOnce(new Error('Retry newer authored title'));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Retry save' });
  expect(disk().get(path)).toContain('# Authored title\n\nFirst body.\n');
  expect(body).toHaveProperty('value', newerBody);
  expect(name).toHaveProperty('value', finalName);
  fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
  await screen.findByRole('button', { name: 'Saved' });
  const finalBody = `# ${finalName}\n\nNewer prose while saving.\n`;
  expect(disk().get(path)).toContain(finalBody);
  expect(body).toHaveProperty('value', finalBody);
  expect(name).toHaveProperty('value', finalName);
  expect(unresolvedOpenPages()).toHaveLength(0);
});

it('loads metadata and body from one checked version after an outside edit before opening', async () => {
  disk().set(
    path,
    original.replace('description: Original', 'description: Fresh outside description'),
  );
  render(<LibraryPage />);
  const body = await screen.findByLabelText('Instructions');
  expect(screen.getByLabelText('Description')).toHaveProperty('value', 'Fresh outside description');
  fireEvent.change(body, { target: { value: 'My body only' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Saved' });
  expect(disk().get(path)).toContain('description: Fresh outside description');
  expect(disk().get(path)).toContain('My body only');
});

it('Load new version rechecks metadata when the file changes between its scan and source read', async () => {
  render(<LibraryPage />);
  const body = await screen.findByLabelText('Instructions');
  fireEvent.change(body, { target: { value: 'Private draft before reload decision' } });
  disk().set(path, original.replace('description: Original', 'description: First outside version'));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByTestId('library-stale');
  let refreshes = 0;
  act(() =>
    useVaultStore.setState({
      rescan: async () => {
        await scan();
        if (++refreshes === 1)
          disk().set(
            path,
            original.replace('description: Original', 'description: Second outside version'),
          );
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Load the new version' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Description')).toHaveProperty('value', 'Second outside version'),
  );
  expect(body).toHaveProperty('value', '# Retain\n\nOriginal instructions.\n');
  fireEvent.change(body, { target: { value: 'Body after coherent reload' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Saved' });
  expect(disk().get(path)).toContain('description: Second outside version');
  expect(disk().get(path)).toContain('Body after coherent reload');
});

it('a continuously changing reload cannot discard the retained composite draft', async () => {
  render(<LibraryPage />);
  const body = await screen.findByLabelText('Instructions');
  fireEvent.change(body, { target: { value: 'Keep this when coherence cannot be established' } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Keep my name too' } });
  disk().set(path, `${original}\nOutside version 0\n`);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByTestId('library-stale');
  let revision = 0;
  act(() =>
    useVaultStore.setState({
      rescan: async () => {
        await scan();
        disk().set(path, `${original}\nOutside version ${++revision}\n`);
      },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Load the new version' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Load the new version' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
  expect(body).toHaveProperty('value', 'Keep this when coherence cannot be established');
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Keep my name too');
  expect(unresolvedOpenPages()[0].latestDraft).toContain(
    'Keep this when coherence cannot be established',
  );
  expect(disk().get(path)).not.toContain('Keep this when coherence cannot be established');
});
