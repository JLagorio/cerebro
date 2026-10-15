import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import type { Entry } from '@/engine/types';
import { ImportProvenance } from './ImportProvenance';
afterEach(cleanup);
it('names the import source and date, and distinguishes agent-composed text', () => {
  const entry = makeEntry({
    path: 'records/imported.md',
    properties: {
      source_system: 'notion',
      imported_at: '2026-10-13',
      import_method: 'agent_composed',
    },
  });
  const { rerender } = render(<ImportProvenance entry={entry} />);
  expect(screen.getByTestId('import-provenance').textContent).toContain(
    'Imported from Notion · 2026-10-13 · composed by the agent',
  );
  rerender(
    <ImportProvenance
      entry={{ ...entry, properties: { ...entry.properties, import_method: 'captured' } }}
    />,
  );
  expect(screen.getByTestId('import-provenance').textContent).toContain(
    'Imported from Notion · 2026-10-13',
  );
  expect(screen.getByTestId('import-provenance').textContent).not.toContain('composed');
});
it.each<Entry['properties']>([
  {},
  { source_system: 'unknown', imported_at: '2026-10-13' },
  { source_system: 'linear', imported_at: 'not recorded' },
  { source_system: 'linear', imported_at: '2026-02-31' },
  { source_system: 'linear' },
])('does not invent provenance from unreadable fields %j', (properties) => {
  render(<ImportProvenance entry={makeEntry({ path: 'records/imported.md', properties })} />);
  expect(screen.queryByTestId('import-provenance')).toBeNull();
});
