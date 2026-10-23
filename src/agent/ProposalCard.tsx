import { useMemo, useState } from 'react';
import { FILING_COPY, filingAnswers, filingState } from '@/agent/elements/decisions';
import { Confirmation } from '@/components/ai/Confirmation';
import type { OrganizeProposal } from '@/agent/types';
import { humanize } from '@/detail/FieldEditor';
import { announceExternalWrites, flushOpenPages } from '@/editor/openPages';
import { filingPlan, type FilingPlan } from '@/engine/filing';
import type { Entry } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/** The capture as the plan reads it: the scanned entry, or a bare one when the
 * scan has not caught up with it (no type, no properties, nothing linked). */
function captureOf(entries: Entry[], path: string): Entry {
  const found = entries.find((e) => e.path === path);
  if (found !== undefined) return found;
  const slash = path.lastIndexOf('/');
  return {
    path,
    filename: path.slice(slash + 1),
    folder: slash === -1 ? '' : path.slice(0, slash),
    project: null,
    title: '',
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '',
    modifiedAt: '',
    parseError: null,
    hash: null,
  };
}

type Row = [label: string, value: string];

/** The card's rows, from the plan: what Apply writes, as a person reads it.
 * `head` is Type and Title; `rest` is each link field, then the others. */
function rowsOf(plan: FilingPlan): { head: Row[]; rest: Row[] } {
  const head: Row[] = [];
  if (plan.type !== null) head.push(['Type', plan.type]);
  if (plan.title !== '') head.push(['Title', plan.title]);
  const rows: Row[] = [];
  const linked = new Set(plan.links.map((l) => l.field));
  for (const link of plan.links) {
    rows.push([humanize(link.field), link.pages.map((p) => p.title).join(', ')]);
  }
  for (const [key, value] of Object.entries(plan.patch)) {
    if (key === 'type' || linked.has(key)) continue;
    if (plan.transcript !== null && key === 'summary') continue;
    rows.push([humanize(key), Array.isArray(value) ? value.join(', ') : String(value)]);
  }
  return { head, rest: rows };
}

function Rows({ rows }: { rows: Row[] }) {
  return rows.map(([label, value]) => (
    <div key={label} className="contents">
      <dt className="text-metadata text-(--text-meta)">{label}</dt>
      <dd className="m-0 min-w-0 truncate text-xs font-medium text-n-800">{value}</dd>
    </div>
  ));
}

const UNFILED_WORDS = {
  'no page': 'no page',
  'not allowed here': 'not allowed here',
  'over the limit': 'over the limit',
} as const;

/** What the card says about a transcript's matched speakers, or null. */
function speakersNote(plan: FilingPlan): string | null {
  const t = plan.transcript;
  if (t === null) return null;
  if (t.why === 'no person field') {
    return 'Matched speakers are not added: this filing fills no person field.';
  }
  if (t.why === 'several person fields') {
    return 'Matched speakers are not added: this filing fills several person fields.';
  }
  if (t.field !== null && t.joined.length > 0) {
    const names = t.joined.map((p) => p.title).join(', ');
    return `Adds ${t.joined.length} matched ${t.joined.length === 1 ? 'speaker' : 'speakers'} to ${humanize(t.field)}: ${names}.`;
  }
  return null;
}

/**
 * A filing the agent suggests for a capture (M7), drawn as a Confirmation
 * (M91.14): what Apply would write, and the two answers.
 *
 * The agent never edits a capture directly — `propose_organize` puts this
 * card in front of the user instead. The point is that an agent's judgement
 * about how your notes should be shaped is a suggestion, and a suggestion you
 * cannot see and decline is just a silent write with extra steps. What the
 * agent wrote — its reasoning, the title, a summary — shows as text, never
 * markup.
 */
export function ProposalCard({ proposal }: { proposal: OrganizeProposal }) {
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const setTitle = useVaultStore((s) => s.setTitle);
  const rescan = useVaultStore((s) => s.rescan);
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const dismissProposal = useUiStore((s) => s.dismissProposal);
  const [applying, setApplying] = useState(false);

  // What Apply writes (M64.7): only links that reach a page their field
  // allows, the title on one line, and a transcript's summary and matched
  // speakers. Blank titles propose nothing, so they are not listed.
  const plan = useMemo(
    () => filingPlan(proposal, captureOf(entries, proposal.path), schema, entries),
    [proposal, entries, schema],
  );
  const { title } = plan;
  const { head, rest } = rowsOf(plan);
  const note = speakersNote(plan);

  /**
   * Writes the planned filing: the frontmatter the plan kept, then the title
   * as the H1 (M53.18). Proposed links that name no page, or a page their
   * field does not allow, are listed on the card and never written (M64.7).
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
    const { patch } = plan;
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

  const answers = filingAnswers({
    onApply: () => void accept(),
    onDismiss: () => dismissProposal(proposal.path),
  });

  return (
    <Confirmation
      data-testid="proposal-card"
      state={filingState(applying)}
      icon="sparkles"
      title={FILING_COPY.title}
      approve={answers.approve}
      deny={answers.deny}
    >
      <p className="m-0 text-xs leading-[17px] text-n-700">{proposal.reasoning}</p>
      {(head.length > 0 || rest.length > 0 || plan.transcript !== null) && (
        <dl className="m-0 grid grid-cols-[72px_1fr] gap-x-2 gap-y-1">
          <Rows rows={head} />
          {plan.transcript !== null && (
            <div className="contents">
              <dt className="text-metadata text-(--text-meta)">Summary</dt>
              <dd
                data-testid="proposal-summary"
                className={
                  plan.transcript.summary === null
                    ? 'm-0 min-w-0 text-xs italic text-(--text-meta)'
                    : 'm-0 min-w-0 whitespace-pre-wrap text-xs text-n-800'
                }
              >
                {plan.transcript.summary ?? 'Nothing to summarize'}
              </dd>
            </div>
          )}
          <Rows rows={rest} />
        </dl>
      )}
      {note !== null && (
        <p data-testid="proposal-speakers-note" className="m-0 text-metadata text-n-600">
          {note}
        </p>
      )}
      {plan.unfiled.length > 0 && (
        <div data-testid="proposal-unfiled">
          <div className="text-metadata font-semibold text-n-600">Not filed</div>
          <ul className="m-0 list-none p-0">
            {plan.unfiled.map((u) => (
              <li
                key={`${u.field}:${u.target}:${u.why}`}
                className="text-metadata text-n-600"
                data-why={u.why}
              >
                {u.target} in {humanize(u.field)}: {UNFILED_WORDS[u.why]}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Confirmation>
  );
}
