import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { calculateSheets } from '@/lib/ipc';
import { resetSheetCache, useSheetWorkbook } from './useSheetWorkbook';
import type { SheetResult } from '@/engine/sheet/fence';

vi.mock('@/lib/ipc', () => ({ calculateSheets: vi.fn() }));
const ready = (name = 'Sheet1', display = '2'): SheetResult => ({
  ok: true,
  name,
  rows: 1,
  cols: 1,
  cells: [{ row: 1, col: 1, kind: 'number', display }],
});
beforeEach(() => {
  resetSheetCache();
  vi.mocked(calculateSheets).mockReset().mockResolvedValue([ready()]);
});

describe('one workbook per source request', () => {
  it('treats an incomplete reply as unavailable and does not cache it', async () => {
    vi.mocked(calculateSheets).mockResolvedValueOnce([]);
    const hook = renderHook(() => useSheetWorkbook(['2']));
    await waitFor(() =>
      expect(hook.result.current[0]).toMatchObject({ status: 'unavailable', reason: 'engine' }),
    );
    hook.unmount();
    const next = renderHook(() => useSheetWorkbook(['2']));
    await waitFor(() => expect(next.result.current[0].status).toBe('ready'));
    expect(calculateSheets).toHaveBeenCalledTimes(2);
  });
  it('deduplicates two callers and never calls the engine for no fences', async () => {
    const first = renderHook(() => useSheetWorkbook(['=1+1']));
    const second = renderHook(() => useSheetWorkbook(['=1+1']));
    renderHook(() => useSheetWorkbook([]));
    expect(first.result.current[0].status).toBe('pending');
    await waitFor(() => expect(second.result.current[0].status).toBe('ready'));
    expect(first.result.current[0].status).toBe('ready');
    expect(calculateSheets).toHaveBeenCalledOnce();
    expect(calculateSheets).toHaveBeenCalledWith([
      { name: 'Sheet1', cells: [{ row: 1, col: 1, source: '=1+1' }] },
    ]);
  });
  it('never sends a bad or unclosed fence and preserves all page ordinals', async () => {
    vi.mocked(calculateSheets).mockResolvedValue([ready('Sheet2')]);
    const hook = renderHook(() => useSheetWorkbook(['---\nformat: 2\n---\na', '2', '3'], [2]));
    await waitFor(() => expect(hook.result.current[1].status).toBe('ready'));
    expect(hook.result.current[0]).toMatchObject({
      status: 'unavailable',
      reason: 'fence',
      name: 'Sheet1',
    });
    expect(hook.result.current[2]).toMatchObject({
      status: 'unavailable',
      message: 'This sheet block has no closing fence.',
    });
    expect(calculateSheets).toHaveBeenCalledWith([
      { name: 'Sheet2', cells: [{ row: 1, col: 1, source: '2' }] },
    ]);
  });
  it('shows the engine rejection and retries a rejected request after a source change', async () => {
    vi.mocked(calculateSheets).mockRejectedValueOnce(new Error('engine unavailable'));
    const hook = renderHook(({ sources }) => useSheetWorkbook(sources), {
      initialProps: { sources: ['2'] },
    });
    await waitFor(() =>
      expect(hook.result.current[0]).toMatchObject({
        status: 'unavailable',
        reason: 'engine',
        message: 'engine unavailable',
      }),
    );
    hook.rerender({ sources: [] });
    hook.rerender({ sources: ['2'] });
    await waitFor(() => expect(hook.result.current[0].status).toBe('ready'));
    expect(calculateSheets).toHaveBeenCalledTimes(2);
  });
  it('keeps name and size failures with the exact backend words', async () => {
    vi.mocked(calculateSheets).mockResolvedValue([
      { ok: false, name: 'Bad', problem: 'name_invalid', message: 'name refusal' },
      { ok: false, name: 'Big', problem: 'too_large', message: 'size refusal' },
    ]);
    const hook = renderHook(() =>
      useSheetWorkbook(['---\nname: Bad\n---\n1', '---\nname: Big\n---\n2']),
    );
    await waitFor(() =>
      expect(hook.result.current).toEqual([
        { status: 'unavailable', name: 'Bad', reason: 'name', message: 'name refusal' },
        { status: 'unavailable', name: 'Big', reason: 'too-large', message: 'size refusal' },
      ]),
    );
  });
  it('never shows old values while a replacement request is pending or after it settles', async () => {
    let settle: (results: SheetResult[]) => void = () => {};
    vi.mocked(calculateSheets).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const hook = renderHook(({ source }) => useSheetWorkbook([source]), {
      initialProps: { source: 'old' },
    });
    await waitFor(() => expect(calculateSheets).toHaveBeenCalledOnce());
    hook.rerender({ source: 'new' });
    expect(hook.result.current[0].status).toBe('pending');
    await waitFor(() =>
      expect(hook.result.current[0]).toMatchObject({
        status: 'ready',
        sheet: { cells: [{ display: '2' }] },
      }),
    );
    await act(async () => settle([ready('Sheet1', 'old')]));
    expect(hook.result.current[0]).toMatchObject({
      status: 'ready',
      sheet: { cells: [{ display: '2' }] },
    });
  });
  it('evicts the least recently used request after sixteen workbooks', async () => {
    const hook = renderHook(({ source }) => useSheetWorkbook([source]), {
      initialProps: { source: '0' },
    });
    for (let index = 0; index < 17; index++) {
      hook.rerender({ source: String(index) });
      await waitFor(() => expect(hook.result.current[0].status).toBe('ready'));
    }
    hook.rerender({ source: '0' });
    await waitFor(() => expect(hook.result.current[0].status).toBe('ready'));
    expect(calculateSheets).toHaveBeenCalledTimes(18);
  });
});
