import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { agentRef } from '@/engine/agents';
import { agentDraft, agentPatch } from '@/engine/libraryDraft';
import type { Entry } from '@/engine/types';
import { useConcepts } from '@/knowledge/useConcepts';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

const LABEL = 'mb-1 text-2xs font-semibold uppercase tracking-[0.06em] text-n-500';

/**
 * An agent page's Memory tab (M55.12): what survives between runs, in three
 * tiers. Two are fields on the record; the third — what the agent inferred —
 * is Knowledge, which already stores inferences with provenance and already
 * requires your stamp to become verified.
 */
export function AgentMemoryTab({ entry }: { entry: Entry }) {
  const draft = agentDraft(entry, '');
  const ref = agentRef(entry);
  return (
    <div data-testid="agent-memory" className="flex flex-col gap-6">
      <Corrections entry={entry} saved={draft.preferences} />
      <section>
        <div className={LABEL}>The agent&rsquo;s own notes</div>
        <p className="m-0 mb-1.5 text-xs leading-[17px] text-n-500">
          What the agent keeps between runs. Read-only here: saving over it would erase what a run
          learned.
        </p>
        <p
          data-testid="agent-recent"
          className="m-0 whitespace-pre-wrap rounded-md border border-dashed border-n-200 bg-n-25 p-2.5 font-mono text-2xs leading-[17px] text-n-500"
        >
          {draft.recent === '' ? 'Nothing kept yet.' : draft.recent}
        </p>
      </section>
      <AgentKnowledge actor={ref.actor} maintains={ref.capabilities.includes('knowledge')} />
    </div>
  );
}

/**
 * Your corrections: human-only, durable, and higher priority than anything
 * the agent concluded on its own. Prose, so it commits on blur like any page
 * text; emptied, the key goes. Re-seeded from the record only while it is not
 * focused, so a rescan never eats what you are typing.
 */
function Corrections({ entry, saved }: { entry: Entry; saved: string }) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const [text, setText] = useState(saved);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(saved);
  }, [saved]);

  return (
    <section>
      <label htmlFor="agent-preferences" className={`${LABEL} block`}>
        Your corrections
      </label>
      <p className="m-0 mb-1.5 text-xs leading-[17px] text-n-500">
        Durable, and higher priority than anything the agent concluded on its own. A run that tries
        to write this key is refused — an agent that can edit the corrections made to it does not
        have preferences, it has notes.
      </p>
      <textarea
        id="agent-preferences"
        data-testid="agent-preferences"
        rows={4}
        value={text}
        placeholder="Never file a risk without an owner."
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          focused.current = false;
          if (text.trim() === saved.trim()) return;
          void patchFrontmatter(
            entry.path,
            agentPatch({ ...agentDraft(entry, ''), preferences: text }, ['preferences']),
          );
        }}
        className="w-full resize-y rounded-md border border-n-200 bg-n-0 p-3 font-mono text-xs leading-[19px] text-n-800 outline-none placeholder:text-n-400 focus-visible:border-cortex-400"
      />
    </section>
  );
}

/**
 * What this agent has put into Knowledge (M50.3): the concepts stamped with
 * its actor — found by the stamp, never by a title — and, for the agent that
 * maintains Knowledge, the whole of it. The agent's page used to know its
 * grants and runs and nothing of what they produced, while every concept it
 * wrote named it.
 */
function AgentKnowledge({ actor, maintains }: { actor: string; maintains: boolean }) {
  const navigate = useNavStore((s) => s.navigate);
  const concepts = useConcepts();
  const wrote = concepts.filter((c) => c.generated?.by.raw === actor);
  return (
    <section data-testid="agent-knowledge">
      <div className={LABEL}>What it inferred</div>
      {maintains && (
        <button
          type="button"
          data-testid="agent-maintains"
          onClick={() => navigate({ kind: 'knowledge', nav: { tab: 'all' } })}
          className="mb-1 inline-flex items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1 text-sm text-n-700 hover:bg-n-50"
        >
          <Icon name="brain" size={14} color="var(--synapse-500)" />
          Maintains Knowledge · {concepts.length} concept{concepts.length === 1 ? '' : 's'}
        </button>
      )}
      {wrote.length === 0 ? (
        <p className="m-0 px-2 text-sm text-n-500">It has not written a concept yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-px p-0">
          {wrote.map((c) => (
            <li key={c.entry.path}>
              <button
                type="button"
                data-testid="agent-wrote"
                data-path={c.entry.path}
                onClick={() => navigate({ kind: 'doc', path: c.entry.path })}
                className="flex w-full min-w-0 items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1 text-left text-sm hover:bg-n-50"
              >
                <Icon name="lightbulb" size={13} color="var(--n-400)" />
                <span className="min-w-0 flex-1 truncate text-n-800">{c.title}</span>
                <span className="flex-none text-xs text-n-500">{c.conceptType}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
