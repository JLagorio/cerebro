import { useMemo, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import {
  accessLines,
  pageAccess,
  summaryWords,
  type AccessRow,
  type Reach,
} from '@/engine/agentAccess';
import type { Entry } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** A row's `data-write`: its strongest reach, `none` read as `no`. */
const WRITE_ATTR: Record<Reach, string> = {
  yes: 'yes',
  asks: 'asks',
  'own-notes': 'own-notes',
  none: 'no',
};

function AccessRowView({ row }: { row: AccessRow }) {
  const open = useOpenPath();
  const { status, reasons } = accessLines(row);
  const path = row.path;
  return (
    <li
      data-testid="page-access-row"
      data-actor={row.actor}
      data-panel={row.panel ? 'yes' : undefined}
      data-write={WRITE_ATTR[row.write]}
      data-read={row.read ? 'yes' : 'no'}
      data-unattended={row.runsUnattended ? 'yes' : 'no'}
      className="flex flex-col gap-0.5 rounded-md px-1.5 py-1.5"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        {path !== null && !row.panel ? (
          <button
            type="button"
            data-testid="page-access-agent"
            onClick={() => open(path)}
            className="min-w-0 truncate border-0 bg-transparent p-0 text-left text-sm font-medium text-n-800 hover:underline"
          >
            {row.title}
          </button>
        ) : (
          <span className="min-w-0 truncate text-sm font-medium text-n-800">{row.title}</span>
        )}
        <span data-testid="page-access-status" className="flex-none text-xs text-n-600">
          {status}
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-px p-0">
        {reasons.map((reason) => (
          <li
            key={reason}
            data-testid="page-access-reason"
            className="text-2xs leading-[15px] text-n-500"
          >
            {reason}
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Who can change this page (M58.6), on the Info tab: the assistant panel and
 * every agent, each with what it can reach here and why, derived by
 * engine/agentAccess from the tool manifest, the tool-approval table and the
 * record's own axes. Rows that can't change the page fold away.
 *
 * Nothing here is read over IPC: the scan, the Settings shell ceiling and
 * the panel's binding are already in the stores, so there is no read that
 * can fail and no unavailable state.
 */
export function PageAccess({ entry }: { entry: Entry }) {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const shell = useUiStore((s) => s.agentShell);
  const panelAgent = useUiStore((s) =>
    vaultPath === null ? null : (s.panelAgents[vaultPath] ?? null),
  );
  const [showOthers, setShowOthers] = useState(false);
  const access = useMemo(
    () => pageAccess({ entries, path: entry.path, type: entry.type, shell, panelAgent }),
    [entries, entry.path, entry.type, shell, panelAgent],
  );
  const reaching = access.rows.filter((row) => row.write !== 'none');
  const others = access.rows.filter((row) => row.write === 'none');

  return (
    <section data-testid="page-access" className="mt-3 border-t border-n-100 px-1.5 pt-2">
      <h3 className="m-0 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
        Who can change this page
      </h3>
      <p className="m-0 mt-1 text-xs text-n-600">
        You can always change this page. An agent can only as its grant allows.
      </p>
      <p data-testid="page-access-summary" className="m-0 mt-1 text-xs font-medium text-n-800">
        {summaryWords(access)}
      </p>
      {reaching.length > 0 && (
        <ul className="m-0 mt-1 flex list-none flex-col gap-px p-0">
          {reaching.map((row) => (
            <AccessRowView key={row.panel ? 'panel' : row.actor} row={row} />
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <div data-testid="page-access-others" className="mt-1">
          <button
            type="button"
            data-testid="page-access-others-toggle"
            aria-expanded={showOthers}
            onClick={() => setShowOthers((v) => !v)}
            className="border-0 bg-transparent px-1.5 py-1 text-xs text-n-500 hover:text-n-800"
          >
            {showOthers ? 'Hide' : `${others.length} more can't change it`}
          </button>
          {showOthers && (
            <ul className="m-0 flex list-none flex-col gap-px p-0">
              {others.map((row) => (
                <AccessRowView key={row.panel ? 'panel' : row.actor} row={row} />
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="m-0 mt-2 text-2xs text-n-400">
        Connector tools act outside the vault&rsquo;s checks, so they are not counted here.
      </p>
    </section>
  );
}
