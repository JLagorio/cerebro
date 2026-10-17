import { useEffect, useState } from 'react';
import { connectorStatus, mailGateRead, scanVault, type MailGateRead } from '@/lib/ipc';
import { MAIL, isMailPath, isMailUrl } from '@/engine/mailPolicy';
import type { Entry } from '@/engine/types';
import type { ConnectorStatusRow } from '@/engine/connectors';
import { addDays, toIsoDate } from '@/engine/dates';
import { MAIL_SWEEP_PATH, newestMailFetch, pruneCandidates, sweepStatus } from '@/engine/mailSweep';
import { addSweepAgent, pruneDigests } from './mailActions';
import { PackPeopleOffer } from './PackPeopleOffer';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { Button } from '@/components/ui/Button';

type Read<T> = { vault: string; value: T } | { vault: string; error: string };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function mailGateWords(gate: MailGateRead): string {
  if (gate.state === 'closed')
    return 'Mail caching is not enabled in this build. No run can save mail digests until it is enabled.';
  if (gate.state === 'other_vault')
    return 'Mail caching is off in this vault. It is enabled for a different vault.';
  return `On, for Gmail. Headers only.${gate.kinds.includes(MAIL.kinds.text) ? ' Message text only when you ask in a conversation.' : ''}`;
}
/** Gate and cache reads fail independently; neither failure becomes an empty mailbox. */
export function MailSettings() {
  const vault = useVaultStore((state) => state.vaultPath);
  const entries = useVaultStore((state) => state.entries);
  const navigate = useNavStore((state) => state.navigate);
  const [gate, setGate] = useState<Read<MailGateRead> | null>(null);
  const [connectors, setConnectors] = useState<Read<ConnectorStatusRow[]> | null>(null);
  const [chosen, setChosen] = useState<{ vault: string; name: string } | null>(null);
  const [windowDays, setWindowDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [cache, setCache] = useState<Read<Entry[]> | null>(null);
  useEffect(() => {
    if (vault === null) return;
    let current = true;
    void mailGateRead(vault).then(
      (value) => {
        if (current) setGate({ vault, value });
      },
      (error) => {
        if (current) setGate({ vault, error: message(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [vault]);
  useEffect(() => {
    if (vault === null) return;
    let current = true;
    void scanVault(vault).then(
      (value) => {
        if (current) setCache({ vault, value });
      },
      (error) => {
        if (current) setCache({ vault, error: message(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [vault, entries]);
  useEffect(() => {
    if (vault === null) return;
    let current = true;
    void connectorStatus(vault).then(
      (value) => {
        if (current) setConnectors({ vault, value });
      },
      (error) => {
        if (current) setConnectors({ vault, error: message(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [vault]);
  const visibleGate = gate?.vault === vault ? gate : null;
  const visibleCache = cache?.vault === vault ? cache : null;
  const rows = visibleCache && 'value' in visibleCache ? visibleCache.value : [];
  const mail = rows.filter((entry) => isMailPath(entry.path));
  const unreadable = mail.filter(
    (entry) => entry.parseError !== null || entry.hash === null,
  ).length;
  const threads = mail.filter(
    (entry) =>
      entry.parseError === null &&
      entry.hash !== null &&
      entry.properties.source_kind === MAIL.kinds.thread,
  );
  const latest = newestMailFetch(rows) ?? undefined;
  const legacy = rows.filter(
    (entry) =>
      entry.properties.source_kind === 'web' &&
      [entry.properties.source_id, entry.properties.source_url].some(
        (value) => typeof value === 'string' && isMailUrl(value),
      ),
  );
  const visibleConnectors = connectors?.vault === vault ? connectors : null;
  const connectorRows =
    visibleConnectors && 'value' in visibleConnectors ? visibleConnectors.value : [];
  const connector =
    connectorRows.find(
      (row) => row.connector === (chosen?.vault === vault ? chosen.name : MAIL.gate.connector),
    ) ??
    connectorRows[0] ??
    null;
  const canAdd =
    visibleGate &&
    'value' in visibleGate &&
    visibleGate.value.state === 'open' &&
    visibleGate.value.kinds.includes(MAIL.kinds.thread);
  const gateTitle =
    visibleGate && 'value' in visibleGate && visibleGate.value.state === 'other_vault'
      ? 'Mail caching is not enabled for this vault.'
      : 'Mail caching is not enabled in this build.';
  const existing = entries.find((entry) => entry.path === MAIL_SWEEP_PATH);
  const plan = pruneCandidates(rows, addDays(toIsoDate(new Date()), -windowDays));
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mb-6 rounded-xl border border-n-200 p-5" data-testid="settings-mail">
      <h2 className="mb-3 text-md font-semibold text-n-900">Mail</h2>
      {vault === null ? (
        <p className="text-sm text-n-500">Open a vault to see its mail settings.</p>
      ) : (
        <div className="space-y-3 text-sm leading-relaxed text-n-600">
          {visibleGate === null ? (
            <p>Reading the mail gate…</p>
          ) : 'error' in visibleGate ? (
            <p data-testid="section-unavailable" className="text-warn-600">
              Mail gate could not be read: {visibleGate.error}
            </p>
          ) : (
            <p data-testid="mail-gate" data-state={visibleGate.value.state}>
              {mailGateWords(visibleGate.value)}
            </p>
          )}
          {visibleCache === null ? (
            <p>Reading cached mail…</p>
          ) : 'error' in visibleCache ? (
            <p data-testid="section-unavailable" className="text-warn-600">
              Cached mail could not be read: {visibleCache.error}
            </p>
          ) : (
            <>
              <p data-testid="mail-cached">
                {threads.length === 0
                  ? unreadable > 0
                    ? 'No readable mail digests.'
                    : mail.length > 0
                      ? 'No thread digests cached; other mail pages remain.'
                      : 'No mail cached.'
                  : `${threads.length} ${threads.length === 1 ? 'thread' : 'threads'} cached, ${latest === undefined ? 'fetch time not recorded' : `the newest fetched ${latest}`}.`}
                {unreadable > 0 && ` ${unreadable} could not be read.`}
              </p>
              {legacy.length > 0 && (
                <div data-testid="mail-legacy">
                  <p>
                    {legacy.length}{' '}
                    {legacy.length === 1
                      ? 'page from a mail link was'
                      : 'pages from mail links were'}{' '}
                    cached as {legacy.length === 1 ? 'a web page' : 'web pages'}. These copies may
                    remain in Git history:
                  </p>
                  <ul className="mt-1 list-none p-0">
                    {legacy.map((entry) => (
                      <li key={entry.path}>
                        <Button
                          variant="ghost"
                          onClick={() => navigate({ kind: 'doc', path: entry.path })}
                        >
                          {entry.title}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          <div data-testid="mail-sweep" className="space-y-2 border-t border-n-200 pt-3">
            <h3 className="font-medium text-n-900">Mail sweep</h3>
            {visibleConnectors === null ? (
              <p>Reading connector status…</p>
            ) : 'error' in visibleConnectors ? (
              <p data-testid="section-unavailable" className="text-warn-600">
                Mail connector status could not be read: {visibleConnectors.error}
              </p>
            ) : (
              <>
                <label className="flex items-center gap-2">
                  Gmail connector
                  <select
                    aria-label="Gmail connector"
                    value={connector?.connector ?? ''}
                    onChange={(event) => setChosen({ vault, name: event.target.value })}
                    className="rounded-sm border border-n-300 bg-surface-base px-2 py-1"
                  >
                    {connectorRows.length === 0 && (
                      <option value="">No connectors configured</option>
                    )}
                    {connectorRows.map((row) => (
                      <option key={row.connector} value={row.connector}>
                        {row.connector}
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  {visibleCache && 'value' in visibleCache
                    ? sweepStatus(rows, connector)
                    : 'Sweep time unavailable.'}
                </p>
              </>
            )}
            {existing ? (
              <Button
                variant="secondary"
                onClick={() => navigate({ kind: 'doc', path: existing.path })}
              >
                Open Mail sweep
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={!canAdd || !connector || !!connector.refused || busy}
                title={
                  !canAdd
                    ? gateTitle
                    : (connector?.refused ?? (!connector ? 'Choose a Gmail connector.' : undefined))
                }
                onClick={() => {
                  if (connector) void perform(() => addSweepAgent(connector.connector));
                }}
              >
                Add Mail sweep
              </Button>
            )}
            <p className="text-xs text-n-500">
              Ask @mail-sweep in the assistant to cache your recent mail headers.
            </p>
          </div>
          <div data-testid="mail-prune" className="space-y-2 border-t border-n-200 pt-3">
            <h3 className="font-medium text-n-900">Remove older cached mail</h3>
            <label className="flex items-center gap-2">
              Older than
              <select
                aria-label="Mail retention window"
                value={windowDays}
                onChange={(event) => setWindowDays(Number(event.target.value))}
                className="rounded-sm border border-n-300 bg-surface-base px-2 py-1"
              >
                {[30, 90, 365].map((days) => (
                  <option key={days} value={days}>
                    {days} days
                  </option>
                ))}
              </select>
            </label>
            {visibleCache && 'value' in visibleCache ? (
              <>
                <p>
                  {plan.digests > 0
                    ? `${plan.digests} ${plan.digests === 1 ? 'digest' : 'digests'} and ${plan.textPages} ${plan.textPages === 1 ? 'text page' : 'text pages'} go to Recently deleted.`
                    : `${plan.undated + plan.unreadable > 0 ? 'No dated, readable digests' : 'Nothing'} older than ${windowDays} days.`}
                </p>
                {plan.undated > 0 && (
                  <p>
                    {plan.undated}{' '}
                    {plan.undated === 1
                      ? 'digest without a recorded message date stays.'
                      : 'digests without a recorded message date stay.'}
                  </p>
                )}
                {plan.unreadable > 0 && <p>{plan.unreadable} unreadable mail pages stay.</p>}
                {plan.keptText > 0 && (
                  <p>{plan.keptText} text pages could not be matched safely and stay.</p>
                )}
                {plan.remaining > 0 && (
                  <p>{plan.remaining} more digests remain for a later removal.</p>
                )}
                <Button
                  variant="secondary"
                  disabled={plan.ops.length === 0 || busy}
                  onClick={() => void perform(() => pruneDigests(plan, vault))}
                >
                  Remove cached mail
                </Button>
              </>
            ) : (
              <p>Read the cache before removing mail.</p>
            )}
          </div>
          <PackPeopleOffer />
          <p>Kept out of git: {MAIL.folder}/ and comments on it.</p>
        </div>
      )}
    </section>
  );
}
