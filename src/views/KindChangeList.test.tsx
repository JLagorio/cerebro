import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { neverReason } from '@/engine/castRules';
import type { Entry } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { KindChangeList } from '@/views/KindChangeList';

const betDoc = makeEntry({
  path: 'types/bet.md',
  title: 'Bet',
  type: 'Type',
  properties: { fields: { stake: { kind: 'text' } } } as unknown as Entry['properties'],
});
const bet = (n: number, stake: string) =>
  makeEntry({
    path: `records/bets/bet-${n}.md`,
    title: `Bet ${n}`,
    type: 'Bet',
    properties: { stake } as Entry['properties'],
  });

beforeEach(() => {
  useVaultStore.setState({
    entries: [betDoc, bet(1, '12'), bet(2, 'abc'), bet(3, 'n/a'), bet(4, 'TBD')],
    views: [],
  });
});
afterEach(cleanup);

const stake = { name: 'stake', kind: 'text' } as const;

describe('KindChangeList (M60.5)', () => {
  it('offers an explicit Convert action when a formula prevents an in-place change', () => {
    const doc = {
      ...betDoc,
      properties: {
        fields: { stake: { kind: 'number' }, twice: { kind: 'formula', formula: 'stake * 2' } },
      } as unknown as Entry['properties'],
    };
    useVaultStore.setState({
      entries: [doc, { ...bet(1, '12'), properties: { stake: 12 } }],
      views: [],
    });
    const onPick = vi.fn();
    render(
      <KindChangeList typeName="Bet" def={{ name: 'stake', kind: 'number' }} onPick={onPick} />,
    );
    const option = screen.getByTestId('change-type-text') as HTMLButtonElement;
    expect(option.disabled).toBe(false);
    expect(option.textContent).toContain('Convert into a new property');
    fireEvent.click(option);
    expect(onPick.mock.calls[0][0]).toMatchObject({
      cast: 'never',
      copyOnly: true,
      lossless: false,
    });
  });
  it('shows each kind with what changing to it would do', () => {
    render(<KindChangeList typeName="Bet" def={stake} onPick={() => {}} />);
    expect(screen.getByTestId('change-type-hint-number').textContent).toBe(
      "3 won't convert · Converts into a new property",
    );
    expect(screen.getByTestId('change-type-hint-select').textContent).toBe('All 4 convert');
    expect(screen.queryByTestId('change-type-rollup')).toBeNull();
    expect(screen.queryByTestId('change-type-daterange')).toBeNull();
  });

  it('disables a Never row and gives its reason as the title', () => {
    render(<KindChangeList typeName="Bet" def={stake} onPick={() => {}} />);
    const files = screen.getByTestId('change-type-files') as HTMLButtonElement;
    expect(files.disabled).toBe(true);
    expect(files.title).toBe(neverReason('text'));
    expect(screen.getByTestId('change-type-hint-files').textContent).toBe(neverReason('text'));
  });

  it('checks the current kind, which picks nothing', () => {
    const onPick = vi.fn();
    render(<KindChangeList typeName="Bet" def={stake} onPick={onPick} />);
    const text = screen.getByTestId('change-type-text');
    expect(text.getAttribute('data-current')).toBe('true');
    expect(screen.getByTestId('change-type-number').getAttribute('data-current')).toBeNull();
    fireEvent.click(text);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('hands the picked row’s preview to the host', () => {
    const onPick = vi.fn();
    render(<KindChangeList typeName="Bet" def={stake} onPick={onPick} />);
    fireEvent.click(screen.getByTestId('change-type-number'));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toMatchObject({ to: 'number', failures: 3, converts: 1 });
  });

  it('draws menu items only as a menu', () => {
    const { unmount } = render(<KindChangeList typeName="Bet" def={stake} onPick={() => {}} />);
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    unmount();
    render(<KindChangeList typeName="Bet" def={stake} asMenu onPick={() => {}} />);
    expect(screen.getAllByRole('menuitem')).toHaveLength(14);
    expect(screen.getByTestId('change-type-repeat').getAttribute('role')).toBe('menuitem');
  });
});
