import { clientReach, type ClientReach } from '@/engine/clientAccess';
import { CLIENT_ACTOR_PREFIX } from '@/engine/authors';
import { GOVERNED_TYPES } from '@/engine/agentAccess';
import { useClientAccessStore } from '@/stores/clientAccessStore';
import { useEffect, useId, useMemo, useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Icon } from '@/components/ui/Icon';
import {
  accessLines,
  pageAccess,
  summaryShort,
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

/** A quiet disclosure's chevron: right when folded, down when open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="chevron-right"
      size={14}
      className={`flex-none text-n-400 motion-move ${open ? 'rotate-90' : ''}`}
    />
  );
}

/**
 * One line per agent or app (owner, 2026-10-18): its name, which opens it
 * when it has a page, and what it can do here at the line's end. Pressing
 * that shows the reasons, which stay in the DOM while folded.
 */
function AccessLine({
  title,
  status,
  reasons,
  onOpen,
  facts,
}: {
  title: string;
  status: string;
  reasons: readonly string[];
  /** Opens its page; without one the name is only a name. */
  onOpen?: () => void;
  /** The row's `data-*` attributes: what it can reach, for whoever reads them. */
  facts: Record<string, string | undefined>;
}) {
  const [why, setWhy] = useState(false);
  const reasonsId = useId();
  const name = 'min-w-0 max-w-[60%] flex-none truncate text-ui text-n-800';
  return (
    <li data-testid="page-access-row" {...facts}>
      <div className="-mx-2 flex min-h-7 min-w-0 items-center gap-2 rounded-md px-2 hover:bg-n-50">
        {onOpen !== undefined ? (
          <button
            type="button"
            data-testid="page-access-agent"
            onClick={onOpen}
            className={`${name} bg-transparent p-0 text-left decoration-n-300 underline-offset-2 hover:underline`}
          >
            {title}
          </button>
        ) : (
          <span className={name}>{title}</span>
        )}
        <button
          type="button"
          data-testid="page-access-why"
          aria-expanded={why}
          aria-controls={reasonsId}
          aria-label={`${title}: ${status}`}
          title={why ? 'Hide why' : 'Show why'}
          onClick={() => setWhy((v) => !v)}
          className="ml-auto flex min-w-0 items-center gap-1 bg-transparent p-0 text-xs text-n-500 hover:text-n-800"
        >
          <span data-testid="page-access-status" className="min-w-0 truncate">
            {status}
          </span>
          <Chevron open={why} />
        </button>
      </div>
      <ul id={reasonsId} hidden={!why} className="flex flex-col gap-0.5 pb-1.5 pt-0.5">
        {reasons.map((reason) => (
          <li
            key={reason}
            data-testid="page-access-reason"
            className="text-xs leading-4 text-n-500"
          >
            {reason}
          </li>
        ))}
      </ul>
    </li>
  );
}

function AgentLine({ row }: { row: AccessRow }) {
  const open = useOpenPath();
  const { status, reasons } = accessLines(row);
  const path = row.path;
  return (
    <AccessLine
      title={row.title}
      status={status}
      reasons={reasons}
      onOpen={path !== null && !row.panel ? () => open(path) : undefined}
      facts={{
        'data-actor': row.actor,
        'data-panel': row.panel ? 'yes' : undefined,
        'data-write': WRITE_ATTR[row.write],
        'data-read': row.read ? 'yes' : 'no',
        'data-unattended': row.runsUnattended ? 'yes' : 'no',
      }}
    />
  );
}

/** An app's token, said in an agent's words, so the two lists read alike. */
function clientStatus(row: ClientReach): string {
  if (row.write) return 'Can change it';
  return row.read ? 'Can read it' : "Can't reach it";
}

/** The page's access rows, as both the section and its header read them. */
function usePageAccess(entry: Entry) {
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const shell = useUiStore((s) => s.agentShell);
  const delegate = useUiStore((s) => (s.agentDelegate ? 'on' : 'off'));
  const panelAgent = useUiStore((s) =>
    vaultPath === null ? null : (s.panelAgents[vaultPath] ?? null),
  );
  return useMemo(
    () => pageAccess({ entries, path: entry.path, type: entry.type, shell, delegate, panelAgent }),
    [entries, entry.path, entry.type, shell, delegate, panelAgent],
  );
}

/**
 * What the Access section holds, said on its header, folded or open: how
 * many agents can change the page. The rule behind it is its tooltip.
 */
export function AccessSummary({ entry }: { entry: Entry }) {
  const access = usePageAccess(entry);
  return (
    <span
      data-testid="page-access-summary"
      title={`${summaryWords(access)} You can always change this page. An agent can only as its grant allows.`}
    >
      {summaryShort(access)}
    </span>
  );
}

/**
 * Who can change this page (M58.6), the inspector's Access section, which
 * names it: the assistant panel and every agent, each with what it can reach
 * here and why, derived by engine/agentAccess from the tool manifest, the
 * tool-approval table and the record's own axes. A row is one line, its
 * reasons folded under it; rows that can't change the page fold away too.
 *
 * Token reach is read from runtime metadata and has its own unavailable state.
 */
export function PageAccess({ entry }: { entry: Entry }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const [showOthers, setShowOthers] = useState(false);
  const clients = useClientAccessStore();
  useEffect(() => {
    if (vaultPath) void useClientAccessStore.getState().refresh(vaultPath);
  }, [vaultPath]);
  const clientRows =
    clients.vault === vaultPath && clients.tokensStatus === 'ready'
      ? clientReach(
          clients.tokens,
          entry.path,
          GOVERNED_TYPES.some((type) => type === entry.type),
        )
      : [];
  const writers = clientRows.filter((row) => row.write);

  const access = usePageAccess(entry);
  const reaching = access.rows.filter((row) => row.write !== 'none');
  const others = access.rows.filter((row) => row.write === 'none');

  return (
    <div data-testid="page-access">
      {reaching.length > 0 && (
        <ul className="flex flex-col gap-px">
          {reaching.map((row) => (
            <AgentLine key={row.panel ? 'panel' : row.actor} row={row} />
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <div data-testid="page-access-others">
          <button
            type="button"
            data-testid="page-access-others-toggle"
            aria-expanded={showOthers}
            onClick={() => setShowOthers((v) => !v)}
            className="-mx-2 flex min-h-7 w-[calc(100%+16px)] items-center gap-1 rounded-md bg-transparent px-2 text-left text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
          >
            <Chevron open={showOthers} />
            {`${others.length} more can't change it`}
          </button>
          {showOthers && (
            <ul className="flex flex-col gap-px">
              {others.map((row) => (
                <AgentLine key={row.panel ? 'panel' : row.actor} row={row} />
              ))}
            </ul>
          )}
        </div>
      )}
      {/* Other apps, last: one quiet line when none can change the page,
          their rows when some hold a token. Connector tools are never
          counted, which the line's tooltip says rather than a footnote. */}
      <div
        data-testid="page-client-access"
        title="Connector tools act outside the vault’s checks, so they are not counted here."
        className="mt-1 text-xs leading-4 text-n-400"
      >
        {clients.vault !== vaultPath ||
        clients.tokensStatus === 'loading' ||
        clients.tokensStatus === 'idle' ? (
          <p className="py-1.5">Reading other apps…</p>
        ) : clients.tokensStatus === 'error' ? (
          <p data-testid="section-unavailable" className="py-1.5">
            Couldn&rsquo;t read which other apps have tokens.
          </p>
        ) : (
          <>
            <p className="py-1.5">
              {writers.length
                ? `Other apps that can change it: ${writers.map((row) => row.token.name).join(', ')}`
                : 'No other app can change it'}
            </p>
            {clientRows.length > 0 && (
              <ul className="flex flex-col gap-px">
                {clientRows.map((row) => (
                  <AccessLine
                    key={row.token.tokenId}
                    title={row.token.name}
                    status={clientStatus(row)}
                    reasons={[row.reason]}
                    facts={{
                      'data-actor': `${CLIENT_ACTOR_PREFIX}${row.token.slug}`,
                      'data-write': row.write ? 'yes' : 'no',
                      'data-read': row.read ? 'yes' : 'no',
                    }}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
