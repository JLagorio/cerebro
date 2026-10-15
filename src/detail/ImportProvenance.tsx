import { parseDateText } from '@/engine/dateGrammar';
import { IMPORT_SOURCES } from '@/engine/importSources';
import type { Entry } from '@/engine/types';

/** Writer-owned provenance stays with the page, independently of its tab. */
export function ImportProvenance({ entry }: { entry: Entry }) {
  const { source_system: system, imported_at: at, import_method: method } = entry.properties;
  const source = IMPORT_SOURCES.systems.find((row) => row.id === system);
  const date = typeof at === 'string' ? parseDateText(at) : null;
  if (source === undefined || date === null) return null;
  return (
    <p data-testid="import-provenance" className="my-2 text-xs text-n-400" title={at as string}>
      Imported from {source.label} · {date.date}
      {method === 'agent_composed' ? ' · composed by the agent' : ''}
    </p>
  );
}
