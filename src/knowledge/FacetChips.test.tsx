// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { BeliefChips, FacetChips as Row } from '@/lib/ipc';
import { FacetChips, FacetLines } from './FacetChips';
import { chipsFor, indexChips, NO_CHIPS } from './useBeliefChips';

afterEach(cleanup);

function row(partial: Partial<Row> & { predicate: string | null; stage: string }): Row {
  return {
    key: {
      belief_id: 'b1',
      belief_revision_event_id: 'r1',
      predicate:
        partial.predicate === null
          ? { kind: 'unknown' }
          : { kind: 'known', value: partial.predicate },
      state_stage: partial.stage,
    },
    support: {
      level: 'single_source',
      ancestral_family_count: 1,
      independent_family_count: 1,
      independence_unknown_count: 1,
    },
    families: [],
    independence_edges: [],
    coverage: {
      kind: 'no_assessments',
      summary: 'blind',
      assessment_ids: [],
      fold_rule_version: 'coverage-fold-v1',
    },
    validity: { freshness: 'stale', conflict: 'contested', lifecycle: 'active' },
    freshness_basis: {
      predicate_class: 'ci_status',
      anchor_event_id: 'o1',
      anchor_at: '2026-08-01T00:00:00Z',
      stale_after: '2026-08-01T06:00:00Z',
    },
    review: { status: 'unreviewed' },
    support_text: 'single-source',
    coverage_text: 'coverage unassessed',
    validity_text: 'stale and contested',
    line: 'single-source, coverage unassessed, stale and contested',
    ...partial,
  };
}

function chips(facets: Row[]): BeliefChips {
  return {
    belief_id: 'b1',
    path: 'metrics/sync-error-rate.md',
    belief_revision_event_id: 'r1',
    facets,
  };
}

describe('FacetChips', () => {
  it('draws three chips and never combines them into one', () => {
    render(<FacetChips chips={chips([row({ predicate: 'ci_status', stage: 'implemented' })])} />);
    const axes = screen.getAllByTestId('axis-chip');
    expect(axes.map((c) => c.dataset.axis)).toEqual(['support', 'coverage', 'validity']);
    expect(axes.map((c) => c.dataset.value)).toEqual(['single_source', 'blind', 'stale']);
    // Every word came over the wire. Nothing here maps a value to a phrase.
    expect(axes.map((c) => c.textContent)).toEqual([
      'single-source',
      'coverage unassessed',
      'stale and contested',
    ]);
  });

  it('keeps the coverage tag so unassessed and blind stay distinguishable', () => {
    // A folded `blind` means somebody looked and found nothing connected;
    // `no_assessments` means nobody looked. Same summary, opposite sentences.
    render(<FacetChips chips={chips([row({ predicate: 'ci_status', stage: 'implemented' })])} />);
    const coverage = screen.getAllByTestId('axis-chip')[1];
    expect(coverage?.dataset.assessed).toBe('no_assessments');
    expect(coverage?.textContent).toBe('coverage unassessed');
  });

  it('renders a multi-facet belief as separate scoped rows', () => {
    // The rows disagree on purpose: a shipping BOM and a CI status go stale on
    // different clocks, and one merged row would be wrong about one of them.
    render(
      <FacetChips
        chips={chips([
          row({ predicate: 'bill_of_materials', stage: 'shipping' }),
          row({
            predicate: 'ci_status',
            stage: 'implemented',
            validity: { freshness: 'fresh', conflict: 'clear', lifecycle: 'active' },
            validity_text: 'fresh',
            line: 'single-source, coverage unassessed, fresh',
          }),
        ])}
      />,
    );
    const rows = screen.getAllByTestId('facet-chips');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dataset.facet)).toEqual([
      'bill_of_materials at shipping',
      'ci_status at implemented',
    ]);
    // The scope is named only when there is more than one — a single facet's
    // scope is the whole belief's, and saying it every time is noise.
    expect(rows[0]?.textContent).toContain('bill_of_materials at shipping');
  });

  it('says so out loud when a facet has no recorded predicate', () => {
    render(<FacetChips chips={chips([row({ predicate: null, stage: 'unknown' })])} />);
    expect(screen.getByTestId('facet-chips').dataset.facet).toBe('no recorded predicate');
  });

  it('renders nothing at all when nobody derived an answer', () => {
    // Not an empty row, not "unsupported": a vault with no ledger has not
    // said anything, and inventing a level would be the confident-and-wrong
    // kind of answer.
    const { container } = render(<FacetChips chips={null} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryAllByTestId('axis-chip')).toHaveLength(0);
  });

  it('gives list surfaces the same sentence as one line', () => {
    render(<FacetLines chips={chips([row({ predicate: 'ci_status', stage: 'implemented' })])} />);
    expect(screen.getByTestId('facet-line').textContent).toBe(
      'single-source, coverage unassessed, stale and contested',
    );
  });
});

describe('the chip index', () => {
  it('joins the knowledge-relative path the ledger records to the one a surface holds', () => {
    // The ledger says `metrics/sync-error-rate.md`; the scanner says
    // `knowledge/metrics/sync-error-rate.md`. Matching them at every call
    // site is how a surface silently matches nothing.
    const index = indexChips([chips([row({ predicate: 'ci_status', stage: 'implemented' })])]);
    expect(chipsFor(index, 'knowledge/metrics/sync-error-rate.md')?.belief_id).toBe('b1');
    expect(chipsFor(index, 'metrics/sync-error-rate.md')).toBeNull();
  });

  it('drops a belief no file projects rather than keying it on nothing', () => {
    const index = indexChips([{ ...chips([]), path: null }]);
    expect(index.kind === 'ready' && index.byPath.size).toBe(0);
  });

  it('answers null for every path while no ledger has spoken', () => {
    expect(chipsFor(NO_CHIPS, 'knowledge/anything.md')).toBeNull();
  });
});
