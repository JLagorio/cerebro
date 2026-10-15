import { useMemo, useState } from 'react';
import { WriteDraftForm, type DraftChange } from '@/agent/WriteDraftForm';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { relativeWhen } from '@/engine/whenText';
import { bumpPendingCards } from '@/knowledge/usePendingCards';
import * as ipc from '@/lib/ipc';
import type { PendingDecision, PendingWrite } from '@/lib/ipc';
import { toolFacts, toolSchema } from '@/lib/policy/tools';
import { refusalText } from '@/lib/refusal';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { CardAuthor } from './ProposalCard';

/**
 * One page write an ask-first agent queued for Review (M57.4c): a run nobody
 * watched could not ask, so its write waits here instead of landing.
 *
 * It names the write by the tool manifest's title, then the page it lands on
 * (opening it when the page exists), who asked and when, and says so when
 * the page changed since the write was queued. The draft is M57.4b's form,
 * editable before Allow. Allow sends the person's edit only when there is
 * one, and waits while it is invalid; Reject opens a reason, which it needs,
 * because the agent's next run reads it.
 *
 * The answer is typed and read here (CV-03's proposal-channel exemption):
 * applied, refused, rejected and already decided each say so in a toast and
 * the queue re-reads; a refused edit shows under the form and the card stays
 * with the edits, because the write still waits. Only a call that fails to
 * reach the backend at all toasts "Couldn't decide". Rust re-runs every
 * guard under the queuing run's grant at Allow; this card only asks.
 * Everything the agent wrote shows as text, never markup.
 */

/** The card's words (Appendix C, M57.4c). */
export const PENDING_COPY = {
  queued: (when: string) => `Queued ${when} by`,
  changed: 'This page changed since it was queued.',
  allow: 'Allow',
  reject: 'Reject',
  send: 'Send',
  reason: 'Why not? The agent will read this.',
  applied: (path: string) => `Applied — ${path}`,
  refused: (reason: string) =>
    `Allowed, but Cerebro refused it: ${reason.replace(/\.$/, '')}. The agent will hear this.`,
  rejected: 'Rejected',
  decided: 'Already decided',
  failed: (why: string) => `Couldn't decide: ${why}`,
  draft: 'Draft',
} as const;

interface Props {
  write: PendingWrite;
  vaultPath: string;
}

export function PendingWriteCard({ write, vaultPath }: Props) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const toast = useUiStore((s) => s.toast);
  const [change, setChange] = useState<DraftChange | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const title = toolFacts(write.tool)?.title ?? write.tool;
  const schema = toolSchema(write.tool);
  const draft = useMemo(() => write.input, [write.input]);
  const page = entries.find((entry) => entry.path === write.target) ?? null;
  // Both hashes known and different: someone changed the page since.
  const changed =
    page !== null &&
    page.hash != null &&
    write.target_hash !== null &&
    page.hash !== write.target_hash;
  const edited = change?.edited === true;

  const decide = async (allow: boolean) => {
    setBusy(true);
    try {
      const decision: PendingDecision = await ipc.decidePendingWrite(
        vaultPath,
        write.pending_id,
        allow,
        allow && edited && change !== null ? change.input : null,
        allow ? null : reason.trim(),
      );
      if (decision.outcome === 'edit_refused') {
        // The write still waits: say why under the form, keep the edits.
        setRefused(decision.reason);
        return;
      }
      if (decision.outcome === 'applied') toast(PENDING_COPY.applied(decision.path));
      else if (decision.outcome === 'refused') toast(PENDING_COPY.refused(decision.reason));
      else if (decision.outcome === 'rejected') toast(PENDING_COPY.rejected);
      else toast(PENDING_COPY.decided);
      bumpPendingCards();
    } catch (e) {
      toast(PENDING_COPY.failed(refusalText(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      data-testid="pending-write-card"
      data-tool={write.tool}
      data-pending-id={write.pending_id}
      className="flex flex-col gap-2 rounded-lg border border-n-200 bg-n-0 p-3"
    >
      <header className="flex items-center gap-1.5">
        <Icon name="file-pen-line" size={14} color="var(--cortex-600)" />
        <span data-testid="pending-write-title" className="text-sm font-semibold text-n-900">
          {title}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-n-500">
          <span data-testid="pending-write-when">
            {PENDING_COPY.queued(relativeWhen(write.queued_at, new Date()))}
          </span>
          <CardAuthor actor={write.actor} />
        </span>
      </header>
      {page !== null ? (
        <button
          type="button"
          data-testid="pending-write-target"
          data-path={write.target}
          onClick={() => navigate({ kind: 'doc', path: write.target })}
          className="self-start border-0 bg-transparent p-0 text-left text-xs font-medium text-cortex-600 hover:underline"
        >
          {page.title || write.target}
        </button>
      ) : (
        <span
          data-testid="pending-write-target"
          data-path={write.target}
          className="min-w-0 truncate [font-family:var(--font-mono)] text-2xs text-cortex-700"
        >
          {write.target}
        </span>
      )}
      {changed && (
        <p data-testid="pending-write-changed" className="m-0 text-xs text-warn-700">
          {PENDING_COPY.changed}
        </p>
      )}
      {schema !== null ? (
        <WriteDraftForm
          title={title}
          schema={schema}
          draft={draft}
          disabled={busy}
          onChange={(next) => {
            setChange(next);
            setRefused(null);
          }}
        />
      ) : (
        <details>
          <summary className="cursor-pointer text-2xs text-n-500">{PENDING_COPY.draft}</summary>
          <pre className="m-0 mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-2xs text-n-600">
            {JSON.stringify(write.input, null, 2)}
          </pre>
        </details>
      )}
      {refused !== null && (
        <p data-testid="pending-write-refused" role="alert" className="m-0 text-xs text-danger-600">
          {refused}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="primary"
          size="sm"
          testId="pending-write-allow"
          disabled={busy || (edited && change?.valid !== true)}
          onClick={() => void decide(true)}
        >
          {PENDING_COPY.allow}
        </Button>
        {rejecting ? (
          <>
            <Input
              value={reason}
              size="sm"
              placeholder={PENDING_COPY.reason}
              ariaLabel={PENDING_COPY.reason}
              testId="pending-write-reason"
              autoFocus
              className="min-w-[120px] flex-[1_1_160px]"
              onChange={(e) => setReason(e.target.value)}
            />
            <Button
              size="sm"
              testId="pending-write-send"
              disabled={busy || reason.trim() === ''}
              onClick={() => void decide(false)}
            >
              {PENDING_COPY.send}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            testId="pending-write-reject"
            disabled={busy}
            onClick={() => setRejecting(true)}
          >
            {PENDING_COPY.reject}
          </Button>
        )}
      </div>
    </article>
  );
}
