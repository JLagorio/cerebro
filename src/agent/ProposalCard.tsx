import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { OrganizeProposal } from '@/agent/types';
import { humanize } from '@/detail/FieldEditor';
import { announceExternalWrites, flushOpenPages } from '@/editor/openPages';
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
  const setTitle = useVaultStore((s) => s.setTitle);
  const rescan = useVaultStore((s) => s.rescan);
  const dismissProposal = useUiStore((s) => s.dismissProposal);
  const [applying, setApplying] = useState(false);

  // The H1 this filing proposes, on one line as the row below shows it: a
  // newline in the agent's title would write body lines the card never
  // displayed. Blank proposes nothing, so it is not listed. `typeof`, since
  // the title is the agent's JSON and a number would throw mid-render.
  const title =
    typeof proposal.title === 'string' ? proposal.title.replace(/\s+/g, ' ').trim() : '';

  const changes: [string, string][] = [];
  if (proposal.type !== undefined) changes.push(['Type', proposal.type]);
  if (title !== '') changes.push(['Title', title]);
  for (const [key, value] of Object.entries(proposal.properties ?? {})) {
    if (value === null || value === undefined) continue;
    changes.push([humanize(key), Array.isArray(value) ? value.join(', ') : String(value)]);
  }

  /**
   * Writes the whole filing: the frontmatter, then the title as the H1 (M53.18).
   * Each store write answers whether it landed and toasts its own failure, so
   * the card adds no message: a write that did not land stops here and leaves
   * the card up to retry.
   *
   * The capture is open in the editor beside this card (InboxPage), and the H1
   * is in the body that editor saves. So the open pages' pending saves land
   * first, and the writes are announced once they have landed, the way the
   * agent's are (`openPages.ts`). Announced after, never wrapped: the
   * catch-up joins the store's queued rescan, so it is only ever that rescan,
   * never the write itself.
   */
  const write = async (): Promise<boolean> => {
    // A save still on its debounce would otherwise land after the H1 below
    // and write the old one back.
    await flushOpenPages();
    const patch: Record<string, unknown> = { ...(proposal.properties ?? {}) };
    if (proposal.type !== undefined) patch.type = proposal.type;
    // A title-only proposal has no frontmatter to write.
    const patched = Object.keys(patch).length > 0;
    if (patched && !(await patchFrontmatter(proposal.path, patch))) return false;
    // setTitle answers false for a blank or unchanged title as well as a
    // failed one, so only a real rename goes to it, compared against the
    // entry exactly as setTitle is about to read it.
    const current = useVaultStore.getState().entries.find((e) => e.path === proposal.path);
    const renamed = title !== '' && title !== current?.title;
    if (renamed && !(await setTitle(proposal.path, title))) return false;
    if (patched || renamed) {
      // A rename changed the body, so the page showing the capture hears it
      // by path and takes the new H1 in place (M55.6). Frontmatter alone
      // names no page, as the agent's update_frontmatter names none (a page's
      // save keeps it from disk), but still catches the vault up: an
      // optimistic `type` patch lands in properties and leaves `entry.type`
      // stale until a scan reads it.
      void announceExternalWrites(renamed ? [proposal.path] : [], rescan);
    }
    return true;
  };

  const accept = async () => {
    if (applying) return;
    setApplying(true);
    try {
      if (await write()) dismissProposal(proposal.path);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      data-testid="proposal-card"
      className="mb-3 rounded-lg border border-synapse-200 bg-synapse-50 p-3"
    >
      <div className="flex items-center gap-1.5 pb-1.5">
        <Icon name="sparkles" size={12} color="var(--synapse-500)" />
        <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-synapse-600">
          Suggested filing
        </span>
      </div>
      <p className="m-0 mb-2 text-xs leading-[17px] text-n-700">{proposal.reasoning}</p>
      {changes.length > 0 && (
        <dl className="m-0 mb-2.5 grid grid-cols-[72px_1fr] gap-x-2 gap-y-1">
          {changes.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-2xs text-n-500">{label}</dt>
              <dd className="m-0 min-w-0 truncate text-xs font-medium text-n-800">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          icon="check"
          disabled={applying}
          onClick={() => void accept()}
        >
          Apply
        </Button>
        <Button variant="secondary" size="sm" onClick={() => dismissProposal(proposal.path)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
