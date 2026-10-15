import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetDraftsInMemory, loadDraft, pruneDrafts, saveDraft } from './drafts';

/** The composer's draft is per thread and survives the panel (M57.6). */
describe('drafts', () => {
  beforeEach(() => {
    window.localStorage.clear();
    forgetDraftsInMemory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps one draft per thread, through a reload', () => {
    saveDraft('c-1', 'half a question');
    saveDraft('c-2', 'another');
    forgetDraftsInMemory();
    expect(loadDraft('c-1')).toBe('half a question');
    expect(loadDraft('c-2')).toBe('another');
    expect(loadDraft('c-3')).toBe('');
  });

  it('clears a thread’s draft when it is sent', () => {
    saveDraft('c-1', 'send me');
    saveDraft('c-1', '');
    forgetDraftsInMemory();
    expect(loadDraft('c-1')).toBe('');
    expect(window.localStorage.getItem('cerebro.composerDrafts')).toBe('{}');
  });

  it('prunes to the threads that still exist', () => {
    saveDraft('c-1', 'kept');
    saveDraft('gone', 'dropped');
    pruneDrafts(['c-1']);
    forgetDraftsInMemory();
    expect(loadDraft('c-1')).toBe('kept');
    expect(loadDraft('gone')).toBe('');
  });

  it('keeps the memory copy when storage fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    saveDraft('c-1', 'still here');
    expect(loadDraft('c-1')).toBe('still here');
  });
});
