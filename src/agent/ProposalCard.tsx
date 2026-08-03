import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { OrganizeProposal } from '@/agent/types';
import { humanize } from '@/detail/FieldEditor';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * A filing the agent suggests for a capture (M7).
 *
 * The agent never edits a capture directly — `propose_organize` puts this
 * card in front of the user instead. The point is that an agent's judgement
 * about how your notes should be shaped is a suggestion, and a suggestion you
 * cannot see and decline is just a silent write with extra steps.
 */
export function ProposalCard({ proposal }: { proposal: OrganizeProposal }) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const dismissProposal = useUiStore((s) => s.dismissProposal);
  const toast = useUiStore((s) => s.toast);

  const changes: [string, string][] = [];
  if (proposal.type !== undefined) changes.push(['Type', proposal.type]);
  if (proposal.title !== undefined) changes.push(['Title', proposal.title]);
  for (const [key, value] of Object.entries(proposal.properties ?? {})) {
    if (value === null || value === undefined) continue;
    changes.push([humanize(key), Array.isArray(value) ? value.join(', ') : String(value)]);
  }

  const accept = () => {
    const patch: Record<string, unknown> = { ...(proposal.properties ?? {}) };
    if (proposal.type !== undefined) patch.type = proposal.type;
    void (async () => {
      try {
        await patchFrontmatter(proposal.path, patch);
        dismissProposal(proposal.path);
      } catch (err) {
        toast(`Couldn't apply: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  };

  return (
    <div
      data-testid="proposal-card"
      className="mb-3 rounded-[10px] border border-synapse-200 bg-synapse-50 p-3"
    >
      <div className="flex items-center gap-1.5 pb-1.5">
        <Icon name="sparkles" size={12} color="var(--synapse-500)" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-synapse-600">
          Suggested filing
        </span>
      </div>
      <p className="m-0 mb-2 text-[12px] leading-[17px] text-n-700">{proposal.reasoning}</p>
      {changes.length > 0 && (
        <dl className="m-0 mb-2.5 grid grid-cols-[72px_1fr] gap-x-2 gap-y-1">
          {changes.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-[11px] text-n-500">{label}</dt>
              <dd className="m-0 min-w-0 truncate text-[11.5px] font-medium text-n-800">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" icon="check" onClick={accept}>
          Apply
        </Button>
        <Button variant="secondary" size="sm" onClick={() => dismissProposal(proposal.path)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
