// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FieldSaveParticipant } from '@/editor/fieldSaveParticipant';
import { __resetOpenPages, registerSaveParticipant, unresolvedOpenPages } from '@/editor/openPages';
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { applyPageTemplate } from './applyPageTemplate';

vi.mock('@/lib/ipc', { spy: true });
const VAULT = '/demo-vault';
const TARGET = 'notes/template-race-target.md';
const TEMPLATE = 'templates/template-race-source.md';
const BEFORE = '# Target\n\n';
const SOURCE = '---\nstatus_note: template value\n---\n# {{title}}\n\nScaffold.\n';
const DRAFT = 'Exact new property draft';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;

beforeEach(async () => {
  __resetOpenPages();
  vi.resetAllMocks();
  mock.resetMockFs();
  fs().set(TARGET, BEFORE);
  fs().set(TEMPLATE, SOURCE);
  await useVaultStore.getState().openVault(VAULT);
  useUiStore.setState({ toasts: [] });
  vi.clearAllMocks();
});
afterEach(() => {
  __resetOpenPages();
  vi.resetAllMocks();
});

it.each([
  [TARGET, 'failed'],
  [TEMPLATE, 'failed'],
  [TARGET, 'buffered'],
  [TEMPLATE, 'buffered'],
] as const)('refuses a new %s %s field during the final body barrier', async (path, state) => {
  const field = new FieldSaveParticipant(
    { vaultId: VAULT, path, ownerId: 'field:status_note' },
    'old',
    (text) => ({ ok: true, value: text }),
    async () => false,
  );
  let buffered: string | null = null;
  registerSaveParticipant({
    key: field.key,
    phase: field.phase,
    snapshot: field.snapshot,
    flush: field.flush,
    prepare: () => {
      if (buffered !== null) {
        field.edit(buffered);
        buffered = null;
      }
    },
  });
  let flushes = 0;
  registerSaveParticipant({
    key: { vaultId: VAULT, path: TARGET, ownerId: 'delayed-body' },
    prepare: () => {},
    snapshot: () => ({
      latestDraft: '',
      generation: 0,
      acknowledgedGeneration: 0,
      inFlightGeneration: null,
      failure: null,
    }),
    flush: async () => {
      if (++flushes === 2) {
        if (state === 'buffered') buffered = DRAFT;
        else {
          field.edit(DRAFT);
          await field.flush();
        }
      }
      return { kind: 'clean', ownerId: 'delayed-body', generation: 0 };
    },
  });

  expect(await applyPageTemplate(VAULT, TARGET, TEMPLATE)).toBe(false);
  expect(unresolvedOpenPages().some((item) => item.key.ownerId === field.key.ownerId)).toBe(true);
  expect(field.snapshot().latestDraft).toBe(DRAFT);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
  expect(fs().get(TARGET)).toBe(BEFORE);
  expect(fs().get(TEMPLATE)).toBe(SOURCE);
  expect(useUiStore.getState().toasts.some((item) => item.message.includes('changed'))).toBe(true);
});
