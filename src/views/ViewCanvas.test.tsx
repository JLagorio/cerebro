import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ViewCanvas } from '@/views/ViewCanvas';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import type { Entry, Presentation, ViewType } from '@/engine/types';

/**
 * The canvas forwards `filtered` to every layout that has an empty state
 * (M16.35).
 *
 * This is a regression test for a whole BUG CLASS, not for one arm. `filtered`
 * was optional on every per-kind view, and the `board` arm of the switch simply
 * did not pass it — so BoardView's filtered branch, which exists precisely so a
 * filtered board does not claim the collection is empty, was unreachable code
 * for the life of the prop. Table, list, gallery and chart all forwarded it;
 * board was the lone omission and nothing failed.
 *
 * The prop is required on the per-kind props now, so the compiler catches the
 * next omission before this test would. These cases are the second line: they
 * prove the wiring reaches the copy a user actually reads.
 */
const TYPE_DOC = makeEntry({
  path: 'types/campaign.md',
  title: 'Campaign',
  type: 'Type',
  properties: {
    icon: 'megaphone',
    fields: { window: { kind: 'daterange' } },
  } as unknown as Entry['properties'],
});

const schema = buildSchema([TYPE_DOC]);

function presentation(type: ViewType): Presentation {
  return { type, group: [{ field: 'status' }], sort: [], columns: [], dateField: 'window' };
}

/** An empty canvas of `type`, told whether the emptiness is the filter's doing. */
function renderEmpty(type: ViewType, filtered: boolean) {
  render(
    <ViewCanvas
      entries={[]}
      allEntries={[TYPE_DOC]}
      presentation={presentation(type)}
      schema={schema}
      fields={[]}
      scope={`test:${type}`}
      filtered={filtered}
      today="2026-08-12"
    />,
  );
}

afterEach(cleanup);

describe('ViewCanvas empty states say WHY they are empty (M16.35)', () => {
  it('tells a filtered board the filters matched nothing', () => {
    renderEmpty('board', true);
    expect(screen.getByText('Nothing matches these filters')).toBeTruthy();
    expect(screen.queryByText('No items yet')).toBeNull();
  });

  it('still tells an unfiltered board the collection is empty', () => {
    renderEmpty('board', false);
    expect(screen.getByText('No items yet')).toBeTruthy();
    expect(screen.queryByText('Nothing matches these filters')).toBeNull();
  });

  it('tells a filtered gantt the filters matched nothing', () => {
    renderEmpty('gantt', true);
    expect(screen.getByText('Nothing matches these filters')).toBeTruthy();
    expect(screen.queryByText('No records yet')).toBeNull();
  });

  it('still tells an unfiltered gantt there is nothing scheduled', () => {
    renderEmpty('gantt', false);
    expect(screen.getByText('No records yet')).toBeTruthy();
  });

  it('tells a filtered timeline the filters matched nothing', () => {
    renderEmpty('timeline', true);
    expect(screen.getByText('Nothing matches these filters')).toBeTruthy();
    expect(screen.queryByText('No records yet')).toBeNull();
  });

  it('still tells an unfiltered timeline there is nothing scheduled', () => {
    renderEmpty('timeline', false);
    expect(screen.getByText('No records yet')).toBeTruthy();
  });

  // The layouts that already forwarded it, so a future edit to the switch
  // cannot quietly drop one of those either.
  it.each<[ViewType, string]>([
    ['table', 'Nothing matches these filters'],
    ['list', 'Nothing matches these filters'],
    ['gallery', 'Nothing matches these filters'],
  ])('tells a filtered %s the filters matched nothing', (type, copy) => {
    renderEmpty(type, true);
    expect(screen.getByText(copy)).toBeTruthy();
  });
});
