import { renderHook, act } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DocumentOwner } from './documentOwner';
import { createRecoveryCapture, RecoveryBufferContext, useRecoveryBuffer } from './recoveryBuffers';
it('captures exact raw child text synchronously and binds old callbacks to the retired owner instance', () => {
  const old = new DocumentOwner({ vaultId: '/vault', path: 'a.md', ownerId: 'pane' }, '', vi.fn());
  const next = new DocumentOwner(old.key, '', vi.fn());
  const capture = createRecoveryCapture();
  capture.bind(old);
  const hook = renderHook(() => useRecoveryBuffer('diagram-code'), {
    wrapper: ({ children }) => (
      <RecoveryBufferContext.Provider value={capture}>{children}</RecoveryBufferContext.Provider>
    ),
  });
  act(() => hook.result.current.set('graph TD\r\n  [invalid 😀', 'graph TD\r\n  A-->B'));
  const text = Object.values(old.snapshot().childDrafts!)[0];
  expect(JSON.parse(text)).toEqual({
    kind: 'diagram-code',
    source: 'graph TD\r\n  A-->B',
    text: 'graph TD\r\n  [invalid 😀',
  });
  hook.unmount();
  expect(Object.values(old.snapshot().childDrafts!)).toEqual([text]);
  expect(old.retireRecovery()).toBe(true);
  capture.bind(next);
  capture.set('late-child', 'late callback');
  expect(next.snapshot().childDrafts).toEqual({});
  expect(old.snapshot().childDrafts).toEqual({});
});
it('detaches an old presentation without dropping its bytes or applying callbacks to the reused owner', () => {
  const owner = new DocumentOwner(
    { vaultId: '/vault', path: 'same.md', ownerId: 'pane' },
    'new accepted body',
    vi.fn(),
  );
  const capture = createRecoveryCapture();
  capture.bind(owner);
  capture.set('diagram-code:old', 'exact old buffer');
  capture.detach();
  const apply = vi.fn(() => owner.edit('stale presentation'));
  capture.commit('diagram-code:old', apply);
  capture.set('diagram-code:old', null);
  expect(apply).not.toHaveBeenCalled();
  expect(owner.snapshot().latestDraft).toBe('new accepted body');
  expect(owner.snapshot().childDrafts?.['diagram-code:old']).toBe('exact old buffer');
  const replacement = createRecoveryCapture();
  replacement.bind(owner);
  replacement.set('diagram-code:new', 'new buffer');
  expect(owner.snapshot().childDrafts).toEqual({
    'diagram-code:old': 'exact old buffer',
    'diagram-code:new': 'new buffer',
  });
});
