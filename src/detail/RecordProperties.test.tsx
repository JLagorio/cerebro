// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordProperties } from './RecordProperties';
import { buildSchema } from '@/engine/schema';
import { fixtureVault } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';

describe('RecordProperties display config (M44.1)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault' });
  });
  afterEach(cleanup);

  // `fixtureVault()`'s work-item fields declare no `visibility` at all, so by
  // default `splitByVisibility` never folds anything (M16.10's default is
  // `show`, not `hide_when_empty`). `due` is left unset on fld-1, so marking
  // it `hide_when_empty` on the type is enough to produce a hidden property
  // without also having to blank a field that IS set. `hideField` adds a
  // second field marked `visibility: 'hide'` outright — deliberately hidden,
  // not merely empty — to pin the plan decision that `show_empty` never
  // reaches it.
  const setup = (options: { display?: Record<string, unknown>; hideField?: boolean } = {}) => {
    const entries = fixtureVault();
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    const typeProps = typeDoc.properties as unknown as Record<string, unknown>;
    const fields = typeProps.fields as Record<string, unknown>;
    fields.due = { kind: 'date', visibility: 'hide_when_empty' };
    if (options.hideField === true) {
      fields.internal = { kind: 'text', visibility: 'hide' };
    }
    if (options.display !== undefined) {
      typeProps.display = options.display;
    }
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    render(<RecordProperties entry={entry} schema={buildSchema(entries)} />);
  };

  it('folds empty properties behind the count by default', () => {
    setup();
    expect(screen.queryByTestId('hidden-properties-toggle')).toBeTruthy();
    expect(screen.queryByText('Due')).toBeNull();
  });

  it('show_empty unfolds them and retires the toggle — nothing left to fold', () => {
    setup({ display: { show_empty: true } });
    expect(screen.queryByTestId('hidden-properties-toggle')).toBeNull();
    expect(screen.getByText('Due')).toBeTruthy();
  });

  it('show_empty does not reach a field hidden on purpose', () => {
    setup({ display: { show_empty: true }, hideField: true });
    // `due` was hidden for being empty — show_empty unfolds it.
    expect(screen.getByText('Due')).toBeTruthy();
    // `internal` was hidden on purpose — show_empty speaks about emptiness
    // only, so it stays folded and the toggle reappears counting it alone.
    expect(screen.queryByText('Internal')).toBeNull();
    expect(screen.getByTestId('hidden-properties-toggle')).toBeTruthy();
  });
});
