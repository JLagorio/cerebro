// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useOpenPath } from './useOpenPath';

describe('useOpenPath .mmd routing (M29.21)', () => {
  beforeEach(() => {
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
    useVaultStore.setState({ entries: [] });
  });

  it('routes a .mmd to the diagram page', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('diagrams/pipeline.mmd'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'diagram',
      path: 'diagrams/pipeline.mmd',
    });
  });

  // The extension decides BEFORE the entry lookup: a just-created .mmd the
  // scanner has not adopted yet must never fall into the doc canvas, which
  // would edit raw mermaid as markdown.
  it('routes an unscanned .mmd to the diagram page too, never the doc canvas', () => {
    useVaultStore.setState({ entries: [] });
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('diagrams/brand-new.mmd'));
    expect(useNavStore.getState().selection).toEqual({
      kind: 'diagram',
      path: 'diagrams/brand-new.mmd',
    });
  });

  it('still routes an unknown .md to the doc canvas', () => {
    const { result } = renderHook(() => useOpenPath());
    act(() => result.current('notes/loose.md'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'notes/loose.md' });
  });
});
