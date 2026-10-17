import { useState } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import { Button } from '@/components/ui/Button';
import {
  correspondenceView,
  getCorrespondenceIndex,
  recordAddresses,
  recordDomain,
} from '@/engine/correspondents';
import { formatTimestamp } from '@/engine/properties';
import type { Entry, Schema } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';

/** Cached facts belong to a record, above its tabs; rendering writes nothing. */
export function CorrespondenceSection({ entry, schema }: { entry: Entry; schema: Schema }) {
  const entries = useVaultStore((s) => s.entries);
  const status = useVaultStore((s) => s.status);
  const open = useOpenPath();
  const [expanded, setExpanded] = useState(false);
  const view = correspondenceView(entry, getCorrespondenceIndex(entries, schema));
  const unavailable = status === 'error';
  if (
    view.state === 'silent' &&
    !(
      unavailable &&
      (recordAddresses(entry, schema).length > 0 || recordDomain(entry, schema) !== null)
    )
  )
    return null;
  const state = unavailable
    ? 'unavailable'
    : view.state === 'silent'
      ? 'empty'
      : view.unreadable > 0
        ? 'partial'
        : view.state === 'you' || view.state === 'domain-blocked'
          ? 'not-recorded'
          : view.threads.length === 0
            ? 'empty'
            : 'ready';
  return (
    <section
      data-testid="correspondence-section"
      data-state={state}
      aria-label="Correspondence"
      className="my-3 border-t border-n-100 pt-3 text-xs text-n-600"
    >
      <h3 className="m-0 mb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
        {'domain' in view && view.domain !== null ? `Mail with ${view.domain}` : 'Correspondence'}
      </h3>
      {unavailable ? (
        <p data-testid="section-unavailable" className="m-0">
          Couldn't read the vault, so correspondence is unavailable.
        </p>
      ) : (
        <>
          {view.state === 'domain-blocked' ? (
            <p className="m-0">
              {view.reason === 'consumer'
                ? `${view.domain} is a personal mail domain, so mail is not grouped under it.`
                : `${view.domain} is your domain, so mail is not grouped under it.`}
            </p>
          ) : view.state === 'you' ? (
            <p className="m-0">This is you: every cached thread includes you.</p>
          ) : (
            view.state === 'record' && (
              <>
                {view.ambiguous.map(({ address, others }) => (
                  <p key={address} className="my-1">
                    {address} is also on{' '}
                    {others.map((other, i) => (
                      <span key={other.path}>
                        {i > 0 && ', '}
                        <button
                          type="button"
                          className="text-cortex-600 hover:underline"
                          onClick={() => open(other.path)}
                        >
                          {other.title}
                        </button>
                      </span>
                    ))}
                    . Mail is not matched to either page until one holds it.
                  </p>
                ))}
                {view.unmatched.map((address) => (
                  <p key={address} className="my-1">
                    No {view.unreadable > 0 ? 'readable ' : ''}cached thread includes {address}.
                  </p>
                ))}
                {view.threads.length > 0 && (
                  <>
                    <p className="my-1">
                      Last message {formatTimestamp(view.lastMessageAt!)} · {view.threads.length}{' '}
                      {view.threads.length === 1 ? 'thread' : 'threads'}
                      {view.waiting > 0 && ` · waiting on you in ${view.waiting}`}
                    </p>
                    <p className="my-1 text-n-500">
                      {view.lastSentAt === null
                        ? 'You have not written in these threads.'
                        : `Last emailed ${formatTimestamp(view.lastSentAt)}`}
                    </p>
                    <ul className="m-0 mt-2 list-none p-0">
                      {(expanded ? view.threads : view.threads.slice(0, 10)).map((thread) => (
                        <li key={thread.entry.path}>
                          <button
                            type="button"
                            className="flex w-full items-baseline gap-3 rounded-md px-1 py-1 text-left hover:bg-n-50"
                            onClick={() => open(thread.entry.path)}
                          >
                            <span className="min-w-0 flex-1 truncate text-cortex-600">
                              {thread.entry.title}
                            </span>
                            <span className="shrink-0 text-2xs text-n-500">
                              {formatTimestamp(thread.lastMessageAt)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {!expanded && view.threads.length > 10 && (
                      <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
                        Show {view.threads.length - 10} more
                      </Button>
                    )}
                  </>
                )}
              </>
            )
          )}
          {view.state !== 'silent' && view.unreadable > 0 && (
            <p className="my-1 text-n-500">
              {view.unreadable} cached {view.unreadable === 1 ? 'thread' : 'threads'} could not be
              read.
            </p>
          )}
        </>
      )}
    </section>
  );
}
