import type React from 'react';
import { RecordTabs } from '@/detail/RecordTabs';
import { agentRef } from '@/engine/agents';
import type { Entry, TabDef } from '@/engine/types';
import { AgentRunHistory } from '@/status/AgentRunHistory';
import { FollowupList } from '@/status/FollowupList';
import { WakesSection } from '@/status/WakesSection';
import { useVaultStore } from '@/stores/vaultStore';
import { AgentDossier } from './AgentDossier';
import { AgentMemoryTab } from './AgentMemoryTab';
import { AgentProperties } from './AgentProperties';

/**
 * An agent's page (M55.12): DocPage renders it, and this is what sits between
 * the title and the body. The duty bar and the properties show on every tab;
 * the tabs are the app's own — Instructions (the body, in the page editor),
 * Runs (what is waiting to wake it, then what it ran) and Memory — so the
 * strip is fixed.
 */
export const AGENT_TABS: TabDef[] = [
  { id: 'instructions', name: 'Instructions', icon: 'file-text', content: 'sections' },
  { id: 'runs', name: 'Runs', icon: 'history', content: 'sections' },
  { id: 'memory', name: 'Memory', icon: 'brain', content: 'sections' },
];

export type AgentTab = 'instructions' | 'runs' | 'memory';

/** The open tab off a selection's raw `tab`; anything else is Instructions. */
export function agentTabOf(raw: string | undefined): AgentTab {
  return raw === 'runs' || raw === 'memory' ? raw : 'instructions';
}

export function AgentPageBody({
  entry,
  tab,
  onTab,
  editor,
}: {
  entry: Entry;
  tab: AgentTab;
  onTab: (tab: AgentTab) => void;
  /** The page editor's block, shown on Instructions. */
  editor: React.ReactNode;
}) {
  const actor = agentRef(entry).actor;
  const vaultPath = useVaultStore((s) => s.vaultPath);
  // Everything below is keyed by the PATH: an editor open on one agent must
  // never survive into the next agent's page, where its Done would write the
  // first agent's draft over the second's grants.
  return (
    <>
      {/* M33.6 — a record with no identity to book runs under has no history
          to show, so it gets no duty bar. */}
      {actor !== 'process:' && (
        <div className="mb-3">
          <AgentDossier key={entry.path} entry={entry} />
        </div>
      )}
      <div data-testid="agent-properties" className="mb-4">
        <AgentProperties key={entry.path} entry={entry} />
      </div>
      <div className="-mx-6 mb-4">
        <RecordTabs tabs={AGENT_TABS} activeId={tab} onSelect={(id) => onTab(agentTabOf(id))} />
      </div>
      {tab === 'instructions' ? (
        editor
      ) : tab === 'runs' ? (
        <>
          {/* M63.1b: what is waiting to wake it, above what it ran. */}
          <div className="mb-4">
            <WakesSection vaultPath={vaultPath} actor={actor} />
          </div>
          <div className="mb-4">
            <FollowupList actor={actor} />
          </div>
          <AgentRunHistory
            actor={actor}
            scope={vaultPath === null ? null : { kind: 'agent', vault: vaultPath, actor }}
          />
        </>
      ) : (
        <AgentMemoryTab key={entry.path} entry={entry} />
      )}
    </>
  );
}
