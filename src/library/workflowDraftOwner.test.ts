import { expect, it, vi } from 'vitest';
import { SaveParticipants } from '@/editor/saveParticipants';
import { workflowSave } from '@/lib/ipc';
import type { WorkflowDraftSnapshot } from '@/lib/generated/workflows';
import {
  retainWorkflowDraft,
  retainedWorkflowDrafts,
  findRetainedWorkflowDraft,
} from './workflowDraftOwner';
import editorPolicy from '../../shared/workflows/editor.v1.json';
import type { WorkflowDraft } from '@/lib/generated/workflows';
vi.mock('@/lib/ipc', () => ({
  workflowSave: vi.fn(),
  workflowPublish: vi.fn(),
  workflowUnpublish: vi.fn(),
  workflowDocument: vi.fn(),
  workflowValidate: vi.fn(),
}));
const context = { vaultId: 'a'.repeat(32), storeUuid: 'original' };
const draft = (id: string): WorkflowDraft => ({
  workflowId: id,
  entryStepId: 'done',
  inputSchemaJson: '{}',
  triggerJson: '{"kind":"manual"}',
  steps: [],
});
it('refuses another retained editor at the shared cap without evicting unresolved owners', () => {
  const retained: NonNullable<ReturnType<typeof retainWorkflowDraft>>[] = [];
  try {
    for (let n = 0; n < editorPolicy.maxRetainedSessions; n++) {
      const owner = retainWorkflowDraft('/vault', context, draft('draft_' + n), null, null);
      expect(owner).not.toBeNull();
      retained.push(owner!);
    }
    const overflow = retainWorkflowDraft('/vault', context, draft('overflow'), null, null);
    if (overflow !== null) retained.push(overflow);
    expect(overflow).toBeNull();
    expect(retainWorkflowDraft('/vault', context, draft('draft_0'), null, null)).toBe(retained[0]);
    expect(retained[0]!.participant.retention?.held()).toBe(true);
  } finally {
    for (const owner of retained) owner.participant.retention?.release();
  }
});
it('an existing dirty owner keeps its local draft and participant across editor remount', () => {
  const owner = retainWorkflowDraft('/vault', context, draft('same'), null, null)!;
  try {
    const edited = draft('same');
    edited.entryStepId = 'local-edit';
    owner.session.edit(edited);
    const again = retainWorkflowDraft('/vault', context, draft('same'), null, null);
    expect(again).toBe(owner);
    expect(again?.session.getSnapshot().draft.entryStepId).toBe('local-edit');
    expect(again?.participant.snapshot().latestDraft).toContain('local-edit');
    expect(again?.participant.blocked?.()).toBe('choice');
  } finally {
    owner.participant.retention?.release();
  }
});

it('releases a clean unmounted owner without depending on SaveParticipants calling retention.release', async () => {
  const registry = new SaveParticipants();
  const saved = { draft: draft('clean'), etag: 'b'.repeat(64) };
  const owner = retainWorkflowDraft('/vault', context, saved.draft, saved, null)!;
  let again: ReturnType<typeof retainWorkflowDraft> = null;
  try {
    const unmount = owner.mount();
    const detach = registry.register(owner.participant);
    detach();
    unmount();
    expect(registry.get(owner.participant.key)).toBeUndefined();
    await Promise.resolve();
    again = retainWorkflowDraft('/vault', context, saved.draft, saved, null);
    expect(again).not.toBeNull();
    expect(again).not.toBe(owner);
  } finally {
    registry.clear();
    owner.participant.retention?.release();
    again?.participant.retention?.release();
  }
});
it('retains a pending unmounted save then releases its owner only after actual clean acknowledgement', async () => {
  const registry = new SaveParticipants();
  let resolve!: (value: WorkflowDraftSnapshot) => void;
  const pending = new Promise<WorkflowDraftSnapshot>((yes) => {
    resolve = yes;
  });
  vi.mocked(workflowSave).mockReturnValueOnce(pending);
  const owner = retainWorkflowDraft('/vault', context, draft('late-save'), null, null)!;
  let again: ReturnType<typeof retainWorkflowDraft> = null;
  try {
    const unmount = owner.mount();
    const detach = registry.register(owner.participant);
    const work = owner.session.save();
    detach();
    unmount();
    expect(registry.get(owner.participant.key)).toBe(owner.participant);
    expect(retainWorkflowDraft('/vault', context, draft('late-save'), null, null)).toBe(owner);
    resolve({ draft: draft('late-save'), etag: 'c'.repeat(64) });
    await work;
    await registry.flush();
    expect(registry.get(owner.participant.key)).toBeUndefined();
    again = retainWorkflowDraft(
      '/vault',
      context,
      draft('late-save'),
      { draft: draft('late-save'), etag: 'c'.repeat(64) },
      null,
    );
    expect(again).not.toBeNull();
    expect(again).not.toBe(owner);
  } finally {
    resolve({ draft: draft('late-save'), etag: 'c'.repeat(64) });
    registry.clear();
    owner.participant.retention?.release();
    again?.participant.retention?.release();
  }
});

it('cancels clean release during immediate effect remount and cannot delete a successor owner', async () => {
  const saved = { draft: draft('effect-replay'), etag: 'd'.repeat(64) };
  const owner = retainWorkflowDraft('/vault', context, saved.draft, saved, null)!;
  let successor: ReturnType<typeof retainWorkflowDraft> = null;
  try {
    const first = owner.mount();
    first();
    const second = owner.mount();
    await Promise.resolve();
    expect(retainWorkflowDraft('/vault', context, saved.draft, saved, null)).toBe(owner);
    second();
    await Promise.resolve();
    successor = retainWorkflowDraft('/vault', context, saved.draft, saved, null);
    expect(successor).not.toBeNull();
    expect(successor).not.toBe(owner);
    owner.participant.retention?.release();
    expect(retainWorkflowDraft('/vault', context, saved.draft, saved, null)).toBe(successor);
  } finally {
    owner.participant.retention?.release();
    successor?.participant.retention?.release();
  }
});

it('never replaces an original retained editor service with a different display or native source', () => {
  const first = {
    save: vi.fn(async () => ({ draft: draft('source'), etag: 'e'.repeat(64) })),
    publish: vi.fn(async () => {
      throw new Error('unused');
    }),
    document: vi.fn(async () => {
      throw new Error('unused');
    }),
    validate: vi.fn(async () => ({ valid: true, diagnostics: [] })),
  };
  const second = { ...first };
  const owner = retainWorkflowDraft('/vault', context, draft('source'), null, null, first)!;
  try {
    expect(retainWorkflowDraft('/vault', context, draft('source'), null, null, second)).toBeNull();
    expect(retainWorkflowDraft('/vault', context, draft('source'), null, null, first)).toBe(owner);
  } finally {
    owner.participant.retention?.release();
  }
});

it('lists and resumes only exact original vault context and service without exposing draft bodies', () => {
  const original = {
    save: vi.fn(async () => ({ draft: draft('local-only'), etag: 'f'.repeat(64) })),
    publish: vi.fn(async () => {
      throw new Error('unused');
    }),
    document: vi.fn(async () => {
      throw new Error('no native file');
    }),
    validate: vi.fn(async () => ({ valid: false, diagnostics: [] })),
  };
  const other = { ...original };
  const owner = retainWorkflowDraft('/vault', context, draft('local-only'), null, null, original)!;
  try {
    expect(retainedWorkflowDrafts('/vault', context, original)).toEqual([
      { workflowId: 'local-only', dirty: true, phase: 'idle' },
    ]);
    expect(findRetainedWorkflowDraft('/vault', context, 'local-only', original)).toBe(owner);
    expect(retainedWorkflowDrafts('/other', context, original)).toEqual([]);
    expect(
      retainedWorkflowDrafts('/vault', { ...context, storeUuid: 'replacement' }, original),
    ).toEqual([]);
    expect(retainedWorkflowDrafts('/vault', context, other)).toEqual([]);
    expect(findRetainedWorkflowDraft('/vault', context, 'local-only', other)).toBeNull();
  } finally {
    owner.participant.retention?.release();
  }
});

it('never reuses an editor owner for a different original vault path', () => {
  const original = retainWorkflowDraft('/original', context, draft('vault-bound'), null, null)!;
  let foreign: ReturnType<typeof retainWorkflowDraft> = null;
  try {
    foreign = retainWorkflowDraft('/different', context, draft('vault-bound'), null, null);
    expect(foreign).not.toBe(original);
    expect(original.participant.key.vaultId).toBe('/original');
    if (foreign !== null) expect(foreign.participant.key.vaultId).toBe('/different');
  } finally {
    original.participant.retention?.release();
    foreign?.participant.retention?.release();
  }
});
