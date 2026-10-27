// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import { splitFrontmatter } from '@/engine/frontmatter';
import { sourceLocatorForWindow, sourceUtf8Length } from '@/engine/sourceLocation';
import { useVaultStore } from '@/stores/vaultStore';
import { useUndoStore } from '@/stores/undoStore';
import { useUiStore } from '@/stores/uiStore';
import { cerebroSchema, type CerebroEditor } from './MarkdownEditor';
import { markdownToBlocksNow } from './markdown';
import { DocumentOwner } from './documentOwner';
import { __resetOpenPages, registerSaveParticipant } from './openPages';
import { insertMentionLink, type MentionLinkRequest } from './mentionLink';
import bodyCases from '../../shared/knowledge/mention-link-body.v1.json';

vi.mock('@/lib/ipc', { spy: true });
const VAULT = '/demo-vault';
const PATH = 'notes/m97-source.md';
const TARGET = 'notes/m97-target.md';
const BEFORE =
  '---\nstatus_note: keep exactly\n---\n# Source\n\n😀 Neon Orchard first, then Neon Orchard second.\n\nUntouched line.\n';
const AFTER =
  '---\nstatus_note: keep exactly\n---\n# Source\n\n😀 Neon Orchard first, then [[m97-target|Neon Orchard]] second.\n\nUntouched line.\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

beforeEach(async () => {
  __resetOpenPages();
  vi.resetAllMocks();
  mock.resetMockFs();
  fs().set(PATH, BEFORE);
  fs().set(TARGET, '# Neon Orchard\n\nTarget body.\n');
  await useVaultStore.getState().openVault(VAULT);
  useUndoStore.getState().clear();
  useUiStore.setState({ toasts: [] });
  vi.clearAllMocks();
});
afterEach(() => {
  __resetOpenPages();
  vi.resetAllMocks();
});

async function request(): Promise<MentionLinkRequest> {
  const page = await ipc.findSourceOccurrences(VAULT, TARGET, 'mention', null);
  if (page.status !== 'ready') throw new Error('Expected a measured occurrence page');
  const occurrence = page.rows.filter((row) => row.location.path === PATH).at(-1);
  if (!occurrence) throw new Error('Expected the actual second raw occurrence');
  const editor = BlockNoteEditor.create({ schema: cerebroSchema }) as CerebroEditor;
  editor.replaceBlocks(
    editor.document,
    markdownToBlocksNow(editor, splitFrontmatter(fs().get(PATH)!).body),
  );
  return {
    vault: VAULT,
    locator: occurrence.location,
    targetPath: TARGET,
    targetHash: (await ipc.readNoteSource(VAULT, TARGET)).hash,
    editor,
    stillCurrent: () => true,
  };
}

it('links only the second raw UTF-8 occurrence through one checked body batch and one working app Undo', async () => {
  const input = await request();
  expect(await insertMentionLink(input)).toBe('applied');
  expect(fs().get(PATH)).toBe(AFTER);
  expect(fs().get(TARGET)).toBe('# Neon Orchard\n\nTarget body.\n');
  expect(ipc.applyBatch).toHaveBeenCalledExactlyOnceWith(VAULT, [
    {
      op: 'body',
      path: PATH,
      body: '# Source\n\n😀 Neon Orchard first, then [[m97-target|Neon Orchard]] second.\n\nUntouched line.\n',
      expectHash: input.locator.sourceHash,
    },
  ]);
  expect(ipc.saveNoteBody).not.toHaveBeenCalled();
  expect(useUndoStore.getState().past).toHaveLength(1);
  expect(await useUndoStore.getState().undo()).toBe(true);
  expect(fs().get(PATH)).toBe(BEFORE);
  expect(useUndoStore.getState().past).toHaveLength(0);
});

it('does not rebase a recorded locator when the native source resolver can relocate it', async () => {
  // Keep the changed heading outside the producer's bounded passage context.
  const before = BEFORE.replace(
    '# Source\n\n',
    '# Source\n\nThis unchanged introduction keeps the recorded passage context separate from the heading that will change outside Cerebro.\n\n',
  );
  fs().set(PATH, before);
  await useVaultStore.getState().rescan();
  const input = await request();
  const outside = before.replace('# Source', '# Renamed source');
  fs().set(PATH, outside);
  expect((await ipc.resolveSource(VAULT, input.locator)).status).toBe('relocated');
  expect(await insertMentionLink(input)).toBe('changed');
  expect(fs().get(PATH)).toBe(outside);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
  expect(useUndoStore.getState().past).toHaveLength(0);
});

it('lets the existing batch CAS preserve an external frontmatter edit after the fresh read', async () => {
  const input = await request();
  const outside = BEFORE.replace('keep exactly', 'changed outside');
  vi.mocked(ipc.applyBatch).mockImplementationOnce(async (vault, ops) => {
    fs().set(PATH, outside);
    return mock.applyBatch(vault, ops);
  });
  expect(await insertMentionLink(input)).not.toBe('applied');
  expect(ipc.applyBatch).toHaveBeenCalledOnce();
  expect(fs().get(PATH)).toBe(outside);
  expect(useUndoStore.getState().past).toHaveLength(0);
});

it.each(['cancel', 'vault round trip'] as const)(
  'writes nothing when preparation observes %s',
  async (reason) => {
    const input = await request();
    let current = true;
    input.stillCurrent = () => current;
    vi.mocked(ipc.readNoteSource).mockImplementation(async (vault, path) => {
      if (reason === 'cancel') current = false;
      else {
        useVaultStore.setState({ vaultPath: '/other' });
        useVaultStore.setState({ vaultPath: VAULT });
      }
      return mock.readNoteSource(vault, path);
    });
    expect(await insertMentionLink(input)).toBe('cancelled');
    expect(fs().get(PATH)).toBe(BEFORE);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
    expect(useUndoStore.getState().past).toHaveLength(0);
  },
);

it('preserves a newer retained editor draft authored while the source read waits', async () => {
  const input = await request();
  const owner = new DocumentOwner(
    { vaultId: VAULT, path: PATH, ownerId: 'mention-source' },
    splitFrontmatter(BEFORE).body,
    (body) => ipc.saveNoteBody({ vault: VAULT, path: PATH, body }),
  );
  registerSaveParticipant({
    key: owner.key,
    prepare: () => {},
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  const generation = owner.snapshot().generation;
  input.stillCurrent = () => owner.snapshot().generation === generation;
  vi.mocked(ipc.readNoteSource).mockImplementation(async (vault, path) => {
    if (path === PATH) owner.edit('# Source\n\nMy newer unsaved draft.\n');
    return mock.readNoteSource(vault, path);
  });
  expect(await insertMentionLink(input)).toBe('cancelled');
  expect(owner.snapshot().latestDraft).toBe('# Source\n\nMy newer unsaved draft.\n');
  expect(fs().get(PATH)).toBe(BEFORE);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
});

it('refuses a different editor document even when the native source bytes remain unchanged', async () => {
  const input = await request();
  vi.mocked(ipc.readNoteSource).mockImplementation(async (vault, path) => {
    if (path === PATH)
      input.editor.updateBlock(input.editor.document[1], { content: 'A newer local paragraph.' });
    return mock.readNoteSource(vault, path);
  });
  expect(await insertMentionLink(input)).toBe('changed');
  expect(fs().get(PATH)).toBe(BEFORE);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
});

it.each(['changed', 'deleted'] as const)('refuses a %s target identity', async (kind) => {
  const input = await request();
  if (kind === 'changed') fs().set(TARGET, '# A different target\n');
  else fs().delete(TARGET);
  expect(await insertMentionLink(input)).not.toBe('applied');
  expect(fs().get(PATH)).toBe(BEFORE);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
});

it('uses a resolvable title when another page owns the destination filename', async () => {
  const input = await request();
  fs().set('aaa/m97-target.md', '# Filename collision\n');
  await useVaultStore.getState().rescan();
  expect(await insertMentionLink(input)).toBe('applied');
  expect(fs().get(PATH)).toBe(
    '---\nstatus_note: keep exactly\n---\n# Source\n\n😀 Neon Orchard first, then [[Neon Orchard|Neon Orchard]] second.\n\nUntouched line.\n',
  );
});

it('keeps the source unchanged when every writable target name resolves to another page', async () => {
  const input = await request();
  fs().set('aaa/m97-target.md', '# Neon Orchard\n');
  await useVaultStore.getState().rescan();
  expect(await insertMentionLink(input)).not.toBe('applied');
  expect(fs().get(PATH)).toBe(BEFORE);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
});

it.each([
  ['BOM', '\ufeff' + BEFORE],
  ['CRLF', BEFORE.replaceAll('\n', '\r\n')],
  ['empty YAML', '---\n---\nBefore Neon Orchard after.\n'],
  ['spaced fence', '---\nstatus_note: keep\n--- \t\nBefore Neon Orchard after.\n'],
  ['code', '```text\nBefore Neon Orchard after.\n```\n'],
  ['marks', 'Before **Neon Orchard** after.\n'],
  ['whole paragraph', 'Neon Orchard\n'],
])('preserves every byte of unsupported %s source', async (_reason, content) => {
  fs().set(PATH, content);
  await useVaultStore.getState().rescan();
  const input = await request();
  expect(await insertMentionLink(input)).toBe('unsupported');
  expect(fs().get(PATH)).toBe(content);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
  expect(useUndoStore.getState().past).toHaveLength(0);
});

it.each(['Bad|Name', 'Bad[Name]', ' Neon Orchard '])(
  'refuses an alias the current wikilink carrier cannot preserve: %s',
  async (quote) => {
    const input = await request();
    const body = `Before ${quote} after.\n`;
    fs().set(PATH, body);
    await useVaultStore.getState().rescan();
    const source = await ipc.readNoteSource(VAULT, PATH);
    const start = sourceUtf8Length('Before ');
    const locator = sourceLocatorForWindow('demo', PATH, source.hash, body, {
      start,
      end: start + sourceUtf8Length(quote),
    });
    if (!locator) throw new Error('Expected a valid raw source locator');
    input.locator = locator;
    input.editor.replaceBlocks(input.editor.document, markdownToBlocksNow(input.editor, body));
    expect(await insertMentionLink(input)).toBe('unsupported');
    expect(fs().get(PATH)).toBe(body);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
  },
);

it.each(['mid-scalar', 'wrong quote'] as const)(
  'never guesses around a %s locator',
  async (kind) => {
    const input = await request();
    input.locator = {
      ...input.locator,
      ...(kind === 'wrong quote'
        ? { quote: 'Different words' }
        : { bodyUtf8Range: { start: 11, end: 14 } }),
    };
    expect(await insertMentionLink(input)).not.toBe('applied');
    expect(fs().get(PATH)).toBe(BEFORE);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
  },
);

it('keeps a protected source unchanged instead of borrowing the ordinary human batch door', async () => {
  const input = await request();
  const path = 'knowledge/m97-protected.md';
  const content = 'Before Neon Orchard after.\n';
  fs().set(path, content);
  await useVaultStore.getState().rescan();
  const source = await ipc.readNoteSource(VAULT, path);
  const locator = sourceLocatorForWindow('demo', path, source.hash, content, {
    start: 7,
    end: 19,
  });
  if (!locator) throw new Error('Expected a valid raw source locator');
  input.locator = locator;
  input.editor.replaceBlocks(input.editor.document, markdownToBlocksNow(input.editor, content));
  expect(await insertMentionLink(input)).not.toBe('applied');
  expect(fs().get(path)).toBe(content);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
});

it('does not use app Undo to overwrite a body edited after the link was saved', async () => {
  expect(await insertMentionLink(await request())).toBe('applied');
  const later = AFTER + '\nA later edit.\n';
  fs().set(PATH, later);
  expect(await useUndoStore.getState().undo()).toBe(false);
  expect(fs().get(PATH)).toBe(later);
});

it.each(bodyCases.cases)('replays the native body-preservation envelope: $id', async (test) => {
  const nativeEmpty = 'nativeEmptyMetadata' in test && test.nativeEmptyMetadata;
  const captured = nativeEmpty ? await request() : null;
  fs().set(PATH, test.source);
  await useVaultStore.getState().rescan();
  if (captured) {
    // Rust parse_frontmatter treats NEL-only YAML as an empty mapping.
    // The browser YAML package disagrees; supply that native entry DTO while
    // retaining the real raw-source resolver, editor map and batch adapter.
    // The shared native test independently asserts this metadata result.
    const source = await ipc.readNoteSource(VAULT, PATH);
    const body = splitFrontmatter(source.content).body;
    useVaultStore.setState({
      entries: useVaultStore.getState().entries.map((entry) =>
        entry.path === PATH
          ? {
              ...entry,
              hash: source.hash,
              parseError: null,
              type: null,
              properties: {},
              relationships: {},
            }
          : entry,
      ),
    });
    const locator = sourceLocatorForWindow('demo', PATH, source.hash, body, { start: 7, end: 19 });
    if (!locator) throw new Error('Expected the exact native empty-metadata body locator');
    captured.locator = locator;
    captured.editor.replaceBlocks(
      captured.editor.document,
      markdownToBlocksNow(captured.editor, body),
    );
    expect((await ipc.resolveSource(VAULT, captured.locator)).status).toBe('exact');
  }
  const result = await insertMentionLink(captured ?? (await request()));
  expect(result).toBe(test.admitted ? 'applied' : 'unsupported');
  expect(fs().get(PATH)).toBe(test.admitted ? test.nativeAfter : test.source);
  if (test.admitted) {
    expect(ipc.applyBatch).toHaveBeenCalledOnce();
    expect(vi.mocked(ipc.applyBatch).mock.calls[0][1]).toEqual([
      expect.objectContaining({ op: 'body', path: PATH, body: test.bodyAfter }),
    ]);
  } else expect(ipc.applyBatch).not.toHaveBeenCalled();
});
