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
  // without also having to blank a field that IS set.
  const setup = (display?: Record<string, unknown>) => {
    const entries = fixtureVault();
    const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
    const typeProps = typeDoc.properties as unknown as Record<string, unknown>;
    const fields = typeProps.fields as Record<string, unknown>;
    fields.due = { kind: 'date', visibility: 'hide_when_empty' };
    if (display !== undefined) {
      typeProps.display = display;
    }
    const entry = entries.find((e) => e.path.endsWith('fld-1.md'))!;
    render(<RecordProperties entry={entry} schema={buildSchema(entries)} />);
  };

  it('folds empty properties behind the count by default', () => {
    setup();
    expect(screen.queryByTestId('hidden-properties-toggle')).toBeTruthy();
  });

  it('show_empty unfolds them and retires the toggle — nothing left to fold', () => {
    setup({ show_empty: true });
    expect(screen.queryByTestId('hidden-properties-toggle')).toBeNull();
  });
});
