import { useMemo, useState } from 'react';
import {
  changedSinceQueued,
  editSent,
  editWaits,
  PENDING_COPY,
  pendingWriteAnswers,
  pendingWriteState,
} from '@/agent/elements/decisions';
import { WriteDraftForm, type DraftChange } from '@/agent/WriteDraftForm';
import { Confirmation } from '@/components/ai/Confirmation';
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
import './review.css';

export { PENDING_COPY };

/**
 * One page write an ask-first agent queued for Review (M57.4c): a run nobody
 * watched could not ask, so its write waits here instead of landing. It is a
 * Confirmation (M91.14), the anatomy every card that asks shares.
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
 * in place of the answers until the queue re-reads; a refused edit shows
 * under the form and the card stays with the edits, because the write still
 * waits. Only a call that fails to reach the backend at all toasts "Couldn't
 * decide", and leaves the card to answer again. Rust re-runs every guard
 * under the queuing run's grant at Allow; this card only asks. Everything
 * the agent wrote shows as text, never markup.
 */

interface Props {
  write: PendingWrite;
  vaultPath: string;
}

export function PendingWriteCard({ write, vaultPath }: Props) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const toast = useUiStore((s) => s.toast);
  const [change, setChange] = useState<DraftChange | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const title = toolFacts(write.tool)?.title ?? write.tool;
  const schema = toolSchema(write.tool);
  const draft = useMemo(() => write.input, [write.input]);
  const page = entries.find((entry) => entry.path === write.target) ?? null;
  const changed = page !== null && changedSinceQueued(write.target_hash, page.hash);
  const state = pendingWriteState({ busy, refused, outcome });

  const decide = async (allow: boolean, reason: string | null) => {
    setBusy(true);
    try {
      const decision: PendingDecision = await ipc.decidePendingWrite(
        vaultPath,
        write.pending_id,
        allow,
        allow ? editSent(change) : null,
        allow ? null : reason,
      );
      if (decision.outcome === 'edit_refused') {
        // The write still waits: say why under the form, keep the edits.
        setRefused(decision.reason);
        return;
      }
      const words =
        decision.outcome === 'applied'
          ? PENDING_COPY.applied(decision.path)
          : decision.outcome === 'refused'
            ? PENDING_COPY.refused(decision.reason)
            : decision.outcome === 'rejected'
              ? PENDING_COPY.rejected
              : PENDING_COPY.decided;
      toast(words);
      setOutcome(words);
      bumpPendingCards();
    } catch (e) {
      toast(PENDING_COPY.failed(refusalText(e)));
    } finally {
      setBusy(false);
    }
  };

  const answers = pendingWriteAnswers({
    allowWaits: editWaits(change),
    onAllow: () => void decide(true, null),
    onReject: (reason) => void decide(false, reason),
  });

  return (
    <Confirmation
      data-testid="pending-write-card"
      data-tool={write.tool}
      data-pending-id={write.pending_id}
      variant="outline"
      state={state}
      icon="file-pen-line"
      title={title}
      meta={
        <>
          <span data-testid="pending-write-when">
            {PENDING_COPY.queued(relativeWhen(write.queued_at, new Date()))}
          </span>
          <CardAuthor actor={write.actor} />
        </>
      }
      notice={changed ? <span className="text-warn-700">{PENDING_COPY.changed}</span> : null}
      refusal={refused}
      outcome={outcome}
      testIds={{
        title: 'pending-write-title',
        notice: 'pending-write-changed',
        refusal: 'pending-write-refused',
      }}
      approve={answers.approve}
      deny={answers.deny}
      className="cb-review-card"
    >
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
      {schema !== null ? (
        <WriteDraftForm
          title={title}
          schema={schema}
          draft={draft}
          disabled={state !== 'pending' && state !== 'refused'}
          onChange={(next) => {
            setChange(next);
            setRefused(null);
          }}
        />
      ) : (
        <details>
          <summary className="cursor-pointer text-metadata text-(--text-meta)">
            {PENDING_COPY.draft}
          </summary>
          <pre className="m-0 mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-2xs text-n-600">
            {JSON.stringify(write.input, null, 2)}
          </pre>
        </details>
      )}
    </Confirmation>
  );
}
