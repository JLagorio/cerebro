import { useState } from 'react';
import { TranscriptRows } from '@/agent/toolRenderers';
import { replayTranscript } from '@/agent/transcript';
import type { ChatMessage } from '@/agent/types';
import { Icon } from '@/components/ui/Icon';
import { fleetRunTranscript, type RunTranscript as Transcript } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';

/**
 * A run's transcript, folded from Claude Code's own session file (M56.9, D5).
 *
 * **Collapsed until asked for.** The file lives outside the vault, so it is
 * read only when someone opens this section, once, and never again while the
 * panel is open (Q22). What comes back stays in this component: no store, no
 * localStorage, no copy anywhere. A run with no session never asks at all.
 *
 * **One reducer, one renderer.** The events go through the reducer the panel
 * uses (`replayTranscript`) and draw with the panel's rows (`TranscriptRows`,
 * read-only), so five reads in a row are one row here too. A run that is
 * still going is drawn live, so its open turn reads as going rather than
 * interrupted.
 *
 * **Every state says what it is.** Gone after Claude Code's sweep, gone
 * before it, not recorded, and could-not-read are four different sentences;
 * a failed read is `section-unavailable`, never an empty thread (CV-05).
 */

type Loaded =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; transcript: Transcript };

const NOT_RECORDED = 'Transcript not recorded for this run.';
const UNREADABLE =
  "Couldn't read this run's transcript, so nothing here is a statement about what it said.";

/** The footnote, naming the retention Claude Code is configured with, or no
 * period at all when it never sweeps. */
function retentionText(days: number | null): string {
  return days === null
    ? "Read from Claude Code's own session file, outside your vault. Cerebro keeps no copy."
    : "Read from Claude Code's own session file, outside your vault. Claude Code deletes these " +
        `files ${days} days after their last turn (30 by default), and Cerebro keeps no copy.`;
}

function Muted({ testId, children }: { testId?: string; children: string }) {
  return (
    <p data-testid={testId} className="text-2xs text-n-500">
      {children}
    </p>
  );
}

/** The turns, drawn as the panel draws them. */
function Turns({
  messages,
  running,
  onOpenPath,
}: {
  messages: ChatMessage[];
  running: boolean;
  onOpenPath: (path: string) => void;
}) {
  const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
  if (messages.length === 0) return <Muted>The session file holds no turns.</Muted>;
  return (
    <div className="flex flex-col gap-2">
      {messages.map((message, i) => {
        if (message.role === 'user') {
          return (
            <p
              key={message.id}
              data-testid="run-transcript-prompt"
              className="whitespace-pre-wrap rounded-md bg-n-100 px-2 py-1 text-2xs text-n-700"
            >
              {message.text}
            </p>
          );
        }
        // Only a running run's last turn is still going; the file ends it as
        // cut off, and that is not true yet.
        const live = running && i === lastAssistant;
        return (
          <div key={message.id} data-testid="run-transcript-turn" className="flex flex-col gap-1">
            {message.tools.length > 0 && (
              <TranscriptRows
                tools={message.tools}
                streaming={live}
                onOpenPath={onOpenPath}
                readOnly
              />
            )}
            {message.text !== '' && (
              <p className="whitespace-pre-wrap text-2xs text-n-700">{message.text}</p>
            )}
            {message.error !== undefined && (
              <p className="text-2xs text-danger-700">{message.notice?.title ?? message.error}</p>
            )}
            {message.interrupted === true && !live && (
              <Muted testId="run-transcript-interrupted">Interrupted before it finished.</Muted>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Body({
  loaded,
  sessionId,
  running,
  onOpenPath,
}: {
  loaded: Loaded;
  sessionId: string;
  running: boolean;
  onOpenPath: (path: string) => void;
}) {
  if (loaded.kind === 'idle' || loaded.kind === 'loading') {
    return <Muted>Reading…</Muted>;
  }
  if (loaded.kind === 'failed') {
    return (
      <p data-testid="section-unavailable" className="text-2xs text-n-500">
        {UNREADABLE}
      </p>
    );
  }
  const { read, runs_in_session: runs, retention_days: days } = loaded.transcript;
  const footnote = <Muted testId="run-transcript-retention">{retentionText(days)}</Muted>;
  if (read.state === 'unavailable') {
    switch (read.reason) {
      case 'not_recorded':
        return <Muted testId="run-transcript-state">{NOT_RECORDED}</Muted>;
      case 'expired':
        return (
          <>
            <Muted testId="run-transcript-state">
              {read.retention_days === null
                ? 'Cleared by Claude Code.'
                : `Cleared by Claude Code, which deletes session files ${read.retention_days} days after their last turn.`}
            </Muted>
            {footnote}
          </>
        );
      case 'cleared':
        return (
          <>
            <Muted testId="run-transcript-state">
              Cleared: this vault&apos;s Claude Code session files were deleted.
            </Muted>
            {footnote}
          </>
        );
      default:
        // Unreadable, or a reason this build does not name: Rust is the one
        // classifier, and either way nothing was read.
        return (
          <p data-testid="section-unavailable" className="text-2xs text-n-500">
            {UNREADABLE}
          </p>
        );
    }
  }
  const { messages } = replayTranscript(read.events, sessionId);
  return (
    <>
      {runs > 1 && (
        <Muted testId="run-transcript-shared">
          {`This Claude Code session holds ${runs} runs; all of it is shown.`}
        </Muted>
      )}
      {running && (
        <Muted testId="run-transcript-running">
          The run is still going; this is what its session file holds so far.
        </Muted>
      )}
      <div
        data-testid="run-transcript-body"
        className="max-h-96 overflow-y-auto rounded-md border border-n-200 bg-n-0 p-2"
      >
        <Turns messages={messages} running={running} onOpenPath={onOpenPath} />
      </div>
      {footnote}
    </>
  );
}

export function RunTranscript({
  runId,
  sessionId,
  running,
}: {
  runId: string;
  sessionId: string | null;
  running: boolean;
}) {
  const navigate = useNavStore((s) => s.navigate);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'idle' });

  if (sessionId === null) {
    return (
      <section data-testid="run-transcript" className="flex flex-col gap-1">
        <h5 className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
          Transcript
        </h5>
        <Muted testId="run-transcript-state">{NOT_RECORDED}</Muted>
      </section>
    );
  }

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // The first expand reads the file; every later one shows what came back.
    if (next && loaded.kind === 'idle') {
      setLoaded({ kind: 'loading' });
      fleetRunTranscript(runId).then(
        (transcript) => setLoaded({ kind: 'ready', transcript }),
        () => setLoaded({ kind: 'failed' }),
      );
    }
  };

  return (
    <section data-testid="run-transcript" className="flex flex-col gap-1">
      <button
        type="button"
        data-testid="run-transcript-toggle"
        aria-expanded={open}
        onClick={toggle}
        className="flex items-center gap-1.5 self-start border-0 bg-transparent p-0 text-left"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} color="var(--n-400)" />
        <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">
          Transcript
        </span>
        <span className="text-2xs text-n-400">from Claude Code&apos;s session file</span>
      </button>
      {open && (
        <Body
          loaded={loaded}
          sessionId={sessionId}
          running={running}
          onOpenPath={(path) => navigate({ kind: 'doc', path })}
        />
      )}
    </section>
  );
}
