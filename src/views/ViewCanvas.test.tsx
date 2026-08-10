import { afterEach, describe, expect, it, vi } from 'vitest';
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
/**
 * jsdom cannot render mermaid, and the real editor drags in the whole render
 * chain. Neither whiteboard case below reaches it — both faces precede it —
 * but the stand-in is here so a future face change cannot hang this suite.
 */
vi.mock('@/mermaid/FullScreenDiagramEditor', () => ({
  FullScreenDiagramEditor: () => <div data-testid="fake-editor" />,
}));

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

/**
 * The tenth kind through the REAL switch (M29.49).
 *
 * `whiteboard` is the first kind whose arm depends on something other than the
 * records — it needs a host to know where its `.mmd` lives — so the switch can
 * route it two ways, and both are user-visible copy rather than a layout. The
 * arm is exhaustiveness-checked by the return type, but nothing proved which
 * face a caller gets, and a dashboard block reaching a whiteboard is exactly
 * the case with no page host.
 */
describe('ViewCanvas whiteboard faces (M29.49)', () => {
  /** No vault is opened in this suite, so creation cannot run either way. */
  function renderWhiteboard(host?: { folder: string; viewName: string }) {
    render(
      <ViewCanvas
        entries={[]}
        allEntries={[TYPE_DOC]}
        presentation={presentation('whiteboard')}
        schema={schema}
        fields={[]}
        scope="test:whiteboard"
        filtered={false}
        whiteboardHost={host}
      />,
    );
  }

  it('without a host — a dashboard block — it declines and says where to go', () => {
    renderWhiteboard();
    expect(screen.getByTestId('whiteboard-unavailable')).toBeTruthy();
    // The copy, not just the test id: the point of the face is the directions.
    expect(screen.getByText(/live on their list/i)).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-creating')).toBeNull();
  });

  it('with a host and no file yet it routes to the canvas, not a record layout', () => {
    renderWhiteboard({ folder: 'delivery', viewName: 'Map' });
    expect(screen.getByTestId('whiteboard-creating')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-unavailable')).toBeNull();
    // It must not fall through to a rows layout — the bug an unchecked switch
    // arm would produce is a whiteboard tab quietly drawing a table.
    expect(screen.queryByTestId('table-view')).toBeNull();
    expect(screen.queryByTestId('list-view')).toBeNull();
  });
});
