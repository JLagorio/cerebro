import { finishSourceRequest } from '@/app/sourceOpen';
// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RecordPageProperties } from '@/detail/RecordPageProperties';
import { InspectorSection } from '@/detail/InspectorSection';
import { useUiStore } from '@/stores/uiStore';
import { DocProperties } from '@/detail/DocProperties';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { useSourceNavigation, sourceVisitOrigin, sourceRequestFor } from '@/app/sourceOpen';
import type { SourceLocator } from '@/engine/sourceLocation';
const ipc = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  resolveSource: ipc.resolve,
  readNoteSource: ipc.read,
}));
const hash = 'a'.repeat(64);
const locator: SourceLocator = {
  version: 1,
  vaultId: 'registered',
  path: 'source.md',
  sourceHash: hash,
  kind: 'property',
  propertyKey: 'tags',
  quote: 'One',
  prefix: '',
  suffix: ', Two',
};
beforeEach(() => {
  useNavStore.getState().reset();
  ipc.resolve
    .mockReset()
    .mockImplementation(async (_vault, locator) => ({ status: 'exact', locator }));
  ipc.read.mockReset().mockResolvedValue({ hash, content: 'unused' });
});
afterEach(cleanup);
it('reveals a saved-hidden array row without editing or changing saved visibility', async () => {
  const type = makeEntry({
    path: 'types/example.md',
    title: 'Example',
    type: 'Type',
  });
  (type.properties as Record<string, unknown>).fields = {
    tags: { kind: 'text', visibility: 'hide' },
  };
  const entry = makeEntry({
    path: 'source.md',
    type: 'Example',
    hash,
    properties: { tags: ['One', 'Two'] },
  });
  const entries = [type, entry];
  useVaultStore.setState({ vaultPath: '/vault', entries });
  const schema = buildSchema(entries);
  const before = JSON.stringify(entries);
  const { container } = render(<RecordPageProperties entry={entry} schema={schema} />);
  expect(container.querySelector('[data-property="tags"]')).toBeNull();
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({
      requestId: 'array',
      locator,
      origin: sourceVisitOrigin(locator.vaultId),
      intent: 'full_page',
    });
  });
  await waitFor(() =>
    expect((document.activeElement as HTMLElement).dataset.property).toBe('tags'),
  );
  expect(container.querySelector('[data-property="tags"]')?.textContent).toContain('One');
  expect(JSON.stringify(entries)).toBe(before);
  expect(document.activeElement?.tagName).toBe('DIV');
});
it('reveals an undeclared relation row without inventing a flattened member', async () => {
  const entry = makeEntry({
    path: 'source.md',
    type: null,
    hash,
    relationships: { links: ['One', 'Two'] },
  });
  useVaultStore.setState({ vaultPath: '/vault', entries: [entry] });
  const { container } = render(<DocProperties entry={entry} schema={buildSchema([entry])} />);
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({
      requestId: 'relation',
      locator: { ...locator, propertyKey: 'links' },
      origin: sourceVisitOrigin(locator.vaultId),
      intent: 'full_page',
    });
  });
  await waitFor(() =>
    expect((document.activeElement as HTMLElement).dataset.property).toBe('links'),
  );
  expect(container.querySelector('[data-property="links"]')?.textContent).toContain('One, Two');
});
it.each(['missing key', 'renamed key', 'changed value'])(
  '%s reports changed and does not focus another row',
  async (reason) => {
    const entry = makeEntry({ path: 'source.md', type: null, hash, properties: { other: 'One' } });
    useVaultStore.setState({ vaultPath: '/vault', entries: [entry] });
    render(<DocProperties entry={entry} schema={buildSchema([entry])} />);
    ipc.resolve.mockResolvedValue({ status: 'changed', path: 'source.md', reason });
    const { result } = renderHook(useSourceNavigation);
    await act(async () => {
      await result.current.openSource({
        requestId: 'changed',
        locator,
        origin: sourceVisitOrigin(locator.vaultId),
        intent: 'full_page',
      });
    });
    await waitFor(() =>
      expect(sourceRequestFor('source.md', useNavStore.getState().active)?.status).toBe('changed'),
    );
    expect((document.activeElement as HTMLElement).dataset.property).toBeUndefined();
  },
);

it('temporarily opens a folded Properties section and restores its saved fold on return', async () => {
  const entry = makeEntry({
    path: 'source.md',
    type: null,
    hash,
    properties: { tags: ['One', 'Two'] },
  });
  useVaultStore.setState({ vaultPath: '/vault', entries: [entry] });
  useUiStore.setState({ inspectorCollapsed: ['properties'], inspectorExpanded: [] });
  const { container } = render(
    <InspectorSection id="properties" label="Properties" sourcePath={entry.path}>
      <DocProperties entry={entry} schema={buildSchema([entry])} />
    </InspectorSection>,
  );
  expect(container.querySelector('[data-section="properties"]')?.getAttribute('data-open')).toBe(
    'false',
  );
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({
      requestId: 'fold',
      locator,
      origin: sourceVisitOrigin(locator.vaultId),
      intent: 'full_page',
    });
  });
  await waitFor(() =>
    expect((document.activeElement as HTMLElement).dataset.property).toBe('tags'),
  );
  expect(container.querySelector('[data-section="properties"]')?.getAttribute('data-open')).toBe(
    'true',
  );
  expect(useUiStore.getState().inspectorCollapsed).toEqual(['properties']);
  await act(async () => {
    expect(await result.current.returnToSourceOrigin('fold')).toBe('restored');
  });
  expect(container.querySelector('[data-section="properties"]')?.getAttribute('data-open')).toBe(
    'false',
  );
  expect(useUiStore.getState().inspectorCollapsed).toEqual(['properties']);
});

it('cancelled property reveal restores the saved fold', async () => {
  const entry = makeEntry({
    path: 'source.md',
    type: null,
    hash,
    properties: { tags: ['One', 'Two'] },
  });
  useVaultStore.setState({ vaultPath: '/vault', entries: [entry] });
  useUiStore.setState({ inspectorCollapsed: ['properties'], inspectorExpanded: [] });
  const { container } = render(
    <InspectorSection id="properties" label="Properties" sourcePath={entry.path}>
      <DocProperties entry={entry} schema={buildSchema([entry])} />
    </InspectorSection>,
  );
  const { result } = renderHook(useSourceNavigation);
  await act(async () => {
    await result.current.openSource({
      requestId: 'cancel',
      locator,
      origin: sourceVisitOrigin(locator.vaultId),
      intent: 'full_page',
    });
    finishSourceRequest('source.md', useNavStore.getState().active, 'cancel', 'cancelled');
  });
  expect(container.querySelector('[data-section="properties"]')?.getAttribute('data-open')).toBe(
    'false',
  );
  expect(useUiStore.getState().inspectorCollapsed).toEqual(['properties']);
});
