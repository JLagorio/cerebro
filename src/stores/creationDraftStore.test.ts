import { beforeEach, describe, expect, it } from 'vitest';
import type { CreationContext } from '@/engine/creationDestination';
import {
  beginCreationSubmission,
  claimCreationDraft,
  clearCreationDraftsForVault,
  discardCreationDraft,
  moveCreationDraft,
  readCreationDraft,
  readCreationSubmission,
  releaseCreationDraft,
  saveCreationDraft,
  settleCreationSubmission,
  type CreationDraft,
} from './creationDraftStore';

const context: CreationContext = {
  vault: '/draft-tests',
  pane: 'p1',
  destination: { kind: 'page', folder: '', recipe: { kind: 'blank' } },
};
const sheet: CreationContext = {
  ...context,
  destination: { kind: 'page', folder: '', recipe: { kind: 'sheet', sheetName: 'Sheet1' } },
};
const draft = (revision = 1): CreationDraft => ({
  context,
  revision,
  title: '  Keep exact  ',
  values: { tags: ['a', 'b'], count: 0 },
  createMore: false,
  fieldErrors: { count: 'Needs attention' },
  formError: 'Try again',
});
beforeEach(() => {
  clearCreationDraftsForVault(context.vault);
  clearCreationDraftsForVault('/other-draft-tests');
});

describe('creation draft owner', () => {
  it('preserves immutable exact snapshots and refuses stale save/discard', () => {
    const input = draft();
    saveCreationDraft(input);
    input.title = 'mutated';
    (input.values.tags as string[]).push('mutated');
    expect(readCreationDraft(context)?.title).toBe('  Keep exact  ');
    expect(readCreationDraft(context)?.values.tags).toEqual(['a', 'b']);
    saveCreationDraft({ ...draft(2), title: 'new' });
    saveCreationDraft(draft(1));
    expect(discardCreationDraft(context, 1)).toBe(false);
    expect(readCreationDraft(context)?.title).toBe('new');
  });

  it('permits one matching claim and releases only its owner', () => {
    expect(claimCreationDraft(context, 'one')).toBe(true);
    expect(claimCreationDraft({ ...context, pane: 'p2' }, 'two')).toBe(false);
    releaseCreationDraft(context, 'two');
    expect(claimCreationDraft(context, 'two')).toBe(false);
    releaseCreationDraft(context, 'one');
    expect(claimCreationDraft(context, 'two')).toBe(true);
  });

  it('never resumes or clears a plain-page draft as a sheet', () => {
    saveCreationDraft(draft());
    saveCreationDraft({ ...draft(), context: sheet, title: 'Sheet' });
    expect(readCreationDraft(context)?.title).toBe('  Keep exact  ');
    expect(readCreationDraft(sheet)?.title).toBe('Sheet');
    expect(discardCreationDraft(sheet, 1)).toBe(true);
    expect(readCreationDraft(context)?.title).toBe('  Keep exact  ');
  });

  it('refuses occupied destinations without erasing either draft', () => {
    saveCreationDraft(draft());
    saveCreationDraft({ ...draft(), context: sheet, title: 'Sheet' });
    expect(moveCreationDraft(context, sheet, 1)).toBe(false);
    expect(readCreationDraft(context)).not.toBeNull();
    expect(readCreationDraft(sheet)?.title).toBe('Sheet');
  });

  it('freezes one submission across close, newer edits and repeated submit', () => {
    saveCreationDraft(draft());
    const first = beginCreationSubmission(context, 1);
    expect(first.kind).toBe('started');
    if (first.kind === 'stale') throw new Error('missing submission');
    saveCreationDraft({ ...draft(2), title: 'newer' });
    const repeated = beginCreationSubmission(context, 2);
    expect(repeated.kind).toBe('pending');
    if (repeated.kind === 'stale') throw new Error('missing pending submission');
    expect(repeated.submission.id).toBe(first.submission.id);
    expect(repeated.submission.snapshot.title).toBe('  Keep exact  ');
    expect(discardCreationDraft(context, 2)).toBe(false);
    expect(moveCreationDraft(context, sheet, 2)).toBe(false);
    settleCreationSubmission(first.submission.id, { kind: 'succeeded', path: 'created.md' });
    expect(readCreationDraft(context)?.title).toBe('newer');
    settleCreationSubmission(first.submission.id, { kind: 'failed', error: 'late failure' });
    expect(readCreationSubmission(context)?.state).toBe('succeeded');
  });

  it('keeps delayed failure on the submitted revision without overwriting newer input', () => {
    saveCreationDraft(draft());
    const first = beginCreationSubmission(context, 1);
    if (first.kind === 'stale') throw new Error('missing submission');
    saveCreationDraft({ ...draft(2), title: 'newer', formError: null });
    settleCreationSubmission(first.submission.id, { kind: 'failed', error: 'denied' });
    expect(readCreationDraft(context)?.formError).toBeNull();
    expect(readCreationSubmission(context)?.error).toBe('denied');
  });

  it('keeps a pending submission through explicit vault clear without resurrecting its draft', () => {
    saveCreationDraft(draft());
    const first = beginCreationSubmission(context, 1);
    if (first.kind === 'stale') throw new Error('missing submission');
    saveCreationDraft({ ...draft(), context: { ...context, vault: '/other-draft-tests' } });
    clearCreationDraftsForVault(context.vault);
    expect(readCreationDraft(context)).toBeNull();
    expect(readCreationSubmission(context)?.state).toBe('pending');
    settleCreationSubmission(first.submission.id, { kind: 'failed', error: 'denied' });
    expect(readCreationDraft(context)).toBeNull();
    expect(readCreationDraft({ ...context, vault: '/other-draft-tests' })).not.toBeNull();
  });

  it('isolates pending operations by recipe and acknowledges only the original revision', () => {
    saveCreationDraft(draft());
    saveCreationDraft({ ...draft(), context: sheet, title: 'Sheet' });
    const plain = beginCreationSubmission(context, 1);
    const workbook = beginCreationSubmission(sheet, 1);
    if (plain.kind === 'stale' || workbook.kind === 'stale') throw new Error('missing submission');
    expect(plain.submission.id).not.toBe(workbook.submission.id);
    settleCreationSubmission(plain.submission.id, { kind: 'succeeded', path: 'plain.md' });
    expect(readCreationDraft(context)).toBeNull();
    expect(readCreationDraft(sheet)?.title).toBe('Sheet');
    settleCreationSubmission(workbook.submission.id, { kind: 'failed', error: 'sheet refused' });
    expect(readCreationDraft(sheet)?.formError).toBe('sheet refused');
  });
});
